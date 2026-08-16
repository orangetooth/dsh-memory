/** Phase 2: global consolidation into MEMORY.md and memory_summary.md. */

import type { MemoryStateStore } from './bookkeeping.js'
import type { Config } from './config.js'
import type { MemoryFiles } from './files.js'
import { ensureSummaryV1 } from './files.js'
import type { LlmRuntime, ModelRoute } from './llm.js'
import { collectResponse, generateOptions, parseCallArguments, parseFencedBlocks, pickBlock } from './llm.js'
import { PHASE2_SYSTEM, PHASE2_TOOL, phase2User } from './prompts.js'
import { messageOf } from './util.js'

export type Phase2Outcome =
  | { kind: 'consolidated'; mode: 'init' | 'incremental' }
  | { kind: 'skipped'; reason: 'cooldown' | 'no-input' | 'no-route' }
  | { kind: 'error'; error: string }

export interface Phase2Deps {
  llm: LlmRuntime
  state: MemoryStateStore
  files: MemoryFiles
  config: () => Config
  route: () => ModelRoute | undefined
  /** Injectable clock for tests. */
  now?: () => number
}

/** Automatic retry window after a failed consolidation (before the full cooldown). */
const FAILURE_RETRY_MS = 15 * 60_000

export class Phase2Runner {
  private running: Promise<Phase2Outcome> | undefined

  constructor(private readonly deps: Phase2Deps) {}

  /** Single-flight entry point; `force` bypasses the cooldown for manual runs. */
  run(force = false): Promise<Phase2Outcome> {
    if (this.running !== undefined) return this.running
    const promise = this.execute(force).finally(() => {
      this.running = undefined
    })
    this.running = promise
    return promise
  }

  private async execute(force: boolean): Promise<Phase2Outcome> {
    const { state, files, config, llm, route } = this.deps
    const cfg = config()
    const clock = this.deps.now ?? Date.now
    const now = clock()
    if (!force) {
      // Ad hoc notes alone must also be able to wake consolidation, even when
      // an earlier run cleared the pending flag before the notes were merged.
      if (!state.pendingConsolidation && !(await files.hasPendingNotes())) {
        return { kind: 'skipped', reason: 'no-input' }
      }
      if (now - state.lastPhase2At < cfg.consolidationCooldownMs) return { kind: 'skipped', reason: 'cooldown' }
    }
    const modelRoute = route()
    if (modelRoute === undefined) return { kind: 'skipped', reason: 'no-route' }
    await files.ensureLayout()
    const raw = ((await files.readIfExists('raw_memories.md')) ?? '').trim()
    const noteEntries = await files.pendingNotes()
    const notes = noteEntries.map(entry => entry.content)
    if (!force && raw === '' && notes.length === 0) {
      state.setPendingConsolidation(false)
      return { kind: 'skipped', reason: 'no-input' }
    }
    const memory = (await files.readIfExists('MEMORY.md')) ?? ''
    const summary = (await files.readIfExists('memory_summary.md')) ?? ''
    const mode: 'init' | 'incremental' = memory.trim() === '' && summary.trim() === '' ? 'init' : 'incremental'
    const rolloutIndex = await files.rolloutIndex(120)
    const userText = phase2User({
      mode,
      memory,
      summary,
      raw: raw.slice(-cfg.maxRawChars),
      notes,
      rolloutIndex,
    })
    try {
      const response = await collectResponse(
        llm,
        generateOptions(modelRoute, PHASE2_SYSTEM, userText, cfg.phase2MaxTokens, undefined, [PHASE2_TOOL]),
        800_000,
      )
      // Structured tool call first; fenced text blocks remain a fallback for
      // models that ignore the tool schema.
      let nextMemory: string | undefined
      let nextSummary: string | undefined
      const toolCall = response.calls.find(call => call.name === 'memory_write')
      if (toolCall !== undefined) {
        const args = parseCallArguments(toolCall)
        if (typeof args.memory_md === 'string' && args.memory_md.trim() !== '') nextMemory = args.memory_md
        if (typeof args.memory_summary_md === 'string' && args.memory_summary_md.trim() !== '') nextSummary = args.memory_summary_md
      }
      if (nextMemory === undefined || nextSummary === undefined) {
        const blocks = parseFencedBlocks(response.text)
        nextMemory = pickBlock(blocks, ['memory.md', 'mem.md'])
        nextSummary = pickBlock(blocks, ['memory_summary.md', 'memory-summary.md', 'summary.md'])
      }
      if (nextMemory === undefined || nextSummary === undefined) {
        throw new Error('整合输出缺少 memory_write 工具调用或带标签的代码块（```MEMORY.md 与 ```memory_summary.md）')
      }
      await files.writeAtomic('MEMORY.md', nextMemory.trimEnd() + '\n')
      await files.writeAtomic('memory_summary.md', ensureSummaryV1(nextSummary).trimEnd() + '\n')
      await files.rotateRaw()
      for (const entry of noteEntries) {
        await files.archiveNote(entry.path).catch(() => {})
      }
      state.recordPhase2(now)
      state.setPendingConsolidation(false)
      return { kind: 'consolidated', mode }
    } catch (error: unknown) {
      // Keep the pending flag and schedule an automatic retry in ~15 minutes
      // instead of freezing behind the full cooldown; manual runs stay available.
      const retryAt = Math.max(0, now - cfg.consolidationCooldownMs + FAILURE_RETRY_MS)
      const detail = `${messageOf(error)} (route=${modelRoute.provider}/${modelRoute.model})`
      state.recordPhase2(retryAt, detail)
      return { kind: 'error', error: detail }
    }
  }
}
