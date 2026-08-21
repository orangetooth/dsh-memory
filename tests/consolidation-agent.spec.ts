import { describe, expect, it } from 'vitest'
import type { SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import {
  HarnessConsolidationAgent,
  READ_ONLY_MEMORY_TOOLS,
  type SubagentRuntimeLike,
} from '../src/consolidation-agent.js'
import { PHASE2_OUTPUT_SCHEMA, PHASE2_SYSTEM } from '../src/prompts.js'

const parent = {} as SubagentStartRequest['parent']
const request = {
  mode: 'incremental' as const,
  memoryRoot: '/memory-root',
  pendingNotes: 2,
  rolloutSummaries: 7,
  maxRawChars: 120_000,
  maxTokens: 12_000,
  route: { provider: 'mock-provider', model: 'mock-model' },
}

const capableProvider = {
  capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
  inheritsParentContext: false,
}

function fakeRuntime(result: {
  stopReason: 'completed' | 'error' | 'aborted' | 'max-tokens' | 'refusal'
  structured?: unknown
}): {
  runtime: SubagentRuntimeLike
  starts: Array<{ provider: string; request: SubagentStartRequest }>
  disposed: { count: number }
} {
  const starts: Array<{ provider: string; request: SubagentStartRequest }> = []
  const disposed = { count: 0 }
  const run: SubagentRun = {
    id: 'memory-child' as never,
    localAgent: undefined,
    result: Promise.resolve({ output: [], ...result }),
    async dispose() {
      disposed.count += 1
    },
  }
  return {
    starts,
    disposed,
    runtime: {
      getProvider: () => capableProvider,
      async start(provider, startRequest) {
        starts.push({ provider, request: startRequest })
        return run
      },
    },
  }
}

describe('HarnessConsolidationAgent', () => {
  it('reports readiness only for a live root and a fully restricted fresh provider', () => {
    const ready = fakeRuntime({ stopReason: 'completed', structured: {} })
    expect(new HarnessConsolidationAgent({ subagents: ready.runtime, parent: () => parent }).readiness()).toBe('ready')
    expect(new HarnessConsolidationAgent({ subagents: ready.runtime, parent: () => undefined }).readiness()).toBe('no-agent')

    const inherited: SubagentRuntimeLike = {
      getProvider: () => ({ ...capableProvider, inheritsParentContext: true }),
      start: ready.runtime.start.bind(ready.runtime),
    }
    expect(new HarnessConsolidationAgent({ subagents: inherited, parent: () => parent }).readiness()).toBe('no-provider')

    const unfiltered: SubagentRuntimeLike = {
      getProvider: () => ({ ...capableProvider, capabilities: { ...capableProvider.capabilities, toolFilter: false } }),
      start: ready.runtime.start.bind(ready.runtime),
    }
    expect(new HarnessConsolidationAgent({ subagents: unfiltered, parent: () => parent }).readiness()).toBe('no-provider')
  })

  it('starts one fresh child with read-only memory tools and native structured output', async () => {
    const fake = fakeRuntime({
      stopReason: 'completed',
      structured: { memory_md: '# Memory\n', memory_summary_md: 'v1\n- topic\n' },
    })
    const agent = new HarnessConsolidationAgent({ subagents: fake.runtime, parent: () => parent })

    await expect(agent.consolidate(request)).resolves.toEqual({
      memoryMd: '# Memory\n',
      memorySummaryMd: 'v1\n- topic\n',
    })
    expect(fake.starts).toHaveLength(1)
    const start = fake.starts[0]!
    expect(start.provider).toBe('spawn')
    expect(start.request.parent).toBe(parent)
    expect(start.request.label).toBe('memory-consolidation')
    expect(start.request.agentOptions).toEqual({
      provider: 'mock-provider',
      model: 'mock-model',
      maxTokens: 12_000,
    })
    expect(start.request.maxDepth).toBe(1)
    expect(start.request.toolFilter).toEqual({ allow: READ_ONLY_MEMORY_TOOLS })
    expect(start.request.outputSchema).toBe(PHASE2_OUTPUT_SCHEMA)
    expect(start.request.persona).toBe(PHASE2_SYSTEM)
    expect(start.request.prompt[0]).toMatchObject({ type: 'text' })
    expect(JSON.stringify(start.request.prompt)).toContain('memory_read')
    expect(JSON.stringify(start.request.prompt)).not.toContain('MEMORY.md 新内容')
    expect(fake.disposed.count).toBe(1)
  })

  it('rejects abnormal completion and always disposes the child', async () => {
    const fake = fakeRuntime({ stopReason: 'max-tokens' })
    const agent = new HarnessConsolidationAgent({ subagents: fake.runtime, parent: () => parent })

    await expect(agent.consolidate(request)).rejects.toThrow('stopReason=max-tokens')
    expect(fake.disposed.count).toBe(1)
  })

  it('validates the structured result before exposing artifacts', async () => {
    const fake = fakeRuntime({ stopReason: 'completed', structured: { memory_md: '# Memory' } })
    const agent = new HarnessConsolidationAgent({ subagents: fake.runtime, parent: () => parent })

    await expect(agent.consolidate(request)).rejects.toThrow('memory_summary_md')
    expect(fake.disposed.count).toBe(1)
  })
})
