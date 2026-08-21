/** LLM call helpers: streaming text collection, JSON/fence parsing, route resolution. */

import { randomUUID } from 'node:crypto'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  ReasoningEffortId,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Config } from './config.js'

export interface LlmRuntime {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
}

export interface ModelRoute {
  provider: string
  model: string
  /** Adapter-owned effort selected for this memory stage. */
  reasoningEffort?: ReasoningEffortId
}

export type MemoryStageReasoning = 'low' | 'medium'

/** Codex uses low for per-session extraction and medium for consolidation. */
export const PHASE1_REASONING: MemoryStageReasoning = 'low'
export const PHASE2_REASONING: MemoryStageReasoning = 'medium'

const REASONING_RANK: Readonly<Record<string, number>> = {
  off: 0,
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 7,
}

/**
 * Translate Codex's stage effort onto the exact route's adapter-owned levels.
 * Exact matches win; otherwise the nearest known level wins, with a higher
 * level breaking ties so extraction quality is not silently traded for `off`.
 */
export async function resolveStageRoute(
  runtime: LlmRuntime,
  route: ModelRoute,
  target: MemoryStageReasoning,
  signal?: AbortSignal,
): Promise<ModelRoute> {
  const info = await runtime.resolveModelInfo(route.provider, route.model, signal)
  const reasoning = info.reasoning
  if (reasoning === undefined || reasoning.efforts.length === 0) return route
  const exact = reasoning.efforts.find(effort => String(effort.id) === target)
  if (exact !== undefined) return { ...route, reasoningEffort: exact.id }

  const targetRank = REASONING_RANK[target]!
  const ranked = reasoning.efforts
    .flatMap((effort) => {
      const rank = REASONING_RANK[String(effort.id)]
      return rank === undefined ? [] : [{ effort, rank }]
    })
    .sort((left, right) => {
      const distance = Math.abs(left.rank - targetRank) - Math.abs(right.rank - targetRank)
      return distance !== 0 ? distance : right.rank - left.rank
    })
  const selected = ranked[0]?.effort
    ?? reasoning.efforts.find(effort => effort.id === reasoning.defaultEffort)
    ?? reasoning.efforts.find(effort => String(effort.id) !== 'off')
    ?? reasoning.efforts[0]
  return selected === undefined ? route : { ...route, reasoningEffort: selected.id }
}

export class LlmCallError extends Error {
  constructor(
    readonly kind: 'error' | 'aborted' | 'max-tokens' | 'empty' | 'oversize' | 'tool-calls' | 'invalid-json',
    message: string,
  ) {
    super(message)
    this.name = 'LlmCallError'
  }
}

export interface CollectedText {
  text: string
  /** True when the finish reason was max-tokens: the response may be truncated. */
  truncated: boolean
}

/** One tool call produced by the model, with raw JSON arguments. */
export interface CollectedCall {
  name: string
  arguments: string
}

export interface CollectedResponse extends CollectedText {
  /** Tool calls produced by the model (tool-call blocks plus deltas). */
  calls: CollectedCall[]
}

/**
 * Collect a full streaming response: text plus tool calls.
 * Truncation (max-tokens) is reported rather than thrown.
 */
export async function collectResponse(runtime: LlmRuntime, options: GenerateOptions, maxChars = 400_000): Promise<CollectedResponse> {
  const textByIndex = new Map<number, string>()
  const callByName = new Map<string, CollectedCall>()
  const callIndex = new Map<number, string>()
  let finish: Extract<StreamChunk, { type: 'finish' }>['reason'] | undefined
  let size = 0
  const accumulate = (amount: number): void => {
    size += amount
    if (size > maxChars) throw new LlmCallError('oversize', `model response exceeded ${maxChars} characters`)
  }
  for await (const chunk of runtime.stream(options)) {
    if (chunk.type === 'text-delta') {
      textByIndex.set(chunk.index, (textByIndex.get(chunk.index) ?? '') + chunk.text)
      accumulate(chunk.text.length)
    } else if (chunk.type === 'tool-call-delta') {
      const name = chunk.name ?? callIndex.get(chunk.index)
      if (name !== undefined) callIndex.set(chunk.index, name)
      const existing = name === undefined ? undefined : callByName.get(name)
      if (existing !== undefined) {
        existing.arguments += chunk.argumentsDelta
      } else if (name !== undefined) {
        callByName.set(name, { name, arguments: chunk.argumentsDelta })
      }
      accumulate(chunk.argumentsDelta.length)
    } else if (chunk.type === 'block-end') {
      if (chunk.block.type === 'text') {
        textByIndex.set(chunk.index, chunk.block.text)
        size = [...textByIndex.values()].reduce((total, text) => total + text.length, 0)
        if (size > maxChars) throw new LlmCallError('oversize', `model response exceeded ${maxChars} characters`)
      } else if (chunk.block.type === 'tool-call') {
        callByName.set(chunk.block.name, { name: chunk.block.name, arguments: chunk.block.arguments })
      }
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    }
  }
  if (finish === undefined) throw new LlmCallError('empty', 'model response has no finish reason')
  if (finish.kind === 'error' || finish.kind === 'aborted') throw new LlmCallError(finish.kind, finish.failure.message)
  const text = [...textByIndex.entries()].sort(([left], [right]) => left - right).map(([, value]) => value).join('')
  return { text, calls: [...callByName.values()], truncated: finish.kind === 'max-tokens' }
}

/** Collect a full text response; reports max-tokens truncation instead of throwing. */
export async function collectTextDetails(runtime: LlmRuntime, options: GenerateOptions, maxChars = 400_000): Promise<CollectedText> {
  const { text, truncated } = await collectResponse(runtime, options, maxChars)
  return { text, truncated }
}

/** Collect a full text response, failing on any abnormal finish including truncation. */
export async function collectText(runtime: LlmRuntime, options: GenerateOptions, maxChars = 400_000): Promise<string> {
  const { text, truncated } = await collectTextDetails(runtime, options, maxChars)
  if (truncated) throw new LlmCallError('max-tokens', 'model response reached its output limit')
  return text
}

/** Parse the raw JSON arguments of one collected tool call. */
export function parseCallArguments(call: CollectedCall | undefined): Record<string, unknown> {
  if (call === undefined || call.arguments.trim() === '') throw new LlmCallError('invalid-json', 'tool call has empty arguments')
  let parsed: unknown
  try {
    parsed = JSON.parse(call.arguments)
  } catch {
    throw new LlmCallError('invalid-json', `tool call "${call.name}" arguments are not valid JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LlmCallError('invalid-json', `tool call "${call.name}" arguments are not a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/** Strip a ```json fence when present. */
export function stripFences(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed)
  return fenced?.[1]?.trim() ?? trimmed
}

/** Extract the first balanced top-level JSON object from model output. */
export function extractJsonObject(text: string): Record<string, unknown> {
  const cleaned = stripFences(text).trim()
  const start = cleaned.indexOf('{')
  if (start < 0) throw new LlmCallError('invalid-json', 'model output contains no JSON object')
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < cleaned.length; i += 1) {
    const char = cleaned[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const parsed: unknown = JSON.parse(cleaned.slice(start, i + 1))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new LlmCallError('invalid-json', 'JSON root is not an object')
        }
        return parsed as Record<string, unknown>
      }
    }
  }
  throw new LlmCallError('invalid-json', 'unbalanced JSON in model output')
}

/** Parse labeled fenced blocks into a label → body map. */
export function parseFencedBlocks(text: string): Map<string, string> {
  const blocks = new Map<string, string>()
  const pattern = /```([^\n`]*)\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const label = (match[1] ?? '').trim().toLowerCase()
    const body = (match[2] ?? '').trim()
    if (body === '') continue
    blocks.set(label === '' ? `unnamed-${blocks.size}` : label, body)
  }
  return blocks
}

/** Pick the block whose label matches one of the given names. */
export function pickBlock(blocks: ReadonlyMap<string, string>, labels: readonly string[]): string | undefined {
  for (const label of labels) {
    const body = blocks.get(label)
    if (body !== undefined) return body
  }
  return undefined
}

/** Resolve the pipeline's model route: explicit config first, then the deployment default. */
export function resolveRoute(config: Config, defaultSelection: unknown): ModelRoute | undefined {
  if (config.provider.trim() !== '' && config.model.trim() !== '') {
    return { provider: config.provider, model: config.model }
  }
  const selection = defaultSelection as { provider?: unknown; model?: unknown } | undefined
  if (typeof selection?.provider === 'string' && selection.provider !== ''
    && typeof selection.model === 'string' && selection.model !== '') {
    return { provider: selection.provider, model: selection.model }
  }
  return undefined
}

/** Build a plugin-owned GenerateOptions for one pipeline call. */
export function generateOptions(
  route: ModelRoute,
  system: string,
  userText: string,
  maxTokens: number,
  signal?: AbortSignal,
  tools?: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>,
): GenerateOptions {
  return {
    provider: route.provider,
    model: route.model,
    system,
    temperature: 0,
    maxTokens,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    ...(signal === undefined ? {} : { signal }),
    ...(tools === undefined ? {} : { tools: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }),
    messages: [{
      id: `dsh-memory-${randomUUID()}` as never,
      role: 'user',
      source: { kind: 'plugin', plugin: '@nanmicoder/dsh-memory' },
      content: [{ type: 'text', text: userText }],
    }],
  }
}
