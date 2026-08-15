import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStateStore } from '../src/bookkeeping.js'
import { resolveConfig } from '../src/config.js'
import { MemoryFiles } from '../src/files.js'
import { Phase2Runner } from '../src/phase2.js'
import { fakeKv, fakeLlm, PHASE2_BLOCKS } from './helpers.js'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

interface Harness {
  runner: Phase2Runner
  state: MemoryStateStore
  files: MemoryFiles
  clock: { value: number }
}

async function harness(responses: Array<string | Error>, cooldownMs = 6 * 60 * 60_000): Promise<Harness> {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-phase2-'))
  const { facility } = fakeKv()
  const state = new MemoryStateStore(() => facility)
  await state.init()
  const files = new MemoryFiles(root)
  await files.ensureLayout()
  const { llm } = fakeLlm(responses)
  const cfg = resolveConfig({ provider: 'mock', model: 'mock', consolidationCooldownMs: cooldownMs })
  const clock = { value: Date.now() }
  const runner = new Phase2Runner({
    llm,
    state,
    files,
    config: () => cfg,
    route: () => ({ provider: 'mock', model: 'mock' }),
    now: () => clock.value,
  })
  return { runner, state, files, clock }
}

describe('Phase2Runner', () => {
  it('creates both files in INIT mode and rotates raw memories', async () => {
    const h = await harness([PHASE2_BLOCKS('# Memory\n\n## User preferences\n\n- 用户偏好中文回答', 'v1\n- 记忆主题：中文回答偏好')])
    await h.files.appendText('raw_memories.md', '<!-- dsh-memory raw -->\nraw block\n')
    h.state.setPendingConsolidation(true)

    const outcome = await h.runner.run(false)
    expect(outcome).toEqual({ kind: 'consolidated', mode: 'init' })

    const memory = await h.files.readIfExists('MEMORY.md')
    expect(memory).toContain('# Memory')
    expect(memory).toContain('用户偏好中文回答')
    const summary = await h.files.readIfExists('memory_summary.md')
    expect(summary?.startsWith('v1\n')).toBe(true)

    const raw = await h.files.readIfExists('raw_memories.md')
    expect(raw).toContain('archived at')
    expect(raw).not.toContain('raw block')
    const archive = await h.files.readIfExists('raw_memories.archive.md')
    expect(archive).toContain('raw block')

    expect(h.state.pendingConsolidation).toBe(false)
    expect(h.state.lastPhase2At).toBeGreaterThan(0)
    expect(h.state.phase2Error).toBeUndefined()
  })

  it('enforces the v1 first line when the model omits it', async () => {
    const h = await harness([PHASE2_BLOCKS('# Memory', '没有 v1 的摘要内容')])
    await h.files.appendText('raw_memories.md', 'raw\n')
    h.state.setPendingConsolidation(true)

    const outcome = await h.runner.run(false)
    expect(outcome.kind).toBe('consolidated')
    const summary = await h.files.readIfExists('memory_summary.md')
    expect(summary?.startsWith('v1\n')).toBe(true)
  })

  it('merges in INCREMENTAL mode when files already exist', async () => {
    const h = await harness([PHASE2_BLOCKS('# Memory\n\n- old entry\n- merged entry', 'v1\n- topic one\n- topic two')])
    await h.files.writeAtomic('MEMORY.md', '# Memory\n\n- old entry\n')
    await h.files.writeAtomic('memory_summary.md', 'v1\n- topic one\n')
    await h.files.appendText('raw_memories.md', 'new raw\n')
    h.state.setPendingConsolidation(true)

    const outcome = await h.runner.run(false)
    expect(outcome).toEqual({ kind: 'consolidated', mode: 'incremental' })
    const memory = await h.files.readIfExists('MEMORY.md')
    expect(memory).toContain('merged entry')
  })

  it('honors the cooldown and skips with no pending input', async () => {
    const h = await harness([])
    expect(await h.runner.run(false)).toEqual({ kind: 'skipped', reason: 'no-input' })

    await h.files.appendText('raw_memories.md', 'raw\n')
    h.state.setPendingConsolidation(true)
    h.state.recordPhase2(Date.now())
    expect(await h.runner.run(false)).toEqual({ kind: 'skipped', reason: 'cooldown' })
    // pending flag survives a cooldown skip
    expect(h.state.pendingConsolidation).toBe(true)
  })

  it('bypasses the cooldown on forced runs', async () => {
    const h = await harness([PHASE2_BLOCKS('# Memory', 'v1\n- x')])
    await h.files.appendText('raw_memories.md', 'raw\n')
    h.state.setPendingConsolidation(true)
    h.state.recordPhase2(Date.now())
    const outcome = await h.runner.run(true)
    expect(outcome.kind).toBe('consolidated')
  })

  it('clears the pending flag when raw input drained without force', async () => {
    const h = await harness([])
    h.state.setPendingConsolidation(true)
    expect(await h.runner.run(false)).toEqual({ kind: 'skipped', reason: 'no-input' })
    expect(h.state.pendingConsolidation).toBe(false)
  })

  it('records the error and keeps the pending flag on malformed output', async () => {
    const h = await harness(['没有代码块的自由文本'])
    await h.files.appendText('raw_memories.md', 'raw\n')
    h.state.setPendingConsolidation(true)

    const outcome = await h.runner.run(false)
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') expect(outcome.error).toContain('代码块')
    expect(h.state.pendingConsolidation).toBe(true)
    expect(h.state.phase2Error).toContain('代码块')
    // raw memories are preserved for the retry
    expect((await h.files.readIfExists('raw_memories.md'))).toContain('raw')
  })

  it('rejects output missing the summary block', async () => {
    const h = await harness(['```MEMORY.md\n# Memory\n```'])
    await h.files.appendText('raw_memories.md', 'raw\n')
    h.state.setPendingConsolidation(true)
    const outcome = await h.runner.run(false)
    expect(outcome.kind).toBe('error')
    expect(h.state.pendingConsolidation).toBe(true)
  })

  it('retries automatically about 15 minutes after a failure instead of waiting the full cooldown', async () => {
    const h = await harness(['没有代码块的自由文本', PHASE2_BLOCKS('# Memory', 'v1\n- x')])
    await h.files.appendText('raw_memories.md', 'raw\n')
    h.state.setPendingConsolidation(true)

    const failed = await h.runner.run(false)
    expect(failed.kind).toBe('error')
    expect(h.state.pendingConsolidation).toBe(true)
    // The failure schedules the next automatic attempt ~15 minutes out.
    const retryIn = h.state.lastPhase2At + 6 * 60 * 60_000 - h.clock.value
    expect(retryIn).toBeGreaterThan(14 * 60_000)
    expect(retryIn).toBeLessThanOrEqual(15 * 60_000)

    // Still inside the retry window: skipped.
    h.clock.value += 10 * 60_000
    expect(await h.runner.run(false)).toEqual({ kind: 'skipped', reason: 'cooldown' })

    // Past the retry window: runs again and succeeds.
    h.clock.value += 6 * 60_000
    const retried = await h.runner.run(false)
    expect(retried.kind).toBe('consolidated')
    expect(h.state.pendingConsolidation).toBe(false)
  })
})
