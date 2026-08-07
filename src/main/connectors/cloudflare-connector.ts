import type { EvidenceRef } from '../../shared/contracts'
import { CredentialVault } from '../services/credential-vault'
import type { ConnectorAdapter, ConnectorCollection, ConnectorContext, ConnectorProbe, ConnectorSignal } from './types'

type FetchLike = typeof fetch
type JsonRecord = Record<string, unknown>

interface CloudflareConfig {
  accountId: string
  zoneId: string | null
}

function configFrom(context: ConnectorContext): CloudflareConfig {
  const accountId = typeof context.config.accountId === 'string' ? context.config.accountId.trim() : ''
  const zoneId = typeof context.config.zoneId === 'string' && context.config.zoneId.trim() ? context.config.zoneId.trim() : null
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('Cloudflare account ID 无效。')
  if (zoneId && !/^[a-f0-9]{32}$/i.test(zoneId)) throw new Error('Cloudflare zone ID 无效。')
  return { accountId, zoneId }
}

function evidence(config: CloudflareConfig): EvidenceRef[] {
  return [{ label: 'Cloudflare Account', uri: `https://dash.cloudflare.com/${config.accountId}` }]
}

function items(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object') : []
}

export class CloudflareConnector implements ConnectorAdapter {
  readonly kind = 'cloudflare' as const

  constructor(
    private readonly credentials: CredentialVault,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async test(context: ConnectorContext): Promise<ConnectorProbe> {
    const config = configFrom(context)
    await this.request('/user/tokens/verify', context)
    const account = await this.request(`/accounts/${config.accountId}`, context)
    const name = account.result && typeof account.result === 'object'
      ? String((account.result as JsonRecord).name ?? config.accountId)
      : config.accountId
    return { summary: `连接正常：${name}`, evidenceRefs: evidence(config) }
  }

  async collect(context: ConnectorContext): Promise<ConnectorCollection> {
    const config = configFrom(context)
    const [pagesResponse, workersResponse, bucketsResponse] = await Promise.all([
      this.request(`/accounts/${config.accountId}/pages/projects`, context),
      this.request(`/accounts/${config.accountId}/workers/scripts`, context),
      this.request(`/accounts/${config.accountId}/r2/buckets`, context)
    ])
    const pages = items(pagesResponse.result)
    const workers = items(workersResponse.result)
    const buckets = items((bucketsResponse.result as JsonRecord | undefined)?.buckets ?? bucketsResponse.result)
    const failedProjects = pages.filter((project) => {
      const deployment = project.latest_deployment && typeof project.latest_deployment === 'object'
        ? project.latest_deployment as JsonRecord
        : null
      const stages = deployment?.stages && typeof deployment.stages === 'object' ? deployment.stages as JsonRecord : null
      const deploy = stages?.deploy && typeof stages.deploy === 'object' ? stages.deploy as JsonRecord : null
      return ['failure', 'failed'].includes(String(deploy?.status ?? deployment?.status ?? '').toLowerCase())
    })
    let analytics: JsonRecord | null = null
    if (config.zoneId) {
      try {
        analytics = await this.analytics(config.zoneId, context)
      } catch (error) {
        analytics = { error: error instanceof Error ? error.message : 'Analytics query failed' }
      }
    }
    const signal: ConnectorSignal | null = failedProjects.length > 0 ? {
      fingerprint: 'pages-deployment-failures',
      kind: 'risk',
      title: `${failedProjects.length} 个 Cloudflare Pages 项目部署异常`,
      summary: failedProjects.slice(0, 5).map((project) => String(project.name ?? 'unnamed')).join('、'),
      impact: '最新生产部署未成功，可能影响网站发布或回滚状态。',
      urgency: 'high',
      confidence: 0.95,
      suggestedActions: ['查看 Pages 部署日志', '派发 Coding Agent 修复失败构建'],
      evidenceRefs: evidence(config),
      source: 'Cloudflare Connector'
    } : null
    return {
      summary: `Cloudflare：${pages.length} Pages · ${workers.length} Workers · ${buckets.length} R2 buckets${failedProjects.length ? ` · ${failedProjects.length} 部署异常` : ''}`,
      evidenceRefs: evidence(config),
      signal,
      resolvedSignals: signal ? [] : [{
        fingerprint: 'pages-deployment-failures',
        summary: 'Cloudflare Pages 当前没有最新部署失败。',
        evidenceRefs: evidence(config)
      }],
      data: { pages, workers, buckets, analytics }
    }
  }

  private token(context: ConnectorContext): string {
    if (!context.credentialRef) throw new Error('Cloudflare Connector 缺少 API Token。')
    const token = this.credentials.get(context.credentialRef)
    if (!token) throw new Error('Cloudflare API Token 不存在或无法解密。')
    return token
  }

  private async request(path: string, context: ConnectorContext): Promise<JsonRecord> {
    const response = await this.fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { Authorization: `Bearer ${this.token(context)}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000)
    })
    const body = await response.json() as JsonRecord
    if (!response.ok || body.success === false) {
      const errors = items(body.errors).map((item) => String(item.message ?? item.code ?? '')).filter(Boolean).join('；')
      throw new Error(errors || `Cloudflare API 请求失败（${response.status}）。`)
    }
    return body
  }

  private async analytics(zoneId: string, context: ConnectorContext): Promise<JsonRecord> {
    const query = `query ProjectAgentZone($zoneTag: string!) {
      viewer { zones(filter: { zoneTag: $zoneTag }) {
        httpRequests1dGroups(limit: 7, orderBy: [date_DESC]) {
          dimensions { date }
          sum { requests pageViews bytes cachedRequests threats }
          uniq { uniques }
        }
      } }
    }`
    const response = await this.fetchImpl('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token(context)}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ query, variables: { zoneTag: zoneId } }),
      signal: AbortSignal.timeout(20_000)
    })
    const body = await response.json() as JsonRecord
    if (!response.ok || Array.isArray(body.errors)) throw new Error(`Cloudflare Analytics API 请求失败（${response.status}）。`)
    return body
  }
}
