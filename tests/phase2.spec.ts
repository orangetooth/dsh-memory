import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStateStore } from '../src/bookkeeping.js'
import type {
  ConsolidationArtifacts,
  ConsolidationRequest,
  ConsolidatorReadiness,
  Phase2Consolidator,
} from '../src/consolidation-agent.js'
import { resolveConfig } from '../src/config.js'
import { MemoryFiles } from '../src/files.js'
import { Phase2Runner } from '../src/phase2.js'
import { fakeKv } from './helpers.js'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

type FakeResponse = ConsolidationArtifacts | Error

function artifacts(memoryMd: string, memorySummaryMd: string): ConsolidationArtifacts {
  return { memoryMd, memorySummaryMd }
}

function fakeConsolidator(
  responses: FakeResponse[],
  readiness: ConsolidatorReadiness = 'ready',
): { consolidator: Phase2Consolidator; calls: ConsolidationRequest[] } {
  const calls: ConsolidationRequest[] = []
  return {
    calls,
    consolidator: {
      readiness: () => readiness,
      async consolidate(request) {
        calls.push(request)
        const response = responses.shift()
        if (response instanceof Error) throw response
        if (response === undefined) throw new Error('fake consolidator has no response')
        return response
      },
    },
  }
}

interface Harness {
  runner: Phase2Runner
  state: MemoryStateStore
  files: MemoryFiles
  clock: { value: number }
  calls: ConsolidationRequest[]
}

async function harness(
  responses: FakeResponse[],
  cooldownMs = 6 * 60 * 60_000,
  readiness: ConsolidatorReadiness = 'ready',
): Promise<Harness> {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-phase2-'))
  const { facility } = fakeKv()
  const state = new MemoryStateStore(() => facility)
  await state.init()
  const files = new MemoryFiles(root)
  await files.ensureLayout()
  const fake = fakeConsolidator(responses, readiness)
  const cfg = resolveConfig({ provider: 'mock', model: 'mock', consolidationCooldownMs: cooldownMs })
  const clock = { value: Date.now() }
  const runner = new Phase2Runner({
    consolidator: fake.consolidator,
    state,
    files,
    config: () => cfg,
    route: () => ({ provider: 'mock', model: 'mock' }),
    now: () => clock.value,
  })
  return { runner, state, files, clock, calls: fake.calls }
}

describe('Phase2Runner', () => {
  it('creates both files in INIT mode and rotates raw memories', async () => {
    const h = await harness([artifacts(
      '# Memory\n\n## User preferences\n\n- 用户偏好中文回答',
      'v1\n- 记忆主题：中文回答偏好',
    )])
    await h.files.appendText('raw_memories.md', '<!-- dsh-memory raw -->\nraw block\n')
    h.state.setPendingConsolidation(true)

    const outcome = await h.runner.run(false)
    expect(outcome).toEqual({ kind: 'consolidated', mode: 'init' })
    expect(await h.files.readIfExists('MEMORY.md')).toContain('用户偏好中文回答')
    expect((await h.files.readIfExists('memory_summary.md'))?.startsWith('v1\n')).toBe(true)
    expect(await h.files.readIfExists('raw_memories.md')).not.toContain('raw block')
    expect(await h.files.readIfExists('raw_memories.archive.md')).toContain('raw block')
    expect(h.state.pendingConsolidation).toBe(false)
    expect(h.state.lastPhase2At).toBeGreaterThan(0)
    expect(h.state.phase2Error).toBeUndefined()
  })

  it('enforces the v1 first line when the agent omits it', async () => {
    const h = await harness([artifacts('# Memory', '没有 v1 的摘要内容')])
    await h.files.appendText('raw_memories.md', 'raw\n')
    h.state.setPendingConsolidation(true)

    expect((await h.runner.run(false)).kind).toBe('consolidated')
    expect((await h.files.readIfExists('memory_summary.md'))?.startsWith('v1\n')).toBe(true)
  })

  it('passes only workspace metadata to the consolidation agent', async () => {
    const h = await harness([artifacts('# Memory\n\n- merged', 'v1\n- merged')])
    await h.files.appendText('raw_memories.md', 'private raw evidence that must be read through tools\n')
    await h.files.writeAtomic('rollout_summaries/example.md', '# example evidence\n')
    await h.files.writeAtomic('extensions/ad_hoc/notes/note.md', 'private user note\n')
    h.state.setPendingConsolidation(true)

    expect((await h.runner.run(false)).kind).toBe('consolidated')
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]).toMatchObject({
      mode: 'init',
      memoryRoot: h.files.root,
      pendingNotes: 1,
      rolloutSummaries: 1,
      route: { provider: 'mock', model: 'mock' },
    })
    expect(JSON.stringify(h.calls[0])).not.toContain('private raw evidence')
    expect(JSON.stringify(h.calls[0])).not.toContain('private user note')
  })

  it('merges in INCREMENTAL mode when files already exist', async () => {
    const h = await harness([artifacts('# Memory\n\n- old entry\n- merged entry', 'v1\n- topic one\n- topic two')])
    await h.files.writeAtomic('MEMORY.md', '# Memory\n\n- old entry\n')
    await h.files.writeAtomic('memory_summary.md', 'v1\n- topic one\n')
    await h.files.appendText('raw_memories.md', 'new raw\n')
    h.state.setPendingConsolidation(true)

    expect(await h.runner.run(false)).toEqual({ kind: 'consolidated', mode: 'incremental' })
    expect(h.calls[0]?.mode).toBe('incremental')
    expect(await h.files.readIfExists('MEMORY.md')).toContain('merged entry')
  })

  it('archives ad hoc notes only after successful consolidation', async () => {
    const h = await harness([artifacts('# Memory\n\n- note merged', 'v1\n- note merged')])
    await h.files.writeAtomic('extensions/ad_hoc/notes/note-1.md', '<!-- ad-hoc note -->\n用户自述：交流必须使用中文。\n')

    expect((await h.runner.run(false)).kind).toBe('consolidated')
    expect(h.calls[0]?.pendingNotes).toBe(1)
    expect(await h.files.readIfExists('extensions/ad_hoc/notes/note-1.md')).toBeUndefined()
    expect(await h.files.readIfExists('extensions/ad_hoc/archive/note-1.md')).toContain('用户自述')
  })

  it('honors the cooldown and skips with no pending input', async () => {
    const h = await harness([])
    expect(await h.runner.run(false)).toEqual({ kind: 'skipped', reason: 'no-input' })

    await h.files.appendText('raw_memories.md', 'raw\n')
    h.state.setPendingConsolidation(true)
    h.state.recordPhase2(Date.now())
    expect(await h.runner.run(false)).toEqual({ kind: 'skipped', reason: 'cooldown' })
    expect(h.state.pendingConsolidation).toBe(true)
  })

  it('keeps pending input when no root agent is available', async () => {
    const h = await harness([], 6 * 60 * 60_000, 'no-agent')
    await h.files.appendText('raw_memories.md', 'raw\n')
    h.state.setPendingConsolidation(true)

    expect(await h.runner.run(false)).toEqual({ kind: 'skipped', reason: 'no-agent' })
    expect(h.state.pendingConsolidation).toBe(true)
    expect(h.state.lastPhase2At).toBe(0)
  })

  it('bypasses the cooldown on forced runs', async () => {
    const h = await harness([artifacts('# Memory', 'v1\n- x')])
    await h.files.appendText('raw_memories.md', 'raw\n')
    h.state.setPendingConsolidation(true)
    h.state.recordPhase2(Date.now())
    expect((await h.runner.run(true)).kind).toBe('consolidated')
  })

  it('clears the pending flag when raw input drained without force', async () => {
    const h = await harness([])
    h.state.setPendingConsolidation(true)
    expect(await h.runner.run(false)).toEqual({ kind: 'skipped', reason: 'no-input' })
    expect(h.state.pendingConsolidation).toBe(false)
  })

  it('records an agent error, keeps pending input, and preserves raw memories', async () => {
    const h = await harness([new Error('整合 agent 的结构化输出缺少 memory_summary_md')])
    await h.files.appendText('raw_memories.md', 'raw\n')
    h.state.setPendingConsolidation(true)

    const outcome = await h.runner.run(false)
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') expect(outcome.error).toContain('memory_summary_md')
    expect(h.state.pendingConsolidation).toBe(true)
    expect(h.state.phase2Error).toContain('memory_summary_md')
    expect(await h.files.readIfExists('raw_memories.md')).toContain('raw')
  })

  it('retries automatically about 15 minutes after a failure instead of waiting the full cooldown', async () => {
    const h = await harness([new Error('agent failed'), artifacts('# Memory', 'v1\n- x')])
    await h.files.appendText('raw_memories.md', 'raw\n')
    h.state.setPendingConsolidation(true)

    expect((await h.runner.run(false)).kind).toBe('error')
    const retryIn = h.state.lastPhase2At + 6 * 60 * 60_000 - h.clock.value
    expect(retryIn).toBeGreaterThan(14 * 60_000)
    expect(retryIn).toBeLessThanOrEqual(15 * 60_000)

    h.clock.value += 10 * 60_000
    expect(await h.runner.run(false)).toEqual({ kind: 'skipped', reason: 'cooldown' })

    h.clock.value += 6 * 60_000
    expect((await h.runner.run(false)).kind).toBe('consolidated')
    expect(h.state.pendingConsolidation).toBe(false)
  })
})
