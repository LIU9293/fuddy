import type { EvidenceRef } from '../../shared/contracts'
import { CredentialVault } from '../services/credential-vault'
import type { ConnectorAdapter, ConnectorCollection, ConnectorContext, ConnectorProbe, ConnectorSignal } from './types'
import { timeoutSignal } from '../services/cancellation'

type FetchLike = typeof fetch
type JsonRecord = Record<string, unknown>

interface ProjectAgentConfig {
  baseUrl: string
  statusPath: string
  agentName: string
}

export function normalizeProjectAgentConfig(config: Record<string, string | number | boolean>): ProjectAgentConfig {
  const rawUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : ''
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new Error('Fuddy Base URL 无效。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Fuddy Base URL 只允许无内嵌凭证的 HTTP/HTTPS 地址。')
  }
  const statusPath = typeof config.statusPath === 'string' && config.statusPath.trim() ? config.statusPath.trim() : '/status'
  if (!statusPath.startsWith('/') || statusPath.startsWith('//')) throw new Error('Fuddy status path 必须以单个 / 开头。')
  const agentName = typeof config.agentName === 'string' && config.agentName.trim() ? config.agentName.trim() : 'Fuddy'
  return { baseUrl: url.toString().replace(/\/$/, ''), statusPath, agentName }
}

function evidence(config: ProjectAgentConfig): EvidenceRef[] {
  return [{ label: config.agentName, uri: `${config.baseUrl}${config.statusPath}` }]
}

export class ProjectAgentConnector implements ConnectorAdapter {
  readonly kind = 'project-agent' as const

  constructor(
    private readonly credentials: CredentialVault,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async test(context: ConnectorContext): Promise<ConnectorProbe> {
    const config = normalizeProjectAgentConfig(context.config)
    await this.status(config, context)
    return { summary: `连接正常：${config.agentName}`, evidenceRefs: evidence(config) }
  }

  async collect(context: ConnectorContext): Promise<ConnectorCollection> {
    const config = normalizeProjectAgentConfig(context.config)
    const data = await this.status(config, context)
    const status = String(data.status ?? data.health ?? 'unknown').toLowerCase()
    const blockers = Array.isArray(data.blockers) ? data.blockers.map(String).filter(Boolean) : []
    const unhealthy = ['error', 'failed', 'degraded', 'blocked', 'offline'].includes(status) || blockers.length > 0
    const signal: ConnectorSignal | null = unhealthy ? {
      fingerprint: 'agent-health',
      kind: 'risk',
      title: `${config.agentName} 需要处理`,
      summary: blockers.length > 0 ? blockers.slice(0, 4).join('；') : `Agent status: ${status}`,
      impact: '项目专属 Agent 当前无法稳定执行或存在未处理阻塞。',
      urgency: status === 'offline' || status === 'failed' ? 'high' : 'medium',
      confidence: 0.9,
      suggestedActions: ['打开 Agent Run 分析状态', '检查项目 Agent 服务日志'],
      evidenceRefs: evidence(config),
      source: 'Fuddy Connector'
    } : null
    return {
      summary: `${config.agentName}：${status}${blockers.length ? ` · ${blockers.length} blockers` : ''}`,
      evidenceRefs: evidence(config),
      signal,
      resolvedSignals: signal ? [] : [{ fingerprint: 'agent-health', summary: `${config.agentName} 当前状态正常。`, evidenceRefs: evidence(config) }],
      data
    }
  }

  private async status(config: ProjectAgentConfig, context: ConnectorContext): Promise<JsonRecord> {
    const token = context.credentialRef ? this.credentials.get(context.credentialRef) : null
    const response = await this.fetchImpl(`${config.baseUrl}${config.statusPath}`, {
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      signal: timeoutSignal(20_000, context.cancellationSignal)
    })
    const body = await response.json() as JsonRecord
    if (!response.ok) throw new Error(String(body.error ?? body.message ?? `Fuddy 请求失败（${response.status}）。`))
    return body
  }
}
