/** LLM call helpers: streaming text collection, JSON/fence parsing, route resolution. */
import { randomUUID } from 'node:crypto';
export class LlmCallError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.kind = kind;
        this.name = 'LlmCallError';
    }
}
/** Collect a full text response; reports max-tokens truncation instead of throwing. */
export async function collectTextDetails(runtime, options, maxChars = 300_000) {
    const textByIndex = new Map();
    let finish;
    let size = 0;
    for await (const chunk of runtime.stream(options)) {
        if (chunk.type === 'text-delta') {
            const value = (textByIndex.get(chunk.index) ?? '') + chunk.text;
            textByIndex.set(chunk.index, value);
            size += chunk.text.length;
        }
        else if (chunk.type === 'block-end') {
            if (chunk.block.type === 'tool-call')
                throw new LlmCallError('tool-calls', 'model unexpectedly requested a tool');
            if (chunk.block.type === 'text') {
                textByIndex.set(chunk.index, chunk.block.text);
                size = [...textByIndex.values()].reduce((total, text) => total + text.length, 0);
            }
        }
        else if (chunk.type === 'tool-call-delta') {
            throw new LlmCallError('tool-calls', 'model unexpectedly requested a tool');
        }
        else if (chunk.type === 'finish') {
            finish = chunk.reason;
        }
        if (size > maxChars)
            throw new LlmCallError('oversize', `model response exceeded ${maxChars} characters`);
    }
    if (finish === undefined)
        throw new LlmCallError('empty', 'model response has no finish reason');
    if (finish.kind === 'error' || finish.kind === 'aborted')
        throw new LlmCallError(finish.kind, finish.failure.message);
    if (finish.kind === 'tool-calls')
        throw new LlmCallError('tool-calls', 'model unexpectedly requested a tool');
    const text = [...textByIndex.entries()].sort(([left], [right]) => left - right).map(([, value]) => value).join('');
    return { text, truncated: finish.kind === 'max-tokens' };
}
/** Collect a full text response, failing on any abnormal finish including truncation. */
export async function collectText(runtime, options, maxChars = 300_000) {
    const { text, truncated } = await collectTextDetails(runtime, options, maxChars);
    if (truncated)
        throw new LlmCallError('max-tokens', 'model response reached its output limit');
    return text;
}
/** Strip a ```json fence when present. */
export function stripFences(text) {
    const trimmed = text.trim();
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
    return fenced?.[1]?.trim() ?? trimmed;
}
/** Extract the first balanced top-level JSON object from model output. */
export function extractJsonObject(text) {
    const cleaned = stripFences(text).trim();
    const start = cleaned.indexOf('{');
    if (start < 0)
        throw new LlmCallError('invalid-json', 'model output contains no JSON object');
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i += 1) {
        const char = cleaned[i];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (char === '\\')
                escaped = true;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"')
            inString = true;
        else if (char === '{')
            depth += 1;
        else if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                const parsed = JSON.parse(cleaned.slice(start, i + 1));
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                    throw new LlmCallError('invalid-json', 'JSON root is not an object');
                }
                return parsed;
            }
        }
    }
    throw new LlmCallError('invalid-json', 'unbalanced JSON in model output');
}
/** Parse labeled fenced blocks into a label → body map. */
export function parseFencedBlocks(text) {
    const blocks = new Map();
    const pattern = /```([^\n`]*)\n([\s\S]*?)```/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        const label = (match[1] ?? '').trim().toLowerCase();
        const body = (match[2] ?? '').trim();
        if (body === '')
            continue;
        blocks.set(label === '' ? `unnamed-${blocks.size}` : label, body);
    }
    return blocks;
}
/** Pick the block whose label matches one of the given names. */
export function pickBlock(blocks, labels) {
    for (const label of labels) {
        const body = blocks.get(label);
        if (body !== undefined)
            return body;
    }
    return undefined;
}
/** Resolve the pipeline's model route: explicit config first, then the deployment default. */
export function resolveRoute(config, defaultSelection) {
    if (config.provider.trim() !== '' && config.model.trim() !== '') {
        return { provider: config.provider, model: config.model };
    }
    const selection = defaultSelection;
    if (typeof selection?.provider === 'string' && selection.provider !== ''
        && typeof selection.model === 'string' && selection.model !== '') {
        return { provider: selection.provider, model: selection.model };
    }
    return undefined;
}
/** Build a plugin-owned GenerateOptions for one pipeline call. */
export function generateOptions(route, system, userText, maxTokens, signal) {
    return {
        provider: route.provider,
        model: route.model,
        system,
        temperature: 0,
        maxTokens,
        ...(signal === undefined ? {} : { signal }),
        messages: [{
                id: `dsh-memory-${randomUUID()}`,
                role: 'user',
                source: { kind: 'plugin', plugin: '@nanmicoder/dsh-memory' },
                content: [{ type: 'text', text: userText }],
            }],
    };
}
//# sourceMappingURL=llm.js.map