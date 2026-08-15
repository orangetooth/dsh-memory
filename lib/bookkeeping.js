/** Durable bookkeeping through the storage hub KV backend: claims, cooldowns, pending flags. */
import { messageOf } from './util.js';
const UNIT = { name: 'dsh_memory', version: 1, tables: ['state'], hasGlobal: false };
const KEY = 'main';
const ORPHAN_RUNNING_MS = 30 * 60_000;
function freshState() {
    return { v: 1, processed: {}, lastPhase1At: 0, lastPhase2At: 0, pendingConsolidation: false, overrides: {} };
}
function isMemoryState(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const state = value;
    return state.v === 1
        && typeof state.processed === 'object' && state.processed !== null
        && typeof state.lastPhase1At === 'number'
        && typeof state.lastPhase2At === 'number'
        && typeof state.pendingConsolidation === 'boolean'
        && typeof state.overrides === 'object' && state.overrides !== null;
}
/**
 * Owns the plugin's durable state: per-session extraction claims, Phase 2
 * cooldown, the pending-consolidation flag, and settings-page overrides.
 * Writes are serialized through a promise chain; reads come from an in-memory
 * snapshot. When the KV backend is unavailable the store degrades to
 * process-local state (claims still prevent duplicate work within this run).
 */
export class MemoryStateStore {
    getKv;
    now;
    state = freshState();
    unit;
    openPromise;
    saveChain = Promise.resolve();
    storageAvailable = false;
    storageError = '';
    constructor(getKv, now = Date.now) {
        this.getKv = getKv;
        this.now = now;
    }
    async init() {
        this.unit = await this.openUnit();
        if (this.unit === undefined)
            return;
        try {
            const snapshot = await this.unit.loadAll();
            const record = snapshot.tables.state?.[KEY];
            if (isMemoryState(record)) {
                this.state = {
                    ...freshState(),
                    ...record,
                    processed: { ...record.processed },
                    overrides: { ...record.overrides },
                };
                this.recoverOrphans();
            }
        }
        catch (error) {
            this.storageError = messageOf(error);
        }
    }
    /** Recover claims interrupted by a restart, mirroring Codex lease expiry. */
    recoverOrphans() {
        const horizon = this.now() - ORPHAN_RUNNING_MS;
        for (const [id, claim] of Object.entries(this.state.processed)) {
            if (claim.status === 'running' && claim.at < horizon) {
                this.state.processed[id] = {
                    status: 'failed',
                    at: this.now(),
                    attempts: claim.attempts,
                    error: 'interrupted by restart',
                };
            }
        }
        if (this.unit !== undefined)
            this.queueSave();
    }
    async openUnit() {
        if (this.openPromise !== undefined)
            return this.openPromise;
        this.openPromise = (async () => {
            const kv = this.getKv();
            if (kv === undefined) {
                this.storageAvailable = false;
                this.storageError = 'storage json KV backend unavailable';
                return undefined;
            }
            for (let attempt = 0; attempt < 4; attempt += 1) {
                try {
                    this.storageAvailable = true;
                    this.storageError = '';
                    return await kv.open(UNIT);
                }
                catch (error) {
                    const text = messageOf(error);
                    if (text.includes('already open') && attempt < 3) {
                        await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
                        continue;
                    }
                    this.storageAvailable = false;
                    this.storageError = text;
                    return undefined;
                }
            }
            return undefined;
        })();
        return this.openPromise;
    }
    queueSave() {
        this.saveChain = this.saveChain.then(async () => {
            if (this.unit === undefined)
                return;
            try {
                await this.unit.putRecord(UNIT.tables[0], KEY, this.snapshot());
            }
            catch (error) {
                this.storageError = messageOf(error);
            }
        }).catch(() => { });
    }
    snapshot() {
        return { ...this.state, processed: { ...this.state.processed }, overrides: { ...this.state.overrides } };
    }
    processedOf(id) {
        return this.state.processed[id];
    }
    claimRunning(id) {
        const previous = this.state.processed[id];
        this.state.processed[id] = {
            status: 'running',
            at: this.now(),
            attempts: (previous?.attempts ?? 0) + 1,
        };
        this.queueSave();
    }
    claimDone(id, slug) {
        this.state.processed[id] = {
            status: 'done',
            at: this.now(),
            attempts: this.state.processed[id]?.attempts ?? 0,
            ...(slug === undefined ? {} : { slug }),
        };
        this.queueSave();
    }
    claimNoop(id) {
        this.state.processed[id] = {
            status: 'noop',
            at: this.now(),
            attempts: this.state.processed[id]?.attempts ?? 0,
        };
        this.queueSave();
    }
    claimFailed(id, error) {
        this.state.processed[id] = {
            status: 'failed',
            at: this.now(),
            attempts: this.state.processed[id]?.attempts ?? 0,
            error: error.slice(0, 500),
        };
        this.queueSave();
    }
    get pendingConsolidation() {
        return this.state.pendingConsolidation;
    }
    setPendingConsolidation(value) {
        if (this.state.pendingConsolidation === value)
            return;
        this.state.pendingConsolidation = value;
        this.queueSave();
    }
    get lastPhase2At() {
        return this.state.lastPhase2At;
    }
    get phase2Error() {
        return this.state.phase2Error;
    }
    recordPhase1(at) {
        this.state.lastPhase1At = at;
        this.queueSave();
    }
    recordPhase2(at, error) {
        this.state.lastPhase2At = at;
        if (error === undefined) {
            delete this.state.phase2Error;
        }
        else {
            this.state.phase2Error = error.slice(0, 500);
        }
        this.queueSave();
    }
    setOverrides(overrides) {
        this.state.overrides = { ...this.state.overrides, ...overrides };
        this.queueSave();
    }
    async flush() {
        await this.saveChain;
    }
    async dispose() {
        await this.flush();
        const unit = this.unit;
        this.unit = undefined;
        if (unit !== undefined) {
            try {
                await unit.close();
            }
            catch {
                // The unit may already be closed by the storage backend.
            }
        }
    }
}
//# sourceMappingURL=bookkeeping.js.map