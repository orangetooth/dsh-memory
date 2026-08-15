import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStateStore } from '../src/bookkeeping.js'
import { resolveConfig } from '../src/config.js'
import { MemoryFiles } from '../src/files.js'
import { Phase1Runner } from '../src/phase1.js'
import type { SessionHeaderLite, SessionReader } from '../src/types.js'
import { fakeKv, fakeLlm, PHASE1_JSON, userMessage, type FakeResponse } from './helpers.js'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

interface Harness {
  runner: Phase1Runner
  state: MemoryStateStore
  files: MemoryFiles
  headers: SessionHeaderLite[]
  setEvents: (id: string, events: unknown[]) => void
  clock: { value: number }
}

async function harness(responses: Array<FakeResponse>): Promise<Harness> {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-phase1-'))
  const { facility } = fakeKv()
  const state = new MemoryStateStore(() => facility)
  await state.init()
  const files = new MemoryFiles(root)
  const { llm } = fakeLlm(responses)
  const events = new Map<string, unknown[]>()
  const headers: SessionHeaderLite[] = []
  const reader: SessionReader = {
    async listSessions() {
      return headers
    },
    async readSession(id) {
      return { session: { id }, events: events.get(id) ?? [] }
    },
  }
  const cfg = resolveConfig({ provider: 'mock', model: 'mock' })
  const clock = { value: Date.now() }
  const runner = new Phase1Runner({
    llm,
    state,
    files,
    sessions: () => reader,
    config: () => cfg,
    route: () => ({ provider: 'mock', model: 'mock' }),
    now: () => clock.value,
  })
  return {
    runner,
    state,
    files,
    headers,
    setEvents: (id, list) => events.set(id, list),
    clock,
  }
}

const activeHeader = (id: string, createdAt = Date.now()): SessionHeaderLite =>
  ({ id, createdAt, cwd: '/work/repo' })

describe('Phase1Runner', () => {
  it('extracts a session into a rollout summary and raw memory', async () => {
    const h = await harness([PHASE1_JSON('Demo Session 1!')])
    h.headers.push(activeHeader('s1'))
    h.setEvents('s1', [
      userMessage('请搭建记忆管道'),
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '完成了' }] } },
      userMessage('再补上测试'),
      { type: 'tool/call', data: { name: 'bash', arguments: { command: 'pnpm test' } } },
      { type: 'tool/result', data: { name: 'bash', isError: false, content: [{ type: 'text', text: '3 passed' }] } },
    ])

    const summary = await h.runner.run()
    expect(summary).toMatchObject({ selected: 1, done: 1, noop: 0, failed: 0 })

    const rollout = await h.files.readIfExists('rollout_summaries/demo-session-1.md')
    expect(rollout).toContain('# demo summary')
    expect(rollout).toContain('session: s1')
    const raw = await h.files.readIfExists('raw_memories.md')
    expect(raw).toContain('dsh-memory raw')
    expect(raw).toContain('keywords: demo, pipeline')

    expect(h.state.processedOf('s1')).toMatchObject({ status: 'done', slug: 'demo-session-1' })
    expect(h.state.pendingConsolidation).toBe(true)
  })

  it('marks no-op when the model returns all-empty fields', async () => {
    const h = await harness(['{"raw_memory":"","rollout_summary":"","rollout_slug":""}'])
    h.headers.push(activeHeader('s1'))
    h.setEvents('s1', [userMessage('你好')])

    const summary = await h.runner.run()
    expect(summary).toMatchObject({ done: 0, noop: 1 })
    expect(h.state.processedOf('s1')?.status).toBe('noop')
    expect(await h.files.readIfExists('raw_memories.md')).toBeUndefined()
    expect(h.state.pendingConsolidation).toBe(false)
  })

  it('skips sessions below the minimum event count', async () => {
    const h = await harness([])
    h.headers.push(activeHeader('s1'))
    h.setEvents('s1', [userMessage('只有一个事件')])

    const summary = await h.runner.run()
    expect(summary).toMatchObject({ selected: 1, noop: 1 })
    expect(h.state.processedOf('s1')?.status).toBe('noop')
  })

  it('records failures with attempts and retries after the backoff window', async () => {
    const h = await harness([new Error('llm down'), PHASE1_JSON('retry-session')])
    h.headers.push(activeHeader('s1', h.clock.value))
    h.setEvents('s1', [userMessage('任务一'), userMessage('任务二'), userMessage('任务三'), userMessage('任务四')])

    const first = await h.runner.run()
    expect(first).toMatchObject({ failed: 1 })
    expect(h.state.processedOf('s1')).toMatchObject({ status: 'failed', attempts: 1 })

    // Inside the backoff window the claim stays parked.
    const parked = await h.runner.run()
    expect(parked).toMatchObject({ selected: 0 })

    // After the backoff expires the next run retries and succeeds.
    h.clock.value += 5 * 60_000
    const second = await h.runner.run()
    expect(second).toMatchObject({ done: 1 })
    expect(h.state.processedOf('s1')).toMatchObject({ status: 'done', attempts: 2 })
  })

  it('does not process subagent sessions', async () => {
    const h = await harness([])
    h.headers.push({ id: 'child', createdAt: Date.now(), origin: 'subagent', parentSession: 'parent' })

    const summary = await h.runner.run()
    expect(summary.selected).toBe(0)
    expect(h.state.processedOf('child')).toBeUndefined()
  })

  it('salvages a truncated but structurally complete JSON response', async () => {
    const h = await harness([{ text: PHASE1_JSON('truncated-but-ok'), truncated: true }])
    h.headers.push(activeHeader('s1'))
    h.setEvents('s1', [userMessage('一'), userMessage('二'), userMessage('三'), userMessage('四')])

    const summary = await h.runner.run()
    expect(summary).toMatchObject({ done: 1, failed: 0 })
    expect(h.state.processedOf('s1')).toMatchObject({ status: 'done', slug: 'truncated-but-ok' })
  })

  it('fails a truncated response whose JSON is incomplete, with route context', async () => {
    const h = await harness([{ text: '{"rollout_summary":"未闭合', truncated: true }])
    h.headers.push(activeHeader('s1'))
    h.setEvents('s1', [userMessage('一'), userMessage('二'), userMessage('三'), userMessage('四')])

    const summary = await h.runner.run()
    expect(summary).toMatchObject({ failed: 1 })
    const claim = h.state.processedOf('s1')
    expect(claim?.status).toBe('failed')
    expect(claim?.error).toContain('truncated')
    expect(claim?.error).toContain('route=mock/mock')
  })

  it('skips the batch when no model route is available', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-memory-phase1-'))
    const { facility } = fakeKv()
    const state = new MemoryStateStore(() => facility)
    await state.init()
    const files = new MemoryFiles(root)
    const { llm } = fakeLlm([])
    const reader: SessionReader = {
      async listSessions() {
        return [{ id: 's1', createdAt: Date.now() }]
      },
      async readSession(id) {
        return { session: { id }, events: [] }
      },
    }
    const runner = new Phase1Runner({
      llm,
      state,
      files,
      sessions: () => reader,
      config: () => resolveConfig({}),
      route: () => undefined,
    })
    const summary = await runner.run()
    expect(summary.skippedNoRoute).toBe(true)
  })
})
