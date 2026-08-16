import { describe, expect, it } from 'vitest'
import { redactSecrets, renderEvent, renderTranscript, selectCandidates } from '../src/rollout.js'
import { assistantMessage, toolCall, toolResult, userMessage } from './helpers.js'
import type { SessionClaim, SessionHeaderLite } from '../src/types.js'

describe('redactSecrets', () => {
  it('redacts common secret shapes and leaves ordinary text alone', () => {
    const input = [
      'key sk-abcdefghijklmnopqrstuvwx',
      'AWS key AKIA1234567890ABCDEF',
      'token ghp_1234567890123456789012',
      'github_pat_abcdefghijklmnopqrstuvwxyz1234',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
      'password: hunter2secret123',
      'plain sentence about tokens stays',
      'short token=abc',
    ].join('\n')
    const output = redactSecrets(input)
    expect(output).toContain('[REDACTED_KEY]')
    expect(output).toContain('[REDACTED_TOKEN]')
    expect(output).toContain('[REDACTED_SECRET]')
    expect(output).toContain('plain sentence about tokens stays')
    expect(output).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(output).not.toContain('AKIA1234567890ABCDEF')
    expect(output).not.toContain('hunter2secret123')
    expect(output).toContain('token=abc')
  })
})

describe('renderEvent', () => {
  it('renders user, assistant, tool call, and tool result events', () => {
    expect(renderEvent(userMessage('请修复这个 bug'))).toContain('[用户] 请修复这个 bug')
    expect(renderEvent(assistantMessage('已定位问题'))).toContain('[助手] 已定位问题')
    expect(renderEvent(toolCall('bash', { command: 'pnpm test' }))).toContain('[工具调用] bash')
    expect(renderEvent(toolResult('3 tests passed'))).toContain('[工具结果] 3 tests passed')
    expect(renderEvent(toolResult('boom', true))).toContain('·失败')
  })

  it('labels plugin-injected messages and skips unknown events', () => {
    const line = renderEvent(userMessage('图片已由视觉模型分析', 'plugin'))
    expect(line).toContain('[插件消息·vision-bridge]')
    expect(renderEvent({ type: 'turn/start', data: {} })).toBeUndefined()
    expect(renderEvent({ type: 'permission/preset', data: { preset: 'auto' } })).toBeUndefined()
    expect(renderEvent('not an object')).toBeUndefined()
  })

  it('never lets event text through unredacted', () => {
    const rendered = renderTranscript([userMessage('key sk-abcdefghijklmnopqrstuvwx here')], { maxTranscriptChars: 10_000 })
    expect(rendered.text).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(rendered.text).toContain('[REDACTED_KEY]')
  })
})

describe('renderTranscript', () => {
  it('joins rendered events, counts only them, and caps size', () => {
    const events = [
      { type: 'turn/start', data: {} },
      userMessage('第一段'),
      assistantMessage('回答'),
      userMessage('第二段'),
      toolCall('bash', { command: 'x' }),
      toolResult('ok'),
    ]
    const rendered = renderTranscript(events, { maxTranscriptChars: 10_000 })
    expect(rendered.eventCount).toBe(5)
    expect(rendered.text).toContain('[用户] 第一段')
    expect(rendered.text).toContain('[工具结果] ok')
  })
})

describe('selectCandidates', () => {
  const now = 1_700_000_000_000
  const RECHECK = 30 * 60_000
  const header = (id: string, createdAt = now, extra: Partial<SessionHeaderLite> = {}): SessionHeaderLite =>
    ({ id, createdAt, ...extra })
  const options = (maxPerRun = 10) => ({ now: () => now, maxAgeDays: 30, maxPerRun, retryLimit: 3, recheckIntervalMs: RECHECK })

  it('filters subagents, processed sessions, and running claims', () => {
    const headers = [
      header('child', now, { origin: 'subagent' }),
      header('done'),
      header('running'),
      header('fresh'),
    ]
    const claims: Record<string, SessionClaim> = {
      done: { status: 'done', at: now, attempts: 1 },
      running: { status: 'running', at: now, attempts: 1 },
    }
    const result = selectCandidates(headers, id => claims[id], options())
    expect(result.candidates.map(c => c.id)).toEqual(['fresh'])
  })

  it('ages out old sessions into stale and caps the batch by recency', () => {
    const headers = [
      header('old', now - 40 * 86_400_000),
      header('n1', now - 1_000),
      header('n2', now - 2_000),
      header('n3', now - 3_000),
      header('n4', now - 4_000),
    ]
    const result = selectCandidates(headers, () => undefined, options(3))
    expect(result.stale.map(c => c.id)).toEqual(['old'])
    expect(result.candidates.map(c => c.id)).toEqual(['n1', 'n2', 'n3'])
  })

  it('retries failed sessions with backoff and gives up at the retry limit', () => {
    const headers = [header('s1')]
    const recently = { status: 'failed', at: now - 1_000, attempts: 1 }
    expect(selectCandidates(headers, () => recently, options()).candidates).toHaveLength(0)
    const later = { status: 'failed', at: now - 5 * 60_000, attempts: 1 }
    expect(selectCandidates(headers, () => later, options()).candidates).toHaveLength(1)
    const exhausted = { status: 'failed', at: now - 5 * 60_000, attempts: 3 }
    expect(selectCandidates(headers, () => exhausted, options()).candidates).toHaveLength(0)
  })

  it('re-queues done/noop sessions for recheck after the interval, after fresh sessions', () => {
    const headers = [
      header('fresh', now - 1_000),
      header('old-done', now - 2_000),
      header('old-noop', now - 3_000),
      header('recent-done', now - 4_000),
    ]
    const claims: Record<string, SessionClaim> = {
      'old-done': { status: 'done', at: now - 2 * RECHECK, attempts: 1, lastSeq: 5 },
      'old-noop': { status: 'noop', at: now - 3 * RECHECK, attempts: 1, lastSeq: 2 },
      'recent-done': { status: 'done', at: now - 60_000, attempts: 1, lastSeq: 9 },
    }
    const result = selectCandidates(headers, id => claims[id], options())
    // Fresh first, then longest-unrechecked; the recent claim stays parked.
    expect(result.candidates.map(c => c.id)).toEqual(['fresh', 'old-noop', 'old-done'])
  })

  it('stops rechecking sessions past the age window', () => {
    const headers = [header('old-done', now - 40 * 86_400_000)]
    const claims: Record<string, SessionClaim> = {
      'old-done': { status: 'done', at: now - 2 * RECHECK, attempts: 1, lastSeq: 5 },
    }
    const result = selectCandidates(headers, id => claims[id], options())
    expect(result.candidates).toHaveLength(0)
    expect(result.stale).toHaveLength(0)
  })
})
