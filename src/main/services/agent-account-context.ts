import type { AgentAccountContext } from '../../shared/agent-account-context'

type Row = Record<string, unknown>
export async function optionalAccountMetadata<T>(read: () => Promise<T>, timeoutMs = 1500): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([read(), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) })])
  } catch { return null } finally { if (timer) clearTimeout(timer) }
}
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const label = (value: unknown): string | undefined => typeof value === 'string' && /^[\w .:/-]{1,80}$/.test(value) ? value : undefined
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
function timestamp(value: unknown): string | undefined {
  const seconds = number(value)
  if (seconds === undefined || seconds > 253402300799) return undefined
  return new Date(seconds * 1000).toISOString()
}

export function emptyAccountContext(provider: AgentAccountContext['provider'], model?: string | null): AgentAccountContext {
  return { provider, observedAt: new Date().toISOString(), authMode: 'unknown', limits: [], ...(label(model) ? { model: label(model) } : {}),
    ...(provider === 'opencode' && model?.includes('/') && label(model.split('/')[0]) ? { apiProvider: label(model.split('/')[0]) } : {}) }
}

export function codexExecutionContext(value: unknown): Partial<AgentAccountContext> {
  const data = row(value)
  const apiProvider = label(data.modelProvider)
  return { model: label(data.model), apiProvider,
    ...(apiProvider && apiProvider !== 'openai' ? { authMode: 'unknown' as const, plan: undefined, limits: [] } : {}) }
}

export function claudeModelContext(value: unknown): Partial<AgentAccountContext> {
  return { model: label(row(value).model) }
}

export function codexAccountContext(value: unknown): Partial<AgentAccountContext> {
  const account = row(row(value).account)
  const type = account.type
  return {
    authMode: type === 'chatgpt' || type === 'chatgptAuthTokens' ? 'subscription' : type === 'apiKey' || type === 'bedrock' ? 'api' : 'unknown',
    plan: label(account.planType)
  }
}

export function codexLimitContext(value: unknown): Pick<AgentAccountContext, 'limits'> {
  const data = row(value)
  const buckets = Object.values(row(data.rateLimitsByLimitId))
  const limits: AgentAccountContext['limits'] = []
  for (const raw of buckets.length ? buckets : [data.rateLimits]) {
    const bucket = row(raw)
    for (const key of ['primary', 'secondary']) {
      const window = row(bucket[key])
      if (!Object.keys(window).length) continue
      const used = number(window.usedPercent)
      const minutes = number(window.windowDurationMins)
      limits.push({ name: `${label(bucket.limitName) ?? label(bucket.limitId) ?? 'Codex'} ${key}`,
        ...(used === undefined ? {} : { usedPercent: Math.min(100, used) }),
        ...(minutes ? { windowMinutes: minutes } : {}), resetsAt: timestamp(window.resetsAt) })
    }
  }
  return { limits: limits.slice(0, 32) }
}

export function claudeAccountContext(value: unknown): Partial<AgentAccountContext> {
  const account = row(value)
  const apiProvider = label(account.apiProvider)
  const plan = label(account.subscriptionType)
  const api = apiProvider && apiProvider !== 'firstParty' || account.apiKeySource && account.apiKeySource !== 'none'
  return { authMode: api ? 'api' : plan || account.tokenSource && account.tokenSource !== 'none' ? 'subscription' : 'unknown', plan: api ? undefined : plan, apiProvider }
}

export function claudeLimitContext(value: unknown): AgentAccountContext['limits'][number] | null {
  const info = row(value)
  const name = label(info.rateLimitType)
  if (!name) return null
  const used = number(info.utilization)
  const status = info.status === 'allowed' || info.status === 'allowed_warning' || info.status === 'rejected' ? info.status : undefined
  return { name, ...(used === undefined ? {} : { usedPercent: Math.min(100, used * 100) }), resetsAt: timestamp(info.resetsAt), status }
}

export function claudeTurnUsage(value: unknown): AgentAccountContext['turnUsage'] {
  const data = row(value)
  const models = Object.values(row(data.modelUsage)).map(row)
  const sum = (key: string): number | undefined => models.length && models.every(model => number(model[key]) !== undefined)
    ? models.reduce((total, model) => total + Number(model[key]), 0) : undefined
  return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), estimatedCostUsd: number(data.total_cost_usd) }
}

export function opencodeStepUsage(value: unknown): AgentAccountContext['turnUsage'] | null {
  const data = row(value)
  if (data.type !== 'step_finish') return null
  const part = row(data.part)
  const tokens = row(part.tokens)
  return { inputTokens: number(tokens.input), outputTokens: number(tokens.output), estimatedCostUsd: number(part.cost) }
}
