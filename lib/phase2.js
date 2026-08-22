/** Phase 2: global consolidation into MEMORY.md and memory_summary.md. */
import { ensureSummaryV1 } from './files.js';
import { PHASE2_REASONING, resolveStageRoute } from './llm.js';
import { messageOf } from './util.js';
/** Automatic retry window after a failed consolidation (before the full cooldown). */
const FAILURE_RETRY_MS = 15 * 60_000;
export class Phase2Runner {
    deps;
    running;
    constructor(deps) {
        this.deps = deps;
    }
    /** Single-flight entry point; `force` bypasses the cooldown for manual runs. */
    run(force = false) {
        if (this.running !== undefined)
            return this.running;
        const promise = this.execute(force).finally(() => {
            this.running = undefined;
        });
        this.running = promise;
        return promise;
    }
    async execute(force) {
        const { state, files, config, consolidator, route } = this.deps;
        const cfg = config();
        const clock = this.deps.now ?? Date.now;
        const now = clock();
        if (!force) {
            // Ad hoc notes alone must also be able to wake consolidation, even when
            // an earlier run cleared the pending flag before the notes were merged.
            if (!state.pendingConsolidation && !(await files.hasPendingNotes())) {
                return { kind: 'skipped', reason: 'no-input' };
            }
            if (now - state.lastPhase2At < cfg.consolidationCooldownMs)
                return { kind: 'skipped', reason: 'cooldown' };
        }
        const baseRoute = route();
        if (baseRoute === undefined)
            return { kind: 'skipped', reason: 'no-route' };
        const modelRoute = await resolveStageRoute(this.deps.llm, baseRoute, PHASE2_REASONING);
        await files.ensureLayout();
        const raw = ((await files.readIfExists('raw_memories.md')) ?? '').trim();
        const noteEntries = await files.pendingNotes();
        const notes = noteEntries.map(entry => entry.content);
        if (!force && raw === '' && notes.length === 0) {
            state.setPendingConsolidation(false);
            return { kind: 'skipped', reason: 'no-input' };
        }
        const memory = (await files.readIfExists('MEMORY.md')) ?? '';
        const summary = (await files.readIfExists('memory_summary.md')) ?? '';
        const mode = memory.trim() === '' && summary.trim() === '' ? 'init' : 'incremental';
        const rolloutSummaries = (await files.listTree('rollout_summaries'))
            .filter(entry => entry.kind === 'file' && entry.path.endsWith('.md')).length;
        try {
            await this.deps.prepare?.();
            const readiness = consolidator.readiness();
            if (readiness !== 'ready')
                return { kind: 'skipped', reason: readiness };
            const artifacts = await consolidator.consolidate({
                mode,
                memoryRoot: files.root,
                pendingNotes: notes.length,
                rolloutSummaries,
                maxRawChars: cfg.maxRawChars,
                maxTokens: cfg.phase2MaxTokens,
                route: modelRoute,
            });
            await files.writeAtomic('MEMORY.md', artifacts.memoryMd.trimEnd() + '\n');
            await files.writeAtomic('memory_summary.md', ensureSummaryV1(artifacts.memorySummaryMd).trimEnd() + '\n');
            await files.rotateRaw();
            for (const entry of noteEntries) {
                await files.archiveNote(entry.path).catch(() => { });
            }
            state.recordPhase2(now);
            state.setPendingConsolidation(false);
            return { kind: 'consolidated', mode };
        }
        catch (error) {
            // Keep the pending flag and schedule an automatic retry in ~15 minutes
            // instead of freezing behind the full cooldown; manual runs stay available.
            const retryAt = Math.max(0, now - cfg.consolidationCooldownMs + FAILURE_RETRY_MS);
            const effort = modelRoute.reasoningEffort === undefined ? '' : `, reasoning=${modelRoute.reasoningEffort}`;
            const detail = `${messageOf(error)} (route=${modelRoute.provider}/${modelRoute.model}${effort})`;
            state.recordPhase2(retryAt, detail);
            return { kind: 'error', error: detail };
        }
    }
}
//# sourceMappingURL=phase2.js.map