/** Restricted in-process Phase 2 agent built on the DSH subagent seam. */

import type {
  SubagentCapabilities,
  SubagentRun,
  SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import type { ModelRoute } from './llm.js'
import { PHASE2_OUTPUT_SCHEMA, PHASE2_SYSTEM, phase2User } from './prompts.js'

export interface ConsolidationArtifacts {
  memoryMd: string
  memorySummaryMd: string
}

export interface ConsolidationRequest {
  mode: 'init' | 'incremental'
  memoryRoot: string
  pendingNotes: number
  rolloutSummaries: number
  maxRawChars: number
  maxTokens: number
  route: ModelRoute
}

export type ConsolidatorReadiness = 'ready' | 'no-agent' | 'no-provider'

/** Narrow Phase 2 seam so the runner and tests do not depend on a concrete agent backend. */
export interface Phase2Consolidator {
  readiness(): ConsolidatorReadiness
  consolidate(request: ConsolidationRequest): Promise<ConsolidationArtifacts>
}

interface ProviderLike {
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean
}

/** Structural subset of `ctx.subagents` used by this plugin. */
export interface SubagentRuntimeLike {
  getProvider(name: string): ProviderLike | undefined
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>
}

export interface HarnessConsolidationAgentDeps {
  subagents: SubagentRuntimeLike
  parent: () => SubagentStartRequest['parent'] | undefined
  providerName?: string
  timeoutMs?: number
}

const READ_ONLY_MEMORY_TOOLS = ['memory_list', 'memory_read', 'memory_search'] as const
const REQUIRED_CAPABILITIES = ['outputSchema', 'depthLimit', 'toolFilter', 'persona'] as const
const DEFAULT_PROVIDER = 'spawn'
const DEFAULT_TIMEOUT_MS = 800_000

function supportsRestrictedRun(provider: ProviderLike | undefined): provider is ProviderLike {
  return provider !== undefined
    && provider.inheritsParentContext === false
    && REQUIRED_CAPABILITIES.every(capability => provider.capabilities[capability])
}

function artifactsOf(value: unknown): ConsolidationArtifacts {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('整合 agent 未返回结构化对象')
  }
  const record = value as Record<string, unknown>
  if (typeof record.memory_md !== 'string' || record.memory_md.trim() === '') {
    throw new Error('整合 agent 的结构化输出缺少非空 memory_md')
  }
  if (typeof record.memory_summary_md !== 'string' || record.memory_summary_md.trim() === '') {
    throw new Error('整合 agent 的结构化输出缺少非空 memory_summary_md')
  }
  return { memoryMd: record.memory_md, memorySummaryMd: record.memory_summary_md }
}

/**
 * Runs Codex-style consolidation as a fresh, one-shot DSH child agent.
 *
 * The child receives no parent transcript. Its global tools are reduced to the
 * three read-only memory tools; structured output is a child-scoped capability,
 * so the parent plugin remains the sole writer of MEMORY.md and the summary.
 */
export class HarnessConsolidationAgent implements Phase2Consolidator {
  constructor(private readonly deps: HarnessConsolidationAgentDeps) {}

  readiness(): ConsolidatorReadiness {
    if (this.deps.parent() === undefined) return 'no-agent'
    const provider = this.deps.subagents.getProvider(this.deps.providerName ?? DEFAULT_PROVIDER)
    return supportsRestrictedRun(provider) ? 'ready' : 'no-provider'
  }

  async consolidate(request: ConsolidationRequest): Promise<ConsolidationArtifacts> {
    const parent = this.deps.parent()
    if (parent === undefined) throw new Error('整合需要一个存活的 root agent 作为受限子 agent 的父级')
    const providerName = this.deps.providerName ?? DEFAULT_PROVIDER
    const provider = this.deps.subagents.getProvider(providerName)
    if (!supportsRestrictedRun(provider)) {
      throw new Error(`subagent provider "${providerName}" 不支持 fresh context、persona、toolFilter、depthLimit 与 outputSchema`)
    }

    const signal = AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const run = await this.deps.subagents.start(providerName, {
      label: 'memory-consolidation',
      parent,
      signal,
      prompt: [{ type: 'text', text: phase2User(request) }],
      agentOptions: {
        provider: request.route.provider,
        model: request.route.model,
        maxTokens: request.maxTokens,
      },
      outputSchema: PHASE2_OUTPUT_SCHEMA,
      maxDepth: 1,
      toolFilter: { allow: READ_ONLY_MEMORY_TOOLS },
      persona: PHASE2_SYSTEM,
    })
    try {
      const result = await run.result
      if (result.stopReason !== 'completed') {
        throw new Error(`整合 agent 未正常完成（stopReason=${result.stopReason}）`)
      }
      return artifactsOf(result.structured)
    } finally {
      await run.dispose()
    }
  }
}

export { READ_ONLY_MEMORY_TOOLS }
