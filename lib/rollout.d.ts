/** Session-log reading: filtering, rendering, secret redaction, candidate selection. */
import type { SessionClaim, SessionHeaderLite } from './types.js';
export declare function redactSecrets(text: string): string;
/** Render one session event into a transcript line, or skip it. */
export declare function renderEvent(event: unknown): string | undefined;
export interface TranscriptOptions {
    maxTranscriptChars: number;
}
/** Render a session event log into a bounded, redacted transcript. */
export declare function renderTranscript(events: readonly unknown[], options: TranscriptOptions): {
    text: string;
    eventCount: number;
};
export interface SelectionOptions {
    now: () => number;
    maxAgeDays: number;
    maxPerRun: number;
    retryLimit: number;
    recheckIntervalMs: number;
}
export interface SelectionResult {
    candidates: SessionHeaderLite[];
    /** Sessions beyond the age window that were never processed; mark them no-op. */
    stale: SessionHeaderLite[];
}
/**
 * Choose which sessions Phase 1 should extract next:
 * root sessions only, skip processed ones, age out old ones,
 * honor retry backoff, and cap the batch.
 */
export declare function selectCandidates(headers: readonly SessionHeaderLite[], claimOf: (id: string) => SessionClaim | undefined, options: SelectionOptions): SelectionResult;
//# sourceMappingURL=rollout.d.ts.map