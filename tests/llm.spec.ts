import { describe, expect, it } from 'vitest'
import { ReasoningEffortId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  generateOptions,
  PHASE1_REASONING,
  PHASE2_REASONING,
  resolveStageRoute,
  type LlmRuntime,
} from '../src/llm.js'

function runtimeWith(efforts: string[], defaultEffort?: string): LlmRuntime {
  return {
    async resolveModelInfo(provider, model) {
      return {
        provider,
        id: model,
        name: model,
        reasoning: {
          efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: id })),
          ...(defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultEffort) }),
        },
      }
    },
    stream(): AsyncIterable<StreamChunk> {
      return (async function* () {})()
    },
  }
}

describe('memory-stage reasoning', () => {
  it('preserves Codex low/medium when the model offers exact levels', async () => {
    const runtime = runtimeWith(['off', 'low', 'medium', 'high'])
    const route = { provider: 'provider', model: 'model' }
    expect((await resolveStageRoute(runtime, route, PHASE1_REASONING)).reasoningEffort).toBe('low')
    expect((await resolveStageRoute(runtime, route, PHASE2_REASONING)).reasoningEffort).toBe('medium')
  })

  it('maps both Codex stages to DeepSeek high instead of disabling reasoning', async () => {
    const runtime = runtimeWith(['off', 'high', 'max'], 'max')
    const route = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    const phase1 = await resolveStageRoute(runtime, route, PHASE1_REASONING)
    const phase2 = await resolveStageRoute(runtime, route, PHASE2_REASONING)
    expect(phase1.reasoningEffort).toBe('high')
    expect(phase2.reasoningEffort).toBe('high')
    expect(generateOptions(phase1, 'system', 'user', 100).reasoningEffort).toBe('high')
  })

  it('leaves the route alone when the adapter exposes no reasoning capability', async () => {
    const runtime: LlmRuntime = {
      async resolveModelInfo(provider, model) {
        return { provider, id: model, name: model }
      },
      stream: runtimeWith([]).stream,
    }
    await expect(resolveStageRoute(runtime, { provider: 'plain', model: 'model' }, PHASE1_REASONING))
      .resolves.toEqual({ provider: 'plain', model: 'model' })
  })
})
