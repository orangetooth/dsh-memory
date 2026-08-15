/** LLM call helpers: streaming text collection, JSON/fence parsing, route resolution. */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Config } from './config.js';
export interface LlmRuntime {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
export interface ModelRoute {
    provider: string;
    model: string;
}
export declare class LlmCallError extends Error {
    readonly kind: 'error' | 'aborted' | 'max-tokens' | 'empty' | 'oversize' | 'tool-calls' | 'invalid-json';
    constructor(kind: 'error' | 'aborted' | 'max-tokens' | 'empty' | 'oversize' | 'tool-calls' | 'invalid-json', message: string);
}
export interface CollectedText {
    text: string;
    /** True when the finish reason was max-tokens: the response may be truncated. */
    truncated: boolean;
}
/** Collect a full text response; reports max-tokens truncation instead of throwing. */
export declare function collectTextDetails(runtime: LlmRuntime, options: GenerateOptions, maxChars?: number): Promise<CollectedText>;
/** Collect a full text response, failing on any abnormal finish including truncation. */
export declare function collectText(runtime: LlmRuntime, options: GenerateOptions, maxChars?: number): Promise<string>;
/** Strip a ```json fence when present. */
export declare function stripFences(text: string): string;
/** Extract the first balanced top-level JSON object from model output. */
export declare function extractJsonObject(text: string): Record<string, unknown>;
/** Parse labeled fenced blocks into a label → body map. */
export declare function parseFencedBlocks(text: string): Map<string, string>;
/** Pick the block whose label matches one of the given names. */
export declare function pickBlock(blocks: ReadonlyMap<string, string>, labels: readonly string[]): string | undefined;
/** Resolve the pipeline's model route: explicit config first, then the deployment default. */
export declare function resolveRoute(config: Config, defaultSelection: unknown): ModelRoute | undefined;
/** Build a plugin-owned GenerateOptions for one pipeline call. */
export declare function generateOptions(route: ModelRoute, system: string, userText: string, maxTokens: number, signal?: AbortSignal): GenerateOptions;
//# sourceMappingURL=llm.d.ts.map