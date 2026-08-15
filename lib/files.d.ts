/** Memory folder layout and file operations (Codex artifact parity, DSH-root adapted). */
import { sep } from 'node:path';
import type { FileEntry } from './types.js';
/**
 * Owns the memory directory:
 *
 * - memory_summary.md    dense, always-injected navigation layer
 * - MEMORY.md            grep-friendly handbook of consolidated memory
 * - raw_memories.md      Phase 1 output awaiting Phase 2 consolidation
 * - raw_memories.archive.md  rotated history of consolidated raw blocks
 * - rollout_summaries/   per-session recaps (evidence layer)
 * - skills/              reusable procedures promoted by consolidation
 * - extensions/ad_hoc/notes/  user-requested ad hoc notes
 */
export declare class MemoryFiles {
    readonly root: string;
    constructor(root: string);
    ensureLayout(): Promise<void>;
    /** Resolve a memory-relative path; rejects anything escaping the root. */
    rel(relPath: string): string;
    readIfExists(relPath: string, cap?: number): Promise<string | undefined>;
    writeAtomic(relPath: string, content: string): Promise<void>;
    appendText(relPath: string, content: string): Promise<void>;
    /** Move raw_memories.md into the archive and reset it for the next batch. */
    rotateRaw(): Promise<void>;
    /** Pick a unique rollout summary filename inside rollout_summaries/. */
    uniqueRolloutSlug(slug: string, sessionId: string): Promise<string>;
    listTree(subPath?: string): Promise<FileEntry[]>;
    rolloutIndex(limit?: number): Promise<string[]>;
    stats(): Promise<{
        summaryChars: number;
        memoryChars: number;
        rawChars: number;
        archiveChars: number;
        rollouts: number;
        skills: number;
        notes: number;
    }>;
    /** Join a sub-path with a platform-agnostic separator for display. */
    static joinDisplay(...parts: string[]): string;
}
/** Whether a filename belongs to the memory summary artifacts. */
export declare function isMemoryFilename(name: string): boolean;
/** Validate that a candidate summary begins with the exact `v1` first line. */
export declare function ensureSummaryV1(content: string): string;
/** Convenience re-export so tests can reach the separator without a platform guess. */
export { sep as memoryPathSep };
//# sourceMappingURL=files.d.ts.map