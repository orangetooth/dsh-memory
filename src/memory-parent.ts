/** Dedicated top-level agent that owns every Phase 2 consolidation child. */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { MemoryStateStore } from './bookkeeping.js'
import { messageOf } from './util.js'

export const MEMORY_PARENT_TITLE = '长期记忆（后台整合）'
export const MEMORY_PARENT_ID_PREFIX = 'dsh-memory-parent-'

type ParentAgent = SubagentStartRequest['parent']

export interface MemoryParentHandleLike {
  agent: ParentAgent
  dispose(): Promise<void>
}

/** Structural slice of `ctx.agents`, kept narrow for compatibility and tests. */
export interface AgentRegistryRuntimeLike {
  get(id: string): ParentAgent | undefined
  create(options: { sessionId: string; meta: { cwd: string } }): Promise<MemoryParentHandleLike>
  resume(options: { resumeSessionId: string }): Promise<MemoryParentHandleLike>
}

interface WritableSessionLike {
  header: { cwd?: string; origin?: 'subagent' }
  events: ReadonlyArray<{ type?: unknown }>
  append(type: string, data: unknown, options?: { ignorable?: boolean }): unknown
}

interface SessionStoreLike {
  flush?: (session: unknown) => Promise<unknown>
}

function isMissingPersistedSession(error: unknown): boolean {
  const text = messageOf(error)
  return text.includes('not found') || text.includes('session persistence is not configured')
}

/**
 * Owns one blank root agent whose only job is to provide durable lineage and a
 * memory-root workspace for fresh consolidation children. It never receives a
 * model-facing turn and deliberately joins no business agent preset.
 */
export class MemoryParent {
  private current: ParentAgent | undefined
  private ownedHandle: MemoryParentHandleLike | undefined
  private starting: Promise<ParentAgent> | undefined
  private disposed = false

  constructor(
    private readonly agents: AgentRegistryRuntimeLike,
    private readonly state: MemoryStateStore,
    readonly memoryRoot: string,
  ) {}

  get id(): string | undefined {
    return this.state.memoryParentSessionId
  }

  get agent(): ParentAgent | undefined {
    return this.current
  }

  matches(agent: ParentAgent): boolean {
    return this.id !== undefined && agent.id === this.id
  }

  /** Clear a borrowed/live handle if another owner tears it down. */
  noticeDisposed(agent: ParentAgent): void {
    if (this.current !== agent) return
    this.current = undefined
    if (this.ownedHandle?.agent === agent) this.ownedHandle = undefined
  }

  /** Create or cold-resume the dedicated parent, single-flight. */
  ensure(): Promise<ParentAgent> {
    if (this.disposed) return Promise.reject(new Error('memory parent is disposed'))
    if (this.current !== undefined) return Promise.resolve(this.current)
    if (this.starting !== undefined) return this.starting
    const starting = this.open().finally(() => {
      if (this.starting === starting) this.starting = undefined
    })
    this.starting = starting
    return starting
  }

  private async open(): Promise<ParentAgent> {
    let id = this.state.memoryParentSessionId
    if (id === undefined) {
      id = `${MEMORY_PARENT_ID_PREFIX}${randomUUID()}`
      this.state.setMemoryParentSessionId(id)
      await this.state.flush()
    }

    const live = this.agents.get(id)
    if (live !== undefined) {
      this.assertDedicated(live)
      await this.ensureVisibleTitle(live)
      this.current = live
      return live
    }

    let handle: MemoryParentHandleLike
    try {
      handle = await this.agents.resume({ resumeSessionId: id })
    } catch (error: unknown) {
      if (!isMissingPersistedSession(error)) throw error
      handle = await this.agents.create({ sessionId: id, meta: { cwd: this.memoryRoot } })
    }

    try {
      this.assertDedicated(handle.agent)
      await this.ensureVisibleTitle(handle.agent)
      if (this.disposed) throw new Error('memory parent was disposed during startup')
    } catch (error: unknown) {
      await handle.dispose().catch(() => {})
      throw error
    }
    this.ownedHandle = handle
    this.current = handle.agent
    return handle.agent
  }

  private assertDedicated(agent: ParentAgent): void {
    const header = agent.session.header
    if (header.origin === 'subagent') throw new Error(`memory parent "${agent.id}" is a subagent session`)
    if (header.cwd === undefined || resolve(header.cwd) !== resolve(this.memoryRoot)) {
      throw new Error(`memory parent "${agent.id}" has unexpected cwd "${header.cwd ?? ''}"`)
    }
  }

  private async ensureVisibleTitle(agent: ParentAgent): Promise<void> {
    const session = agent.session as unknown as WritableSessionLike
    if (session.events.some(event => event.type === 'session/title')) return
    session.append('session/title', {
      title: MEMORY_PARENT_TITLE,
      messageSeqs: [],
      source: { kind: 'user' },
    }, { ignorable: true })
    const sessions = agent.ctx.get('sessions') as SessionStoreLike | undefined
    await sessions?.flush?.(agent.session)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const handle = this.ownedHandle
    this.ownedHandle = undefined
    this.current = undefined
    if (handle !== undefined) await handle.dispose()
  }
}
