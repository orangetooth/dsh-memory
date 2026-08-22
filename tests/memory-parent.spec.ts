import { describe, expect, it } from 'vitest'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { MemoryStateStore } from '../src/bookkeeping.js'
import {
  MEMORY_PARENT_ID_PREFIX,
  MEMORY_PARENT_TITLE,
  MemoryParent,
  type AgentRegistryRuntimeLike,
  type MemoryParentHandleLike,
} from '../src/memory-parent.js'
import { fakeKv } from './helpers.js'

type ParentAgent = SubagentStartRequest['parent']

function fakeAgent(id: string, cwd = '/memories', events: Array<{ type: string; data?: unknown }> = []): {
  agent: ParentAgent
  flushes: { count: number }
} {
  const flushes = { count: 0 }
  const session = {
    header: { id, cwd },
    events,
    append(type: string, data: unknown) {
      events.push({ type, data })
    },
  }
  const agent = {
    id,
    session,
    ctx: {
      get(name: string) {
        return name === 'sessions'
          ? { async flush() { flushes.count += 1 } }
          : undefined
      },
    },
  } as unknown as ParentAgent
  return { agent, flushes }
}

function handle(agent: ParentAgent, disposals: { count: number }): MemoryParentHandleLike {
  return {
    agent,
    async dispose() {
      disposals.count += 1
    },
  }
}

describe('MemoryParent', () => {
  it('creates, titles, flushes, and owns a dedicated memory-root agent', async () => {
    const { facility } = fakeKv()
    const state = new MemoryStateStore(() => facility)
    await state.init()
    const disposals = { count: 0 }
    const creates: Array<{ sessionId: string; meta: { cwd: string } }> = []
    let created: ReturnType<typeof fakeAgent> | undefined
    const agents: AgentRegistryRuntimeLike = {
      get: () => undefined,
      async resume() {
        throw new Error('session not found')
      },
      async create(options) {
        creates.push(options)
        created = fakeAgent(options.sessionId, options.meta.cwd)
        return handle(created.agent, disposals)
      },
    }
    const parent = new MemoryParent(agents, state, '/memories')

    const agent = await parent.ensure()

    expect(creates).toHaveLength(1)
    expect(creates[0]?.sessionId).toMatch(new RegExp(`^${MEMORY_PARENT_ID_PREFIX}`))
    expect(creates[0]?.meta).toEqual({ cwd: '/memories' })
    expect(state.memoryParentSessionId).toBe(agent.id)
    expect(agent.session.events).toContainEqual(expect.objectContaining({
      type: 'session/title',
      data: expect.objectContaining({ title: MEMORY_PARENT_TITLE }),
    }))
    expect(created?.flushes.count).toBe(1)
    expect(parent.matches(agent)).toBe(true)

    await parent.dispose()
    expect(disposals.count).toBe(1)
    await state.dispose()
  })

  it('cold-resumes the persisted identity without duplicating its title', async () => {
    const { facility } = fakeKv()
    const first = new MemoryStateStore(() => facility)
    await first.init()
    first.setMemoryParentSessionId('dsh-memory-parent-stable')
    await first.dispose()

    const state = new MemoryStateStore(() => facility)
    await state.init()
    const existing = fakeAgent('dsh-memory-parent-stable', '/memories', [
      { type: 'session/title', data: { title: MEMORY_PARENT_TITLE } },
    ])
    const resumes: string[] = []
    const agents: AgentRegistryRuntimeLike = {
      get: () => undefined,
      async create() {
        throw new Error('must not create')
      },
      async resume({ resumeSessionId }) {
        resumes.push(resumeSessionId)
        return handle(existing.agent, { count: 0 })
      },
    }
    const parent = new MemoryParent(agents, state, '/memories')

    await expect(parent.ensure()).resolves.toBe(existing.agent)
    expect(resumes).toEqual(['dsh-memory-parent-stable'])
    expect(existing.agent.session.events).toHaveLength(1)
    expect(existing.flushes.count).toBe(0)

    await parent.dispose()
    await state.dispose()
  })

  it('rejects an identity collision outside the memory workspace', async () => {
    const { facility } = fakeKv()
    const state = new MemoryStateStore(() => facility)
    await state.init()
    state.setMemoryParentSessionId('dsh-memory-parent-collision')
    const collision = fakeAgent('dsh-memory-parent-collision', '/business-project')
    const agents: AgentRegistryRuntimeLike = {
      get: () => collision.agent,
      async create() { throw new Error('unused') },
      async resume() { throw new Error('unused') },
    }
    const parent = new MemoryParent(agents, state, '/memories')

    await expect(parent.ensure()).rejects.toThrow('unexpected cwd')
    await parent.dispose()
    await state.dispose()
  })

  it('adopts an already-live dedicated parent and repairs a missing title', async () => {
    const { facility } = fakeKv()
    const state = new MemoryStateStore(() => facility)
    await state.init()
    state.setMemoryParentSessionId('dsh-memory-parent-live')
    const live = fakeAgent('dsh-memory-parent-live')
    const agents: AgentRegistryRuntimeLike = {
      get: () => live.agent,
      async create() { throw new Error('unused') },
      async resume() { throw new Error('unused') },
    }
    const parent = new MemoryParent(agents, state, '/memories')

    await expect(parent.ensure()).resolves.toBe(live.agent)
    expect(live.agent.session.events).toContainEqual(expect.objectContaining({ type: 'session/title' }))
    expect(live.flushes.count).toBe(1)

    await parent.dispose()
    await state.dispose()
  })
})
