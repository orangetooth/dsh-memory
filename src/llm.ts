/** LLM call helpers: streaming text collection, JSON/fence parsing, route resolution. */

import { randomUUID } from 'node:crypto'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Config } from './config.js'

export interface LlmRuntime {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

export interface ModelRoute {
  provider: string
  model: string
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

/** Collect a full text response; reports max-tokens truncation instead of throwing. */
export async function collectTextDetails(runtime: LlmRuntime, options: GenerateOptions, maxChars = 300_000): Promise<CollectedText> {
  const textByIndex = new Map<number, string>()
  let finish: Extract<StreamChunk, { type: 'finish' }>['reason'] | undefined
  let size = 0
  for await (const chunk of runtime.stream(options)) {
    if (chunk.type === 'text-delta') {
      const value = (textByIndex.get(chunk.index) ?? '') + chunk.text
      textByIndex.set(chunk.index, value)
      size += chunk.text.length
    } else if (chunk.type === 'block-end') {
      if (chunk.block.type === 'tool-call') throw new LlmCallError('tool-calls', 'model unexpectedly requested a tool')
      if (chunk.block.type === 'text') {
        textByIndex.set(chunk.index, chunk.block.text)
        size = [...textByIndex.values()].reduce((total, text) => total + text.length, 0)
      }
    } else if (chunk.type === 'tool-call-delta') {
      throw new LlmCallError('tool-calls', 'model unexpectedly requested a tool')
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    }
    if (size > maxChars) throw new LlmCallError('oversize', `model response exceeded ${maxChars} characters`)
  }
  if (finish === undefined) throw new LlmCallError('empty', 'model response has no finish reason')
  if (finish.kind === 'error' || finish.kind === 'aborted') throw new LlmCallError(finish.kind, finish.failure.message)
  if (finish.kind === 'tool-calls') throw new LlmCallError('tool-calls', 'model unexpectedly requested a tool')
  const text = [...textByIndex.entries()].sort(([left], [right]) => left - right).map(([, value]) => value).join('')
  return { text, truncated: finish.kind === 'max-tokens' }
}

/** Collect a full text response, failing on any abnormal finish including truncation. */
export async function collectText(runtime: LlmRuntime, options: GenerateOptions, maxChars = 300_000): Promise<string> {
  const { text, truncated } = await collectTextDetails(runtime, options, maxChars)
  if (truncated) throw new LlmCallError('max-tokens', 'model response reached its output limit')
  return text
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
): GenerateOptions {
  return {
    provider: route.provider,
    model: route.model,
    system,
    temperature: 0,
    maxTokens,
    ...(signal === undefined ? {} : { signal }),
    messages: [{
      id: `dsh-memory-${randomUUID()}` as never,
      role: 'user',
      source: { kind: 'plugin', plugin: '@nanmicoder/dsh-memory' },
      content: [{ type: 'text', text: userText }],
    }],
  }
}
