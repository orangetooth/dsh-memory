/**
 * dsh-memory — long-term memory system for DeepSeek Harness.
 *
 * Two-phase pipeline adapted from Codex memories onto DSH primitives:
 * Phase 1 extracts durable memories from root session logs (sessionQuery /
 * sessionPersistence), Phase 2 consolidates them into MEMORY.md and
 * memory_summary.md. The summary is injected through systemPrompt, and four
 * memory tools serve on-demand retrieval. Bookkeeping (claims, cooldown,
 * pending flag, overrides) persists through the storage hub KV backend.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubagentRuntime, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { MemoryStateStore, type KvFacilityLike } from './bookkeeping.js'
import { HarnessConsolidationAgent, type AgentRequestRuntimeLike } from './consolidation-agent.js'
import { Config, resolveConfig } from './config.js'
import type { Config as ConfigShape } from './config.js'
import { MemoryFiles } from './files.js'
import { MemoryInjection, type SystemPromptRuntime } from './inject.js'
import type { LlmRuntime, ModelRoute } from './llm.js'
import { resolveRoute } from './llm.js'
import { resolveMemoryRoot } from './paths.js'
import { MemoryParent, type AgentRegistryRuntimeLike } from './memory-parent.js'
import { Phase1Runner } from './phase1.js'
import { Phase2Runner } from './phase2.js'
import { registerRpc, type WebServerRuntime } from './rpc.js'
import { registerMemoryTools, type ToolRegistryRuntime } from './tools.js'
import type { SessionHeaderLite, SessionReader } from './types.js'
import { messageOf } from './util.js'

export const name = 'dsh-memory'
export const inject = ['agents', 'llm', 'timer', 'subagents', 'tools']

export { Config, DEFAULTS, clampOverrides, OVERRIDABLE_KEYS, resolveConfig } from './config.js'
export type { Config as MemoryConfig, OverridableKey } from './config.js'
export { MemoryStateStore, type KvFacilityLike, type KvUnitLike } from './bookkeeping.js'
export {
  CONSOLIDATION_LABEL, HarnessConsolidationAgent, READ_ONLY_MEMORY_TOOLS,
  type ConsolidationArtifacts, type ConsolidationRequest, type ConsolidatorReadiness,
  type AgentRequestRuntimeLike, type HarnessConsolidationAgentDeps, type Phase2Consolidator, type SubagentRuntimeLike,
} from './consolidation-agent.js'
export { MemoryFiles, ensureSummaryV1 } from './files.js'
export { MemoryInjection, buildSectionText, GUIDE_ORDER, type SystemPromptRuntime } from './inject.js'
export {
  MEMORY_PARENT_ID_PREFIX, MEMORY_PARENT_TITLE, MemoryParent,
  type AgentRegistryRuntimeLike, type MemoryParentHandleLike,
} from './memory-parent.js'
export {
  collectResponse, collectText, collectTextDetails, extractJsonObject, generateOptions,
  LlmCallError, parseCallArguments, parseFencedBlocks, PHASE1_REASONING, PHASE2_REASONING,
  pickBlock, resolveRoute, resolveStageRoute, stripFences,
} from './llm.js'
export type { CollectedCall, CollectedResponse, CollectedText, LlmRuntime, MemoryStageReasoning, ModelRoute } from './llm.js'
export { defaultMemoryRoot, isWithin, resolveMemoryRoot, sanitizeSlug } from './paths.js'
export { Phase1Runner, type Phase1Deps, type Phase1Summary } from './phase1.js'
export { Phase2Runner, type Phase2Deps, type Phase2Outcome } from './phase2.js'
export { PHASE1_SYSTEM, PHASE1_TOOL, PHASE2_OUTPUT_SCHEMA, PHASE2_SYSTEM, PHASE2_TOOL, phase1User, phase2User } from './prompts.js'
export type { Phase1InputMeta, Phase2Input } from './prompts.js'
export { redactSecrets, renderEvent, renderTranscript, selectCandidates } from './rollout.js'
export type { SelectionOptions, SelectionResult, TranscriptOptions } from './rollout.js'
export { registerRpc, type RpcDeps, type StatePayload, type WebServerRuntime } from './rpc.js'
export { registerMemoryTools, type ToolRegistryRuntime } from './tools.js'
export type { FileEntry, MemoryState, SessionClaim, SessionHeaderLite, SessionLogLite, SessionReader } from './types.js'
export { headTail, messageOf } from './util.js'

interface TimerService {
  timeout(callback: () => void, delay: number): unknown
  debounce<F extends () => void>(callback: F, delay: number): (() => void) & { dispose(): void }
}

interface SessionQueryLike {
  listSessions?: (signal?: unknown) => Promise<Array<{ header: unknown }>>
  readSession?: (id: string) => Promise<{ session: unknown; events: unknown[] }>
}

interface SessionPersistenceLike {
  list?: (signal?: unknown) => Promise<unknown[]>
  load?: (id: string) => Promise<{ header?: unknown; events?: unknown[] }>
}

export function apply(ctx: Context, config: Partial<ConfigShape> = {}): void {
  const base = resolveConfig(config)
  const llm = ctx.get('llm') as LlmRuntime | undefined
  if (llm === undefined) throw new Error('dsh-memory requires the llm service')
  const timer = ctx.get('timer') as TimerService | undefined
  if (timer === undefined) throw new Error('dsh-memory requires the timer service')
  const subagents = ctx.get('subagents') as SubagentRuntime | undefined
  if (subagents === undefined) throw new Error('dsh-memory requires the subagents service')
  const agents = ctx.get('agents') as AgentRegistryRuntimeLike | undefined
  if (agents === undefined) throw new Error('dsh-memory requires the agents service')

  const getKv = (): KvFacilityLike | undefined => {
    const storage = ctx.get('storage') as { backend?: { get?: (form: string) => unknown } } | undefined
    const backend = storage?.backend?.get?.('json') as { kv?: KvFacilityLike } | undefined
    return backend?.kv
  }

  const state = new MemoryStateStore(getKv)
  const files = new MemoryFiles(resolveMemoryRoot(base.memoryRoot))
  const memoryParent = new MemoryParent(agents, state, files.root)
  const configNow = (): ConfigShape => resolveConfig(base, state.snapshot().overrides)

  const sessionReader = (): SessionReader | undefined => {
    const query = ctx.get('sessionQuery') as SessionQueryLike | undefined
    if (query?.listSessions !== undefined && query.readSession !== undefined) {
      return {
        listSessions: async () => (await query.listSessions!())
          .map(record => record.header as SessionHeaderLite)
          .filter(header => header.id !== state.memoryParentSessionId),
        readSession: async id => {
          const snapshot = await query.readSession!(id)
          return { session: snapshot.session as SessionHeaderLite, events: snapshot.events }
        },
      }
    }
    const persistence = ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
    if (persistence?.list !== undefined && persistence.load !== undefined) {
      return {
        listSessions: async () => ((await persistence.list!()) as SessionHeaderLite[])
          .filter(header => header.id !== state.memoryParentSessionId),
        readSession: async id => {
          const inspection = await persistence.load!(id)
          return {
            session: (inspection.header ?? { id }) as SessionHeaderLite,
            events: inspection.events ?? [],
          }
        },
      }
    }
    return undefined
  }

  const routeNow = (): ModelRoute | undefined => {
    const selection = (ctx.get('agentDefaultModel') as { currentSelection?: () => unknown } | undefined)?.currentSelection?.()
    return resolveRoute(configNow(), selection)
  }

  const consolidator = new HarnessConsolidationAgent({
    subagents,
    parent: () => memoryParent.agent,
    agentRequests: ctx as unknown as AgentRequestRuntimeLike,
  })
  const phase1 = new Phase1Runner({ llm, state, files, sessions: sessionReader, config: configNow, route: routeNow })
  const phase2 = new Phase2Runner({
    consolidator,
    llm,
    state,
    files,
    config: configNow,
    route: routeNow,
    prepare: async () => {
      await stateReady
      await memoryParent.ensure()
    },
  })
  const injection = new MemoryInjection(files, configNow)

  const log = (text: string): void => {
    console.error(`[dsh-memory] ${text}`)
  }

  const runPipeline = async (): Promise<void> => {
    await stateReady
    const cfg = configNow()
    if (!cfg.enabled) return
    await memoryParent.ensure().catch(error => log(`memory parent: ${messageOf(error)}`))
    const summary = await phase1.run()
    if (summary.done > 0 || state.pendingConsolidation || await files.hasPendingNotes()) {
      await phase2.run(false)
    }
    await injection.reload()
    await state.flush()
  }

  let scheduled = false
  const runSoon = (): void => {
    if (scheduled) return
    scheduled = true
    timer.timeout(() => {
      scheduled = false
      void runPipeline().catch(error => log(`pipeline: ${messageOf(error)}`))
    }, 4_000)
  }

  const triggerFromTurn = (): void => {
    if (!configNow().enabled) return
    const debounced = timer.debounce(runSoon, configNow().idleDebounceMs)
    debounced()
  }

  // Root-session lifecycle: Codex wakes the pipeline at root session start;
  // we additionally schedule after each root turn stops (debounced = idle guard).
  let lastSessionStartTrigger = 0
  const isRoot = (agent: SubagentStartRequest['parent']): boolean =>
    agent.session.header.origin !== 'subagent' && !memoryParent.matches(agent)
  ctx.on('agent/turn-stopping', ({ agent }: { agent: SubagentStartRequest['parent'] }) => {
    if (!isRoot(agent)) return
    triggerFromTurn()
  })
  ctx.on('agent/session-start', ({ agent }: { agent: SubagentStartRequest['parent'] }) => {
    if (!isRoot(agent)) return
    const now = Date.now()
    if (now - lastSessionStartTrigger < 60_000) return
    lastSessionStartTrigger = now
    runSoon()
  })
  ctx.on('agent/disposed', ({ agent }: { agent: SubagentStartRequest['parent'] }) => {
    memoryParent.noticeDisposed(agent)
  })

  // Optional services: react to late mounting through the cordis service event.
  const whenService = <T>(serviceName: string, use: (service: T) => void): void => {
    const attempt = (): boolean => {
      const service = ctx.get(serviceName) as T | undefined
      if (service === undefined) return false
      use(service)
      return true
    }
    if (attempt()) return
    ctx.on('internal/service', (payload: unknown) => {
      const received = typeof payload === 'string' ? payload : (payload as { name?: unknown } | null)?.name
      if (received === serviceName) attempt()
    })
  }

  let toolsDisposer: (() => void) | undefined
  ctx.effect(() => () => toolsDisposer?.())
  whenService<ToolRegistryRuntime>('tools', registry => {
    if (toolsDisposer !== undefined) return
    toolsDisposer = registerMemoryTools(registry, files, state)
  })
  whenService<SystemPromptRuntime>('systemPrompt', systemPrompt => injection.install(systemPrompt))
  whenService<WebServerRuntime>('webServer', webServer => {
    const disposeRpc = registerRpc(webServer, {
      state, files, llm, config: configNow, route: routeNow, phase1, phase2, runPipeline,
    })
    ctx.effect(() => disposeRpc)
  })

  ctx.effect(() => async () => {
    injection.dispose()
    await memoryParent.dispose()
    await state.dispose()
  })

  const stateReady = state.init()
  void (async () => {
    try {
      await stateReady
      await files.ensureLayout()
      await memoryParent.ensure()
      await injection.reload()
      if (configNow().enabled) runSoon()
    } catch (error: unknown) {
      log(`init: ${messageOf(error)}`)
    }
  })()
}
