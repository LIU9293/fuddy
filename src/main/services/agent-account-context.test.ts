import { describe, expect, it } from 'vitest'
import { agentAccountContextSchema } from '../../shared/agent-account-context'
import { claudeAccountContext, claudeLimitContext, claudeTurnUsage, codexAccountContext, codexExecutionContext, codexLimitContext, emptyAccountContext, opencodeStepUsage, optionalAccountMetadata } from './agent-account-context'

describe('provider account metadata', () => {
  it('keeps only display metadata and distinguishes API authentication from subscriptions', () => {
    expect(codexAccountContext({ account: { type: 'chatgpt', planType: 'pro', email: 'private@example.com', accessToken: 'secret' } })).toEqual({ authMode: 'subscription', plan: 'pro' })
    expect(codexAccountContext({ account: { type: 'apiKey', apiKey: 'secret' } }).authMode).toBe('api')
    expect(codexAccountContext(null).authMode).toBe('unknown')
    expect(codexExecutionContext({ modelProvider: 'custom', model: 'my-model' })).toMatchObject({ authMode: 'unknown', plan: undefined, limits: [] })
    expect(claudeAccountContext({ subscriptionType: 'max', tokenSource: 'claude.ai', apiKeySource: 'none', email: 'private' })).toMatchObject({ authMode: 'subscription', plan: 'max' })
    expect(claudeAccountContext({ apiProvider: 'bedrock', subscriptionType: 'max' }).authMode).toBe('api')
    expect(claudeAccountContext({ apiKeySource: 'user', tokenSource: 'none' }).authMode).toBe('api')
  })

  it('prefers all Codex buckets, preserving unknown versus zero usage and reset times', () => {
    const context = codexLimitContext({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1789000000 }, secondary: { usedPercent: 36 } },
      other: { limitId: 'other', primary: { usedPercent: null } }
    } })
    expect(context.limits.map(limit => limit.usedPercent)).toEqual([0, 36, undefined])
    expect(context.limits[0].resetsAt).toBe(new Date(1789000000000).toISOString())
    expect(context.limits[0].windowMinutes).toBe(300)
    expect(codexLimitContext({ rateLimits: null }).limits).toEqual([])
    expect(codexLimitContext({ rateLimits: { primary: { usedPercent: NaN, resetsAt: Infinity } } }).limits[0]).not.toHaveProperty('usedPercent')
  })

  it('normalizes Claude fractions and query totals without estimating missing quota', () => {
    expect(claudeLimitContext({ rateLimitType: 'five_hour', utilization: 0.42, status: 'allowed_warning' })).toMatchObject({ usedPercent: 42, status: 'allowed_warning' })
    expect(claudeLimitContext({ rateLimitType: 'seven_day' })?.usedPercent).toBeUndefined()
    expect(claudeTurnUsage({ total_cost_usd: 0.12, modelUsage: { a: { inputTokens: 10, outputTokens: 20 }, b: { inputTokens: 4, outputTokens: 2 } } }))
      .toEqual({ inputTokens: 14, outputTokens: 22, estimatedCostUsd: 0.12 })
    expect(opencodeStepUsage({ type: 'step_finish', part: { id: 'step', cost: 0, tokens: { input: 7, output: 9 } } }))
      .toEqual({ inputTokens: 7, outputTokens: 9, estimatedCostUsd: 0 })
    expect(emptyAccountContext('opencode').authMode).toBe('unknown')
    expect(emptyAccountContext('opencode').limits).toEqual([])
  })

  it('bounds optional metadata requests and absorbs unsupported-provider errors', async () => {
    expect(await optionalAccountMetadata(() => new Promise(() => undefined), 5)).toBeNull()
    expect(await optionalAccountMetadata(async () => { throw new Error('unsupported') })).toBeNull()
    expect(await optionalAccountMetadata(async () => ({ account: null }))).toEqual({ account: null })
  })

  it('strips credentials before persistence and rejects invalid counters', () => {
    const safe = agentAccountContextSchema.parse({ ...emptyAccountContext('codex'), apiKey: 'secret', email: 'private' })
    expect(safe).not.toHaveProperty('apiKey')
    expect(safe).not.toHaveProperty('email')
    expect(agentAccountContextSchema.safeParse({ ...safe, limits: [{ name: 'test', usedPercent: -5 }] }).success).toBe(false)
  })
})
