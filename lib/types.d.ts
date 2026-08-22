/** Shared structural types for the memory plugin. */
import type { Config } from './config.js';
/** One durable extraction claim for a session (Codex stage-1 job parity). */
export interface SessionClaim {
    status: 'done' | 'noop' | 'failed' | 'running';
    /** Epoch milliseconds of the last state transition. */
    at: number;
    /** Extraction attempts so far; drives retry eligibility. */
    attempts: number;
    /** Rollout slug produced by a successful extraction. */
    slug?: string;
    /** Last failure message for diagnosis. */
    error?: string;
    /** Highest event seq already captured; later growth becomes a delta extraction. */
    lastSeq?: number;
    /** Number of rollout parts already written for this session. */
    parts?: number;
}
/** Durable plugin state persisted through the storage hub KV backend. */
export interface MemoryState {
    v: 1;
    processed: Record<string, SessionClaim>;
    /** Stable identity of the plugin-owned root session for Phase 2 children. */
    memoryParentSessionId?: string;
    lastPhase1At: number;
    lastPhase2At: number;
    phase2Error?: string;
    pendingConsolidation: boolean;
    overrides: Partial<Config>;
}
/** Minimal structural view of a DSH session header. */
export interface SessionHeaderLite {
    id: string;
    createdAt?: number;
    cwd?: string;
    origin?: 'subagent';
    parentSession?: string;
}
/** Minimal structural view of one session log observation. */
export interface SessionLogLite {
    session: SessionHeaderLite;
    events: unknown[];
}
/** Session-log read surface the pipeline depends on. */
export interface SessionReader {
    listSessions(): Promise<SessionHeaderLite[]>;
    readSession(id: string): Promise<SessionLogLite>;
}
/** File entry surfaced by `memory_list` and the settings page. */
export interface FileEntry {
    path: string;
    kind: 'file' | 'dir';
    size: number;
    modifiedAt: number;
}
//# sourceMappingURL=types.d.ts.map