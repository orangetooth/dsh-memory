/** Phase 2: global consolidation into MEMORY.md and memory_summary.md. */
import type { MemoryStateStore } from './bookkeeping.js';
import type { Phase2Consolidator } from './consolidation-agent.js';
import type { Config } from './config.js';
import type { MemoryFiles } from './files.js';
import type { LlmRuntime, ModelRoute } from './llm.js';
export type Phase2Outcome = {
    kind: 'consolidated';
    mode: 'init' | 'incremental';
} | {
    kind: 'skipped';
    reason: 'cooldown' | 'no-input' | 'no-route' | 'no-agent' | 'no-provider';
} | {
    kind: 'error';
    error: string;
};
export interface Phase2Deps {
    consolidator: Phase2Consolidator;
    llm: LlmRuntime;
    state: MemoryStateStore;
    files: MemoryFiles;
    config: () => Config;
    route: () => ModelRoute | undefined;
    /** Injectable clock for tests. */
    now?: () => number;
}
export declare class Phase2Runner {
    private readonly deps;
    private running;
    constructor(deps: Phase2Deps);
    /** Single-flight entry point; `force` bypasses the cooldown for manual runs. */
    run(force?: boolean): Promise<Phase2Outcome>;
    private execute;
}
//# sourceMappingURL=phase2.d.ts.map