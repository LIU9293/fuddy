import type { EvidenceRef } from '../../shared/contracts'
import { CredentialVault } from '../services/credential-vault'
import type { ConnectorAdapter, ConnectorCollection, ConnectorContext, ConnectorProbe, ConnectorSignal } from './types'

type FetchLike = typeof fetch
type JsonRecord = Record<string, unknown>

interface Ga4Credential {
  accessToken: string
  refreshToken: string
  clientId: string
  clientSecret: string
}

function propertyId(context: ConnectorContext): string {
  const value = typeof context.config.propertyId === 'string' ? context.config.propertyId.trim().replace(/^properties\//, '') : ''
  if (!/^\d+$/.test(value)) throw new Error('GA4 Property ID 必须是数字。')
  return value
}

function evidence(id: string): EvidenceRef[] {
  return [{ label: `GA4 Property ${id}`, uri: `https://analytics.google.com/analytics/web/#/p${id}/reports/intelligenthome` }]
}

function metricValue(body: JsonRecord, index: number): number {
  const rows = Array.isArray(body.rows) ? body.rows : []
  const row = rows[0] && typeof rows[0] === 'object' ? rows[0] as JsonRecord : null
  const values = row && Array.isArray(row.metricValues) ? row.metricValues : []
  const value = values[index] && typeof values[index] === 'object' ? (values[index] as JsonRecord).value : '0'
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export class Ga4Connector implements ConnectorAdapter {
  readonly kind = 'ga4' as const

  constructor(
    private readonly credentials: CredentialVault,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async test(context: ConnectorContext): Promise<ConnectorProbe> {
    const id = propertyId(context)
    await this.report(id, context, {
      dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }],
      metrics: [{ name: 'activeUsers' }],
      limit: '1'
    })
    return { summary: `连接正常：GA4 Property ${id}`, evidenceRefs: evidence(id) }
  }

  async collect(context: ConnectorContext): Promise<ConnectorCollection> {
    const id = propertyId(context)
    const metrics = [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'eventCount' }, { name: 'keyEvents' }]
    const [current, previous, channels] = await Promise.all([
      this.report(id, context, { dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }], metrics }),
      this.report(id, context, { dateRanges: [{ startDate: '14daysAgo', endDate: '8daysAgo' }], metrics }),
      this.report(id, context, {
        dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: '10'
      })
    ])
    const currentSessions = metricValue(current, 1)
    const previousSessions = metricValue(previous, 1)
    const delta = previousSessions > 0 ? (currentSessions - previousSessions) / previousSessions : null
    const signal: ConnectorSignal | null = delta !== null && delta <= -0.3 ? {
      fingerprint: 'weekly-session-drop',
      kind: 'risk',
      title: 'GA4 周会话量下降超过 30%',
      summary: `最近 7 天 ${currentSessions} sessions，上一个 7 天 ${previousSessions} sessions，变化 ${(delta * 100).toFixed(1)}%。`,
      impact: '流量显著下降可能影响获客、激活与转化，需要确认渠道、埋点和产品入口是否异常。',
      urgency: 'medium',
      confidence: 0.9,
      suggestedActions: ['分析渠道变化', '检查 GA4 埋点与发布记录'],
      evidenceRefs: evidence(id),
      source: 'GA4 Connector'
    } : null
    return {
      summary: `GA4 最近 7 天：${metricValue(current, 0)} users · ${currentSessions} sessions · ${metricValue(current, 2)} events · ${metricValue(current, 3)} key events${delta === null ? '' : ` · 环比 ${(delta * 100).toFixed(1)}%`}`,
      evidenceRefs: evidence(id),
      signal,
      resolvedSignals: signal ? [] : [{ fingerprint: 'weekly-session-drop', summary: 'GA4 周会话量当前没有下降超过 30%。', evidenceRefs: evidence(id) }],
      data: { current, previous, channels, sessionDelta: delta }
    }
  }

  private credential(context: ConnectorContext): Ga4Credential {
    if (!context.credentialRef) throw new Error('GA4 Connector 缺少 OAuth Access Token。')
    const raw = this.credentials.get(context.credentialRef)
    if (!raw) throw new Error('GA4 OAuth Access Token 不存在或已无法解密。')
    try {
      const parsed = JSON.parse(raw) as Partial<Ga4Credential>
      if (parsed.accessToken) return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken ?? '',
        clientId: parsed.clientId ?? '',
        clientSecret: parsed.clientSecret ?? ''
      }
    } catch { /* support a token saved by an older build */ }
    return { accessToken: raw, refreshToken: '', clientId: '', clientSecret: '' }
  }

  private async report(id: string, context: ConnectorContext, request: JsonRecord): Promise<JsonRecord> {
    const credential = this.credential(context)
    let response = await this.fetchImpl(`https://analyticsdata.googleapis.com/v1beta/properties/${id}:runReport`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(20_000)
    })
    if (response.status === 401 && credential.refreshToken && credential.clientId && credential.clientSecret) {
      credential.accessToken = await this.refreshAccessToken(credential)
      if (context.credentialRef) this.credentials.set(context.credentialRef, JSON.stringify(credential))
      response = await this.fetchImpl(`https://analyticsdata.googleapis.com/v1beta/properties/${id}:runReport`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(20_000)
      })
    }
    const body = await response.json() as JsonRecord
    if (!response.ok) {
      const error = body.error && typeof body.error === 'object' ? body.error as JsonRecord : null
      throw new Error(String(error?.message ?? `GA4 Data API 请求失败（${response.status}）。`))
    }
    return body
  }

  private async refreshAccessToken(credential: Ga4Credential): Promise<string> {
    const response = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credential.refreshToken,
        client_id: credential.clientId,
        client_secret: credential.clientSecret
      }),
      signal: AbortSignal.timeout(20_000)
    })
    const body = await response.json() as JsonRecord
    if (!response.ok || typeof body.access_token !== 'string') {
      throw new Error(String(body.error_description ?? body.error ?? 'GA4 OAuth Token 刷新失败。'))
    }
    return body.access_token
  }
}
