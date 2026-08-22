/**
 * dsh-memory — long-term memory system for DeepSeek Harness.
 *
 * Two-phase pipeline adapted from Codex memories onto DSH primitives:
 * Phase 1 extracts durable memories from root session logs (sessionQuery /
 * sessionPersistence), Phase 2 consolidates them into MEMORY.md and
 * memory_summary.md. The summary is injected through systemPrompt, and four
 * memory tools serve on-demand retrieval. Bookkeeping (claims, cooldown,
 * pending flag, overrides) persists through the storage hub KV backend.
 */
import { MemoryStateStore } from './bookkeeping.js';
import { HarnessConsolidationAgent } from './consolidation-agent.js';
import { Config, resolveConfig } from './config.js';
import { MemoryFiles } from './files.js';
import { MemoryInjection } from './inject.js';
import { resolveRoute } from './llm.js';
import { resolveMemoryRoot } from './paths.js';
import { MemoryParent } from './memory-parent.js';
import { Phase1Runner } from './phase1.js';
import { Phase2Runner } from './phase2.js';
import { registerRpc } from './rpc.js';
import { registerMemoryTools } from './tools.js';
import { messageOf } from './util.js';
export const name = 'dsh-memory';
export const inject = ['agents', 'llm', 'timer', 'subagents', 'tools'];
export { Config, DEFAULTS, clampOverrides, OVERRIDABLE_KEYS, resolveConfig } from './config.js';
export { MemoryStateStore } from './bookkeeping.js';
export { CONSOLIDATION_LABEL, HarnessConsolidationAgent, READ_ONLY_MEMORY_TOOLS, } from './consolidation-agent.js';
export { MemoryFiles, ensureSummaryV1 } from './files.js';
export { MemoryInjection, buildSectionText, GUIDE_ORDER } from './inject.js';
export { MEMORY_PARENT_ID_PREFIX, MEMORY_PARENT_TITLE, MemoryParent, } from './memory-parent.js';
export { collectResponse, collectText, collectTextDetails, extractJsonObject, generateOptions, LlmCallError, parseCallArguments, parseFencedBlocks, PHASE1_REASONING, PHASE2_REASONING, pickBlock, resolveRoute, resolveStageRoute, stripFences, } from './llm.js';
export { defaultMemoryRoot, isWithin, resolveMemoryRoot, sanitizeSlug } from './paths.js';
export { Phase1Runner } from './phase1.js';
export { Phase2Runner } from './phase2.js';
export { PHASE1_SYSTEM, PHASE1_TOOL, PHASE2_OUTPUT_SCHEMA, PHASE2_SYSTEM, PHASE2_TOOL, phase1User, phase2User } from './prompts.js';
export { redactSecrets, renderEvent, renderTranscript, selectCandidates } from './rollout.js';
export { registerRpc } from './rpc.js';
export { registerMemoryTools } from './tools.js';
export { headTail, messageOf } from './util.js';
export function apply(ctx, config = {}) {
    const base = resolveConfig(config);
    const llm = ctx.get('llm');
    if (llm === undefined)
        throw new Error('dsh-memory requires the llm service');
    const timer = ctx.get('timer');
    if (timer === undefined)
        throw new Error('dsh-memory requires the timer service');
    const subagents = ctx.get('subagents');
    if (subagents === undefined)
        throw new Error('dsh-memory requires the subagents service');
    const agents = ctx.get('agents');
    if (agents === undefined)
        throw new Error('dsh-memory requires the agents service');
    const getKv = () => {
        const storage = ctx.get('storage');
        const backend = storage?.backend?.get?.('json');
        return backend?.kv;
    };
    const state = new MemoryStateStore(getKv);
    const files = new MemoryFiles(resolveMemoryRoot(base.memoryRoot));
    const memoryParent = new MemoryParent(agents, state, files.root);
    const configNow = () => resolveConfig(base, state.snapshot().overrides);
    const sessionReader = () => {
        const query = ctx.get('sessionQuery');
        if (query?.listSessions !== undefined && query.readSession !== undefined) {
            return {
                listSessions: async () => (await query.listSessions())
                    .map(record => record.header)
                    .filter(header => header.id !== state.memoryParentSessionId),
                readSession: async (id) => {
                    const snapshot = await query.readSession(id);
                    return { session: snapshot.session, events: snapshot.events };
                },
            };
        }
        const persistence = ctx.get('sessionPersistence');
        if (persistence?.list !== undefined && persistence.load !== undefined) {
            return {
                listSessions: async () => (await persistence.list())
                    .filter(header => header.id !== state.memoryParentSessionId),
                readSession: async (id) => {
                    const inspection = await persistence.load(id);
                    return {
                        session: (inspection.header ?? { id }),
                        events: inspection.events ?? [],
                    };
                },
            };
        }
        return undefined;
    };
    const routeNow = () => {
        const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
        return resolveRoute(configNow(), selection);
    };
    const consolidator = new HarnessConsolidationAgent({
        subagents,
        parent: () => memoryParent.agent,
        agentRequests: ctx,
    });
    const phase1 = new Phase1Runner({ llm, state, files, sessions: sessionReader, config: configNow, route: routeNow });
    const phase2 = new Phase2Runner({
        consolidator,
        llm,
        state,
        files,
        config: configNow,
        route: routeNow,
        prepare: async () => {
            await stateReady;
            await memoryParent.ensure();
        },
    });
    const injection = new MemoryInjection(files, configNow);
    const log = (text) => {
        console.error(`[dsh-memory] ${text}`);
    };
    const runPipeline = async () => {
        await stateReady;
        const cfg = configNow();
        if (!cfg.enabled)
            return;
        await memoryParent.ensure().catch(error => log(`memory parent: ${messageOf(error)}`));
        const summary = await phase1.run();
        if (summary.done > 0 || state.pendingConsolidation || await files.hasPendingNotes()) {
            await phase2.run(false);
        }
        await injection.reload();
        await state.flush();
    };
    let scheduled = false;
    const runSoon = () => {
        if (scheduled)
            return;
        scheduled = true;
        timer.timeout(() => {
            scheduled = false;
            void runPipeline().catch(error => log(`pipeline: ${messageOf(error)}`));
        }, 4_000);
    };
    const triggerFromTurn = () => {
        if (!configNow().enabled)
            return;
        const debounced = timer.debounce(runSoon, configNow().idleDebounceMs);
        debounced();
    };
    // Root-session lifecycle: Codex wakes the pipeline at root session start;
    // we additionally schedule after each root turn stops (debounced = idle guard).
    let lastSessionStartTrigger = 0;
    const isRoot = (agent) => agent.session.header.origin !== 'subagent' && !memoryParent.matches(agent);
    ctx.on('agent/turn-stopping', ({ agent }) => {
        if (!isRoot(agent))
            return;
        triggerFromTurn();
    });
    ctx.on('agent/session-start', ({ agent }) => {
        if (!isRoot(agent))
            return;
        const now = Date.now();
        if (now - lastSessionStartTrigger < 60_000)
            return;
        lastSessionStartTrigger = now;
        runSoon();
    });
    ctx.on('agent/disposed', ({ agent }) => {
        memoryParent.noticeDisposed(agent);
    });
    // Optional services: react to late mounting through the cordis service event.
    const whenService = (serviceName, use) => {
        const attempt = () => {
            const service = ctx.get(serviceName);
            if (service === undefined)
                return false;
            use(service);
            return true;
        };
        if (attempt())
            return;
        ctx.on('internal/service', (payload) => {
            const received = typeof payload === 'string' ? payload : payload?.name;
            if (received === serviceName)
                attempt();
        });
    };
    let toolsDisposer;
    ctx.effect(() => () => toolsDisposer?.());
    whenService('tools', registry => {
        if (toolsDisposer !== undefined)
            return;
        toolsDisposer = registerMemoryTools(registry, files, state);
    });
    whenService('systemPrompt', systemPrompt => injection.install(systemPrompt));
    whenService('webServer', webServer => {
        const disposeRpc = registerRpc(webServer, {
            state, files, llm, config: configNow, route: routeNow, phase1, phase2, runPipeline,
        });
        ctx.effect(() => disposeRpc);
    });
    ctx.effect(() => async () => {
        injection.dispose();
        await memoryParent.dispose();
        await state.dispose();
    });
    const stateReady = state.init();
    void (async () => {
        try {
            await stateReady;
            await files.ensureLayout();
            await memoryParent.ensure();
            await injection.reload();
            if (configNow().enabled)
                runSoon();
        }
        catch (error) {
            log(`init: ${messageOf(error)}`);
        }
    })();
}
//# sourceMappingURL=index.js.map