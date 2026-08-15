/** Read-path tools: memory_list / memory_read / memory_search / memory_add. */
import type { MemoryStateStore } from './bookkeeping.js';
import type { MemoryFiles } from './files.js';
export interface ToolRegistryRuntime {
    register(definition: unknown): () => void;
}
/** Register the four memory tools; returns a disposer that unregisters all of them. */
export declare function registerMemoryTools(registry: ToolRegistryRuntime, files: MemoryFiles, state: MemoryStateStore): () => void;
//# sourceMappingURL=tools.d.ts.map