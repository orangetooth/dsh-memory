/** Read path: system-prompt injection of the memory guide plus the summary cache. */
import type { Config } from './config.js';
import type { MemoryFiles } from './files.js';
export interface SystemPromptRuntime {
    section(section: {
        name: string;
        order: number;
        text: string | ((context: unknown) => string);
    }): () => void;
}
/** Tool guidance sections live in the 100–199 order band. */
export declare const GUIDE_ORDER = 160;
/** Build the injected section text: compact usage guide plus the bounded summary. */
export declare function buildSectionText(root: string, summary: string | undefined, cap: number): string;
/**
 * Owns the injected section. The section text is a provider evaluated at each
 * assembly, so re-registration is never needed; a summary cache avoids file I/O
 * on the assembly hot path.
 */
export declare class MemoryInjection {
    private readonly files;
    private readonly config;
    private summary;
    private disposer;
    constructor(files: MemoryFiles, config: () => Config);
    reload(): Promise<void>;
    install(systemPrompt: SystemPromptRuntime): void;
    dispose(): void;
}
//# sourceMappingURL=inject.d.ts.map