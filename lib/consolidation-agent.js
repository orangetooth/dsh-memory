/** Restricted in-process Phase 2 agent built on the DSH subagent seam. */
import { PHASE2_OUTPUT_SCHEMA, PHASE2_SYSTEM, phase2User } from './prompts.js';
const READ_ONLY_MEMORY_TOOLS = ['memory_list', 'memory_read', 'memory_search'];
const REQUIRED_CAPABILITIES = ['outputSchema', 'depthLimit', 'toolFilter', 'persona'];
const DEFAULT_PROVIDER = 'spawn';
const DEFAULT_TIMEOUT_MS = 800_000;
const CONSOLIDATION_LABEL = 'memory-consolidation';
function supportsRestrictedRun(provider) {
    return provider !== undefined
        && provider.inheritsParentContext === false
        && REQUIRED_CAPABILITIES.every(capability => provider.capabilities[capability]);
}
function artifactsOf(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('整合 agent 未返回结构化对象');
    }
    const record = value;
    if (typeof record.memory_md !== 'string' || record.memory_md.trim() === '') {
        throw new Error('整合 agent 的结构化输出缺少非空 memory_md');
    }
    if (typeof record.memory_summary_md !== 'string' || record.memory_summary_md.trim() === '') {
        throw new Error('整合 agent 的结构化输出缺少非空 memory_summary_md');
    }
    return { memoryMd: record.memory_md, memorySummaryMd: record.memory_summary_md };
}
function isConsolidationAgent(agent, parent) {
    if (agent.session.header.parentSession !== parent.id)
        return false;
    return agent.session.events.some((event) => {
        if (typeof event !== 'object' || event === null)
            return false;
        const record = event;
        if (record.type !== 'subagent/descriptor' || typeof record.data !== 'object' || record.data === null)
            return false;
        return record.data.label === CONSOLIDATION_LABEL;
    });
}
function installReasoningEffort(runtime, parent, route) {
    if (route.reasoningEffort === undefined)
        return () => { };
    if (runtime === undefined)
        throw new Error('整合 agent 缺少 agent/request 推理等级注入接口');
    return runtime.on('agent/request', async ({ agent }, next) => {
        const config = await next();
        if (!isConsolidationAgent(agent, parent))
            return config;
        return { ...config, reasoningEffort: route.reasoningEffort };
    });
}
/**
 * Runs Codex-style consolidation as a fresh, one-shot DSH child agent.
 *
 * The child receives no parent transcript. Its global tools are reduced to the
 * three read-only memory tools; structured output is a child-scoped capability,
 * so the parent plugin remains the sole writer of MEMORY.md and the summary.
 */
export class HarnessConsolidationAgent {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    readiness() {
        if (this.deps.parent() === undefined)
            return 'no-agent';
        const provider = this.deps.subagents.getProvider(this.deps.providerName ?? DEFAULT_PROVIDER);
        return supportsRestrictedRun(provider) ? 'ready' : 'no-provider';
    }
    async consolidate(request) {
        const parent = this.deps.parent();
        if (parent === undefined)
            throw new Error('整合需要一个存活的 root agent 作为受限子 agent 的父级');
        const providerName = this.deps.providerName ?? DEFAULT_PROVIDER;
        const provider = this.deps.subagents.getProvider(providerName);
        if (!supportsRestrictedRun(provider)) {
            throw new Error(`subagent provider "${providerName}" 不支持 fresh context、persona、toolFilter、depthLimit 与 outputSchema`);
        }
        const disposeReasoning = installReasoningEffort(this.deps.agentRequests, parent, request.route);
        const signal = AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        let run;
        try {
            run = await this.deps.subagents.start(providerName, {
                label: CONSOLIDATION_LABEL,
                parent,
                signal,
                prompt: [{ type: 'text', text: phase2User(request) }],
                agentOptions: {
                    provider: request.route.provider,
                    model: request.route.model,
                    maxTokens: request.maxTokens,
                },
                outputSchema: PHASE2_OUTPUT_SCHEMA,
                maxDepth: 1,
                toolFilter: { allow: READ_ONLY_MEMORY_TOOLS },
                persona: PHASE2_SYSTEM,
            });
            const result = await run.result;
            if (result.stopReason !== 'completed') {
                throw new Error(`整合 agent 未正常完成（stopReason=${result.stopReason}）`);
            }
            return artifactsOf(result.structured);
        }
        finally {
            disposeReasoning();
            if (run !== undefined)
                await run.dispose();
        }
    }
}
export { CONSOLIDATION_LABEL, READ_ONLY_MEMORY_TOOLS };
//# sourceMappingURL=consolidation-agent.js.map