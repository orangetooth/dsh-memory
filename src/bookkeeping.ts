/** Durable bookkeeping through the storage hub KV backend: claims, cooldowns, pending flags. */

import type { Config } from './config.js'
import type { MemoryState, SessionClaim } from './types.js'
import { messageOf } from './util.js'

/** Structural slice of the storage hub KV unit the plugin needs. */
export interface KvUnitLike {
  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }>
  putRecord(table: string, key: string, value: unknown): Promise<void>
  close(): Promise<void>
}

export interface KvFacilityLike {
  open(descriptor: {
    name: string
    version: number
    tables: readonly string[]
    hasGlobal: boolean
  }): Promise<KvUnitLike>
}

const UNIT = { name: 'dsh_memory', version: 1, tables: ['state'], hasGlobal: false } as const
const KEY = 'main'
const ORPHAN_RUNNING_MS = 30 * 60_000

function freshState(): MemoryState {
  return { v: 1, processed: {}, lastPhase1At: 0, lastPhase2At: 0, pendingConsolidation: false, overrides: {} }
}

function isMemoryState(value: unknown): value is MemoryState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Partial<MemoryState>
  return state.v === 1
    && typeof state.processed === 'object' && state.processed !== null
    && typeof state.lastPhase1At === 'number'
    && typeof state.lastPhase2At === 'number'
    && typeof state.pendingConsolidation === 'boolean'
    && typeof state.overrides === 'object' && state.overrides !== null
}

/**
 * Owns the plugin's durable state: per-session extraction claims, Phase 2
 * cooldown, the pending-consolidation flag, and settings-page overrides.
 * Writes are serialized through a promise chain; reads come from an in-memory
 * snapshot. When the KV backend is unavailable the store degrades to
 * process-local state (claims still prevent duplicate work within this run).
 */
export class MemoryStateStore {
  private state: MemoryState = freshState()
  private unit: KvUnitLike | undefined
  private openPromise: Promise<KvUnitLike | undefined> | undefined
  private saveChain: Promise<void> = Promise.resolve()
  storageAvailable = false
  storageError = ''

  constructor(
    private readonly getKv: () => KvFacilityLike | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  async init(): Promise<void> {
    this.unit = await this.openUnit()
    if (this.unit === undefined) return
    try {
      const snapshot = await this.unit.loadAll()
      const record = snapshot.tables.state?.[KEY]
      if (isMemoryState(record)) {
        this.state = {
          ...freshState(),
          ...record,
          processed: { ...record.processed },
          overrides: { ...record.overrides },
        }
        // A persisted running claim cannot still belong to this new process.
        // DSH owns one writer per profile, so it is safe to release it now.
        this.recoverRunningBefore(Number.POSITIVE_INFINITY, 'interrupted by restart')
      }
    } catch (error: unknown) {
      this.storageError = messageOf(error)
    }
  }

  private recoverRunningBefore(horizon: number, error: string): number {
    let recovered = 0
    for (const [id, claim] of Object.entries(this.state.processed)) {
      if (claim.status === 'running' && claim.at < horizon) {
        this.state.processed[id] = {
          status: 'failed',
          at: this.now(),
          attempts: claim.attempts,
          error,
        }
        recovered += 1
      }
    }
    if (recovered > 0 && this.unit !== undefined) this.queueSave()
    return recovered
  }

  /** Release a live-process claim whose lease elapsed without completion. */
  recoverExpiredRunningClaims(): number {
    return this.recoverRunningBefore(this.now() - ORPHAN_RUNNING_MS, 'running lease expired')
  }

  private async openUnit(): Promise<KvUnitLike | undefined> {
    if (this.openPromise !== undefined) return this.openPromise
    this.openPromise = (async () => {
      const kv = this.getKv()
      if (kv === undefined) {
        this.storageAvailable = false
        this.storageError = 'storage json KV backend unavailable'
        return undefined
      }
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          this.storageAvailable = true
          this.storageError = ''
          return await kv.open(UNIT)
        } catch (error: unknown) {
          const text = messageOf(error)
          if (text.includes('already open') && attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)))
            continue
          }
          this.storageAvailable = false
          this.storageError = text
          return undefined
        }
      }
      return undefined
    })()
    return this.openPromise
  }

  private queueSave(): void {
    this.saveChain = this.saveChain.then(async () => {
      if (this.unit === undefined) return
      try {
        await this.unit.putRecord(UNIT.tables[0]!, KEY, this.snapshot())
      } catch (error: unknown) {
        this.storageError = messageOf(error)
      }
    }).catch(() => {})
  }

  snapshot(): MemoryState {
    return { ...this.state, processed: { ...this.state.processed }, overrides: { ...this.state.overrides } }
  }

  processedOf(id: string): SessionClaim | undefined {
    return this.state.processed[id]
  }

  claimRunning(id: string): void {
    const previous = this.state.processed[id]
    this.state.processed[id] = {
      status: 'running',
      at: this.now(),
      attempts: (previous?.attempts ?? 0) + 1,
      ...(previous?.slug === undefined ? {} : { slug: previous.slug }),
      ...(previous?.lastSeq === undefined ? {} : { lastSeq: previous.lastSeq }),
      ...(previous?.parts === undefined ? {} : { parts: previous.parts }),
    }
    this.queueSave()
  }

  claimDone(id: string, slug?: string, lastSeq?: number, parts?: number): void {
    const previous = this.state.processed[id]
    this.state.processed[id] = {
      status: 'done',
      at: this.now(),
      attempts: previous?.attempts ?? 0,
      ...(slug === undefined ? {} : { slug }),
      ...(previous?.slug !== undefined && slug === undefined ? { slug: previous.slug } : {}),
      ...(lastSeq === undefined ? {} : { lastSeq }),
      ...(parts === undefined ? {} : { parts }),
    }
    this.queueSave()
  }

  /** Re-check touched a claim but nothing new was worth extracting. */
  claimUnchanged(id: string, lastSeq: number): void {
    const previous = this.state.processed[id]
    if (previous === undefined) return
    this.state.processed[id] = {
      status: previous.status === 'failed' ? 'failed' : previous.status === 'noop' ? 'noop' : 'done',
      at: this.now(),
      attempts: previous.attempts,
      ...(previous.slug === undefined ? {} : { slug: previous.slug }),
      ...(previous.parts === undefined ? {} : { parts: previous.parts }),
      lastSeq,
    }
    this.queueSave()
  }

  claimNoop(id: string): void {
    this.state.processed[id] = {
      status: 'noop',
      at: this.now(),
      attempts: this.state.processed[id]?.attempts ?? 0,
    }
    this.queueSave()
  }

  claimFailed(id: string, error: string): void {
    this.state.processed[id] = {
      status: 'failed',
      at: this.now(),
      attempts: this.state.processed[id]?.attempts ?? 0,
      error: error.slice(0, 500),
    }
    this.queueSave()
  }

  get pendingConsolidation(): boolean {
    return this.state.pendingConsolidation
  }

  get memoryParentSessionId(): string | undefined {
    return this.state.memoryParentSessionId
  }

  setMemoryParentSessionId(id: string): void {
    if (this.state.memoryParentSessionId === id) return
    this.state.memoryParentSessionId = id
    this.queueSave()
  }

  setPendingConsolidation(value: boolean): void {
    if (this.state.pendingConsolidation === value) return
    this.state.pendingConsolidation = value
    this.queueSave()
  }

  get lastPhase2At(): number {
    return this.state.lastPhase2At
  }

  get phase2Error(): string | undefined {
    return this.state.phase2Error
  }

  recordPhase1(at: number): void {
    this.state.lastPhase1At = at
    this.queueSave()
  }

  recordPhase2(at: number, error?: string): void {
    this.state.lastPhase2At = at
    if (error === undefined) {
      delete this.state.phase2Error
    } else {
      this.state.phase2Error = error.slice(0, 500)
    }
    this.queueSave()
  }

  setOverrides(overrides: Partial<Config>): void {
    this.state.overrides = { ...this.state.overrides, ...overrides }
    this.queueSave()
  }

  /** Re-queue every failed claim so the next pipeline run retries them. */
  resetFailedClaims(): number {
    let count = 0
    for (const [id, claim] of Object.entries(this.state.processed)) {
      if (claim.status === 'failed') {
        delete this.state.processed[id]
        count += 1
      }
    }
    if (count > 0) this.queueSave()
    return count
  }

  async flush(): Promise<void> {
    await this.saveChain
  }

  async dispose(): Promise<void> {
    await this.flush()
    const unit = this.unit
    this.unit = undefined
    if (unit !== undefined) {
      try {
        await unit.close()
      } catch {
        // The unit may already be closed by the storage backend.
      }
    }
  }
}
