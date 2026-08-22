/** Dedicated top-level agent that owns every Phase 2 consolidation child. */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { messageOf } from './util.js';
export const MEMORY_PARENT_TITLE = '长期记忆（后台整合）';
export const MEMORY_PARENT_ID_PREFIX = 'dsh-memory-parent-';
function isMissingPersistedSession(error) {
    const text = messageOf(error);
    return text.includes('not found') || text.includes('session persistence is not configured');
}
/**
 * Owns one blank root agent whose only job is to provide durable lineage and a
 * memory-root workspace for fresh consolidation children. It never receives a
 * model-facing turn and deliberately joins no business agent preset.
 */
export class MemoryParent {
    agents;
    state;
    memoryRoot;
    current;
    ownedHandle;
    starting;
    disposed = false;
    constructor(agents, state, memoryRoot) {
        this.agents = agents;
        this.state = state;
        this.memoryRoot = memoryRoot;
    }
    get id() {
        return this.state.memoryParentSessionId;
    }
    get agent() {
        return this.current;
    }
    matches(agent) {
        return this.id !== undefined && agent.id === this.id;
    }
    /** Clear a borrowed/live handle if another owner tears it down. */
    noticeDisposed(agent) {
        if (this.current !== agent)
            return;
        this.current = undefined;
        if (this.ownedHandle?.agent === agent)
            this.ownedHandle = undefined;
    }
    /** Create or cold-resume the dedicated parent, single-flight. */
    ensure() {
        if (this.disposed)
            return Promise.reject(new Error('memory parent is disposed'));
        if (this.current !== undefined)
            return Promise.resolve(this.current);
        if (this.starting !== undefined)
            return this.starting;
        const starting = this.open().finally(() => {
            if (this.starting === starting)
                this.starting = undefined;
        });
        this.starting = starting;
        return starting;
    }
    async open() {
        let id = this.state.memoryParentSessionId;
        if (id === undefined) {
            id = `${MEMORY_PARENT_ID_PREFIX}${randomUUID()}`;
            this.state.setMemoryParentSessionId(id);
            await this.state.flush();
        }
        const live = this.agents.get(id);
        if (live !== undefined) {
            this.assertDedicated(live);
            await this.ensureVisibleTitle(live);
            this.current = live;
            return live;
        }
        let handle;
        try {
            handle = await this.agents.resume({ resumeSessionId: id });
        }
        catch (error) {
            if (!isMissingPersistedSession(error))
                throw error;
            handle = await this.agents.create({ sessionId: id, meta: { cwd: this.memoryRoot } });
        }
        try {
            this.assertDedicated(handle.agent);
            await this.ensureVisibleTitle(handle.agent);
            if (this.disposed)
                throw new Error('memory parent was disposed during startup');
        }
        catch (error) {
            await handle.dispose().catch(() => { });
            throw error;
        }
        this.ownedHandle = handle;
        this.current = handle.agent;
        return handle.agent;
    }
    assertDedicated(agent) {
        const header = agent.session.header;
        if (header.origin === 'subagent')
            throw new Error(`memory parent "${agent.id}" is a subagent session`);
        if (header.cwd === undefined || resolve(header.cwd) !== resolve(this.memoryRoot)) {
            throw new Error(`memory parent "${agent.id}" has unexpected cwd "${header.cwd ?? ''}"`);
        }
    }
    async ensureVisibleTitle(agent) {
        const session = agent.session;
        if (session.events.some(event => event.type === 'session/title'))
            return;
        session.append('session/title', {
            title: MEMORY_PARENT_TITLE,
            messageSeqs: [],
            source: { kind: 'user' },
        }, { ignorable: true });
        const sessions = agent.ctx.get('sessions');
        await sessions?.flush?.(agent.session);
    }
    async dispose() {
        this.disposed = true;
        const handle = this.ownedHandle;
        this.ownedHandle = undefined;
        this.current = undefined;
        if (handle !== undefined)
            await handle.dispose();
    }
}
//# sourceMappingURL=memory-parent.js.map