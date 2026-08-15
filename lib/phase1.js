/** Phase 1: per-session extraction into rollout summaries and raw memories. */
import { collectTextDetails, extractJsonObject, generateOptions, LlmCallError } from './llm.js';
import { sanitizeSlug } from './paths.js';
import { PHASE1_SYSTEM, phase1User } from './prompts.js';
import { redactSecrets, renderTranscript, selectCandidates } from './rollout.js';
import { messageOf } from './util.js';
function rolloutFrontmatter(header) {
    const lines = [
        '<!--',
        `  session: ${header.id}`,
        header.cwd === undefined ? '' : `  cwd: ${header.cwd}`,
        `  processed_at: ${new Date().toISOString()}`,
        '-->',
        '',
    ];
    return lines.filter(line => line !== '').join('\n');
}
function rawBlock(header, slug) {
    return `<!-- dsh-memory raw: session=${header.id} slug=${slug} cwd=${header.cwd ?? ''} at=${new Date().toISOString()} -->\n`;
}
export class Phase1Runner {
    deps;
    running;
    constructor(deps) {
        this.deps = deps;
    }
    /** Single-flight entry point used by the scheduler and the settings page. */
    run() {
        if (this.running !== undefined)
            return this.running;
        const promise = this.execute().finally(() => {
            this.running = undefined;
        });
        this.running = promise;
        return promise;
    }
    async execute() {
        const { state, files, config } = this.deps;
        await files.ensureLayout();
        const reader = this.deps.sessions();
        if (reader === undefined)
            return { selected: 0, done: 0, noop: 0, failed: 0, skippedNoRoute: false, skippedNoSessions: true };
        const route = this.deps.route();
        if (route === undefined)
            return { selected: 0, done: 0, noop: 0, failed: 0, skippedNoRoute: true, skippedNoSessions: false };
        const clock = this.deps.now ?? Date.now;
        const cfg = config();
        const headers = await reader.listSessions();
        const selection = selectCandidates(headers, id => state.processedOf(id), {
            now: clock,
            maxAgeDays: cfg.maxRolloutAgeDays,
            maxPerRun: cfg.maxRolloutsPerRun,
            retryLimit: cfg.retryLimit,
        });
        for (const header of selection.stale)
            state.claimNoop(header.id);
        let done = 0;
        let noop = 0;
        let failed = 0;
        let index = 0;
        const workers = Array.from({ length: Math.max(1, cfg.extractionConcurrency) }, async () => {
            while (index < selection.candidates.length) {
                const header = selection.candidates[index++];
                const outcome = await this.extractOne(header, route, cfg);
                if (outcome === 'done')
                    done += 1;
                else if (outcome === 'noop')
                    noop += 1;
                else
                    failed += 1;
            }
        });
        await Promise.all(workers);
        if (done > 0)
            state.setPendingConsolidation(true);
        state.recordPhase1(clock());
        return { selected: selection.candidates.length, done, noop, failed, skippedNoRoute: false, skippedNoSessions: false };
    }
    async extractOne(header, route, cfg) {
        const { state, files, llm } = this.deps;
        state.claimRunning(header.id);
        try {
            const reader = this.deps.sessions();
            if (reader === undefined)
                throw new Error('session reader unavailable');
            const log = await reader.readSession(header.id);
            const rendered = renderTranscript(log.events, { maxTranscriptChars: cfg.maxTranscriptChars });
            if (rendered.eventCount < cfg.minSessionEvents || rendered.text.trim() === '') {
                state.claimNoop(header.id);
                return 'noop';
            }
            const userText = phase1User({
                sessionId: header.id,
                ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
                ...(header.createdAt === undefined ? {} : { createdAt: header.createdAt }),
            }, rendered.text);
            const response = await collectTextDetails(llm, generateOptions(route, PHASE1_SYSTEM, userText, cfg.phase1MaxTokens), 40_000);
            let raw;
            try {
                // A truncated but structurally complete JSON response is still usable.
                raw = extractJsonObject(response.text);
            }
            catch (jsonError) {
                if (response.truncated) {
                    throw new LlmCallError('max-tokens', `output truncated and JSON incomplete: ${messageOf(jsonError)}`);
                }
                throw jsonError;
            }
            const fields = this.normalizeFields(raw);
            if (fields.rawMemory === '' && fields.rolloutSummary === '') {
                state.claimNoop(header.id);
                return 'noop';
            }
            const slug = await files.uniqueRolloutSlug(sanitizeSlug(fields.rolloutSlug, `session-${header.id.slice(-8)}`), header.id);
            await files.writeAtomic(`rollout_summaries/${slug}.md`, rolloutFrontmatter(header) + fields.rolloutSummary.trimEnd() + '\n');
            await files.appendText('raw_memories.md', rawBlock(header, slug) + fields.rawMemory.trimEnd() + '\n\n');
            state.claimDone(header.id, slug);
            return 'done';
        }
        catch (error) {
            state.claimFailed(header.id, `${messageOf(error)} (route=${route.provider}/${route.model})`);
            return 'failed';
        }
    }
    normalizeFields(raw) {
        const read = (key) => {
            const value = raw[key];
            return typeof value === 'string' ? value.trim() : '';
        };
        return {
            rawMemory: redactSecrets(read('raw_memory')).slice(0, 24_000),
            rolloutSummary: redactSecrets(read('rollout_summary')).slice(0, 40_000),
            rolloutSlug: read('rollout_slug').slice(0, 120),
        };
    }
}
//# sourceMappingURL=phase1.js.map