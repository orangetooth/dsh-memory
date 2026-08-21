/** Restricted in-process Phase 2 agent built on the DSH subagent seam. */
import type { SubagentCapabilities, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent';
import type { ModelRoute } from './llm.js';
export interface ConsolidationArtifacts {
    memoryMd: string;
    memorySummaryMd: string;
}
export interface ConsolidationRequest {
    mode: 'init' | 'incremental';
    memoryRoot: string;
    pendingNotes: number;
    rolloutSummaries: number;
    maxRawChars: number;
    maxTokens: number;
    route: ModelRoute;
}
export type ConsolidatorReadiness = 'ready' | 'no-agent' | 'no-provider';
/** Narrow Phase 2 seam so the runner and tests do not depend on a concrete agent backend. */
export interface Phase2Consolidator {
    readiness(): ConsolidatorReadiness;
    consolidate(request: ConsolidationRequest): Promise<ConsolidationArtifacts>;
}
interface ProviderLike {
    readonly capabilities: SubagentCapabilities;
    readonly inheritsParentContext: boolean;
}
/** Structural subset of `ctx.subagents` used by this plugin. */
export interface SubagentRuntimeLike {
    getProvider(name: string): ProviderLike | undefined;
    start(name: string, request: SubagentStartRequest): Promise<SubagentRun>;
}
export interface HarnessConsolidationAgentDeps {
    subagents: SubagentRuntimeLike;
    parent: () => SubagentStartRequest['parent'] | undefined;
    providerName?: string;
    timeoutMs?: number;
}
declare const READ_ONLY_MEMORY_TOOLS: readonly ["memory_list", "memory_read", "memory_search"];
/**
 * Runs Codex-style consolidation as a fresh, one-shot DSH child agent.
 *
 * The child receives no parent transcript. Its global tools are reduced to the
 * three read-only memory tools; structured output is a child-scoped capability,
 * so the parent plugin remains the sole writer of MEMORY.md and the summary.
 */
export declare class HarnessConsolidationAgent implements Phase2Consolidator {
    private readonly deps;
    constructor(deps: HarnessConsolidationAgentDeps);
    readiness(): ConsolidatorReadiness;
    consolidate(request: ConsolidationRequest): Promise<ConsolidationArtifacts>;
}
export { READ_ONLY_MEMORY_TOOLS };
//# sourceMappingURL=consolidation-agent.d.ts.map