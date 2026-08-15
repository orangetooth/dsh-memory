import { describe, expect, it } from 'vitest'
import { MemoryStateStore } from '../src/bookkeeping.js'
import { fakeKv } from './helpers.js'

describe('MemoryStateStore', () => {
  it('starts fresh and tracks claim lifecycle', async () => {
    const { facility } = fakeKv()
    const store = new MemoryStateStore(() => facility)
    await store.init()
    expect(store.storageAvailable).toBe(true)
    expect(store.processedOf('s1')).toBeUndefined()

    store.claimRunning('s1')
    expect(store.processedOf('s1')?.status).toBe('running')
    store.claimDone('s1', 'slug-1')
    expect(store.processedOf('s1')).toMatchObject({ status: 'done', slug: 'slug-1' })
    store.claimNoop('s2')
    store.claimRunning('s3')
    store.claimFailed('s3', 'boom')
    expect(store.processedOf('s2')?.status).toBe('noop')
    expect(store.processedOf('s3')).toMatchObject({ status: 'failed', attempts: 1, error: 'boom' })
    await store.dispose()
  })

  it('persists state across store instances', async () => {
    const { facility } = fakeKv()
    const first = new MemoryStateStore(() => facility)
    await first.init()
    first.claimDone('s1', 'slug')
    first.setPendingConsolidation(true)
    first.setOverrides({ maxRolloutsPerRun: 9 })
    await first.dispose()

    const second = new MemoryStateStore(() => facility)
    await second.init()
    expect(second.processedOf('s1')).toMatchObject({ status: 'done', slug: 'slug' })
    expect(second.pendingConsolidation).toBe(true)
    expect(second.snapshot().overrides.maxRolloutsPerRun).toBe(9)
    await second.dispose()
  })

  it('recovers orphaned running claims after a restart', async () => {
    const { facility, records } = fakeKv()
    records.set('main', {
      v: 1,
      processed: { orphan: { status: 'running', at: Date.now() - 60 * 60_000, attempts: 2 } },
      lastPhase1At: 0,
      lastPhase2At: 0,
      pendingConsolidation: false,
      overrides: {},
    })
    const store = new MemoryStateStore(() => facility)
    await store.init()
    expect(store.processedOf('orphan')).toMatchObject({ status: 'failed', error: 'interrupted by restart' })
    await store.dispose()
  })

  it('keeps fresh running claims untouched', async () => {
    const { facility, records } = fakeKv()
    records.set('main', {
      v: 1,
      processed: { active: { status: 'running', at: Date.now(), attempts: 1 } },
      lastPhase1At: 0,
      lastPhase2At: 0,
      pendingConsolidation: false,
      overrides: {},
    })
    const store = new MemoryStateStore(() => facility)
    await store.init()
    expect(store.processedOf('active')?.status).toBe('running')
    await store.dispose()
  })

  it('degrades to process-local state when storage is unavailable', async () => {
    const store = new MemoryStateStore(() => undefined)
    await store.init()
    expect(store.storageAvailable).toBe(false)
    expect(store.storageError).toContain('unavailable')
    store.claimDone('s1')
    expect(store.processedOf('s1')?.status).toBe('done')
    await store.dispose()
  })

  it('records pipeline timing and cooldown fields', async () => {
    const { facility } = fakeKv()
    const store = new MemoryStateStore(() => facility)
    await store.init()
    store.recordPhase1(1000)
    store.recordPhase2(2000)
    expect(store.snapshot().lastPhase1At).toBe(1000)
    expect(store.lastPhase2At).toBe(2000)
    store.recordPhase2(3000, 'consolidation failed')
    expect(store.phase2Error).toBe('consolidation failed')
    store.recordPhase2(4000)
    expect(store.phase2Error).toBeUndefined()
    await store.dispose()
  })
})
