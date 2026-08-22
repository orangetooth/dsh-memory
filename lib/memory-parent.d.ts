/** Dedicated top-level agent that owns every Phase 2 consolidation child. */
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent';
import type { MemoryStateStore } from './bookkeeping.js';
export declare const MEMORY_PARENT_TITLE = "\u957F\u671F\u8BB0\u5FC6\uFF08\u540E\u53F0\u6574\u5408\uFF09";
export declare const MEMORY_PARENT_ID_PREFIX = "dsh-memory-parent-";
type ParentAgent = SubagentStartRequest['parent'];
export interface MemoryParentHandleLike {
    agent: ParentAgent;
    dispose(): Promise<void>;
}
/** Structural slice of `ctx.agents`, kept narrow for compatibility and tests. */
export interface AgentRegistryRuntimeLike {
    get(id: string): ParentAgent | undefined;
    create(options: {
        sessionId: string;
        meta: {
            cwd: string;
        };
    }): Promise<MemoryParentHandleLike>;
    resume(options: {
        resumeSessionId: string;
    }): Promise<MemoryParentHandleLike>;
}
/**
 * Owns one blank root agent whose only job is to provide durable lineage and a
 * memory-root workspace for fresh consolidation children. It never receives a
 * model-facing turn and deliberately joins no business agent preset.
 */
export declare class MemoryParent {
    private readonly agents;
    private readonly state;
    readonly memoryRoot: string;
    private current;
    private ownedHandle;
    private starting;
    private disposed;
    constructor(agents: AgentRegistryRuntimeLike, state: MemoryStateStore, memoryRoot: string);
    get id(): string | undefined;
    get agent(): ParentAgent | undefined;
    matches(agent: ParentAgent): boolean;
    /** Clear a borrowed/live handle if another owner tears it down. */
    noticeDisposed(agent: ParentAgent): void;
    /** Create or cold-resume the dedicated parent, single-flight. */
    ensure(): Promise<ParentAgent>;
    private open;
    private assertDedicated;
    private ensureVisibleTitle;
    dispose(): Promise<void>;
}
export {};
//# sourceMappingURL=memory-parent.d.ts.map