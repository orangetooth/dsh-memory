/** Phase 2: global consolidation into MEMORY.md and memory_summary.md. */

import type { MemoryStateStore } from './bookkeeping.js'
import type { Phase2Consolidator } from './consolidation-agent.js'
import type { Config } from './config.js'
import type { MemoryFiles } from './files.js'
import { ensureSummaryV1 } from './files.js'
import type { LlmRuntime, ModelRoute } from './llm.js'
import { PHASE2_REASONING, resolveStageRoute } from './llm.js'
import { messageOf } from './util.js'

export type Phase2Outcome =
  | { kind: 'consolidated'; mode: 'init' | 'incremental' }
  | { kind: 'skipped'; reason: 'cooldown' | 'no-input' | 'no-route' | 'no-agent' | 'no-provider' }
  | { kind: 'error'; error: string }

export interface Phase2Deps {
  consolidator: Phase2Consolidator
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
    const { state, files, config, consolidator, route } = this.deps
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
    const baseRoute = route()
    if (baseRoute === undefined) return { kind: 'skipped', reason: 'no-route' }
    const modelRoute = await resolveStageRoute(this.deps.llm, baseRoute, PHASE2_REASONING)
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
    const readiness = consolidator.readiness()
    if (readiness !== 'ready') return { kind: 'skipped', reason: readiness }
    const rolloutSummaries = (await files.listTree('rollout_summaries'))
      .filter(entry => entry.kind === 'file' && entry.path.endsWith('.md')).length
    try {
      const artifacts = await consolidator.consolidate({
        mode,
        memoryRoot: files.root,
        pendingNotes: notes.length,
        rolloutSummaries,
        maxRawChars: cfg.maxRawChars,
        maxTokens: cfg.phase2MaxTokens,
        route: modelRoute,
      })
      await files.writeAtomic('MEMORY.md', artifacts.memoryMd.trimEnd() + '\n')
      await files.writeAtomic('memory_summary.md', ensureSummaryV1(artifacts.memorySummaryMd).trimEnd() + '\n')
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
      const effort = modelRoute.reasoningEffort === undefined ? '' : `, reasoning=${modelRoute.reasoningEffort}`
      const detail = `${messageOf(error)} (route=${modelRoute.provider}/${modelRoute.model}${effort})`
      state.recordPhase2(retryAt, detail)
      return { kind: 'error', error: detail }
    }
  }
}
