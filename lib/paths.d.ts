/** Memory-root path handling. */
/** Default memory root: `$DSH_HOME/memories`, falling back to `~/.dsh/memories`. */
export declare function defaultMemoryRoot(): string;
/** Resolve the configured memory root; an empty value falls back to the default. */
export declare function resolveMemoryRoot(configured?: string): string;
/** Containment check used by the memory-path guard. */
export declare function isWithin(root: string, target: string): boolean;
/** Normalize a model-supplied slug into a filesystem-safe token. */
export declare function sanitizeSlug(input: string, fallback: string): string;
//# sourceMappingURL=paths.d.ts.map