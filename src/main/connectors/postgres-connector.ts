import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { Client } from 'pg'
import type { EvidenceRef } from '../../shared/contracts'
import { collectRoombaseDailyMetrics } from '../analytics/roombase-daily-metrics'
import { collectVowsDailyMetrics } from '../analytics/vows-daily-metrics'
import { collectAiMarketingDailyMetrics } from '../analytics/ai-marketing-daily-metrics'
import { CredentialVault } from '../services/credential-vault'
import type {
  ConnectorAdapter,
  ConnectorCollection,
  ConnectorContext,
  ConnectorProbe,
  ConnectorSignal
} from './types'

interface PostgresConfig {
  host: string
  port: number
  database: string
  user: string
  sslMode: 'disable' | 'require'
  metricView: string | null
  analyticsProfile: string | null
  privateSource: boolean
}

interface ResolvedConnection {
  config: PostgresConfig
  connectionString?: string
  password?: string
}

interface MetricRow {
  metric_key: string
  metric_value: string
  status: 'info' | 'warning' | 'critical'
  summary: string | null
  observed_at: Date | string | null
}

function requiredString(
  config: Record<string, string | number | boolean>,
  key: string
): string {
  const value = config[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`PostgreSQL Connector 缺少 ${key} 配置。`)
  }
  return value.trim()
}

function parseDirectConfig(config: Record<string, string | number | boolean>): PostgresConfig {
  const portValue = config.port
  const port = typeof portValue === 'number' ? portValue : Number(portValue)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PostgreSQL 端口无效。')
  }

  return {
    host: requiredString(config, 'host'),
    port,
    database: requiredString(config, 'database'),
    user: requiredString(config, 'user'),
    sslMode: config.sslMode === 'disable' ? 'disable' : 'require',
    metricView: typeof config.metricView === 'string' && config.metricView.trim()
      ? config.metricView.trim()
      : null,
    analyticsProfile: typeof config.analyticsProfile === 'string' && config.analyticsProfile.trim()
      ? config.analyticsProfile.trim()
      : null,
    privateSource: false
  }
}

function parseConnectionUrl(connectionString: string, base: Record<string, string | number | boolean>): PostgresConfig {
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error('生产数据库环境变量不是有效的 PostgreSQL URL。')
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('生产数据库环境变量必须使用 PostgreSQL URL。')
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  const user = decodeURIComponent(url.username)
  if (!url.hostname || !database || !user) {
    throw new Error('生产数据库环境变量缺少必要的连接字段。')
  }
  const port = url.port ? Number(url.port) : 5432
  const sslMode = url.searchParams.get('sslmode') === 'disable' ? 'disable' : 'require'
  return {
    host: url.hostname,
    port,
    database,
    user,
    sslMode,
    metricView: typeof base.metricView === 'string' && base.metricView.trim() ? base.metricView.trim() : null,
    analyticsProfile: typeof base.analyticsProfile === 'string' && base.analyticsProfile.trim()
      ? base.analyticsProfile.trim()
      : null,
    privateSource: true
  }
}

function readEnvValue(path: string, key: string): string {
  if (!isAbsolute(path)) throw new Error('生产数据库 env 文件必须使用绝对路径。')
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error('生产数据库环境变量名称无效。')
  const line = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .find((item) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(item))
  if (!line) throw new Error(`生产数据库 env 文件中没有 ${key}。`)
  const value = line.slice(line.indexOf('=') + 1).trim()
  return value.replace(/^(['"])(.*)\1$/, '$2')
}

export function quoteMetricView(value: string): string {
  const parts = value.split('.')
  if (parts.length < 1 || parts.length > 2) throw new Error('指标 View 名称无效。')
  if (!parts.every((part) => /^[A-Za-z_][A-Za-z0-9_$]*$/.test(part))) {
    throw new Error('指标 View 只能使用 schema.view 格式的安全标识符。')
  }
  return parts.map((part) => `"${part}"`).join('.')
}

function evidenceFor(config: PostgresConfig): EvidenceRef[] {
  if (config.analyticsProfile) {
    return [{
      label: `只读分析 Profile · ${config.analyticsProfile}`,
      uri: `postgres://analytics/${config.analyticsProfile}`
    }]
  }
  const suffix = config.metricView ? `/${config.metricView}` : ''
  return [{
    label: config.metricView ? `指标 View · ${config.metricView}` : 'PostgreSQL 连接',
    uri: `postgres://${config.host}:${config.port}/${config.database}${suffix}`
  }]
}

function buildSignal(config: PostgresConfig, rows: MetricRow[]): ConnectorSignal | null {
  const alerts = rows.filter((row) => row.status === 'warning' || row.status === 'critical')
  if (alerts.length === 0) return null

  const criticalCount = alerts.filter((row) => row.status === 'critical').length
  const warningCount = alerts.length - criticalCount
  return {
    // The fingerprint identifies the monitored condition, not today's values.
    // Latest values belong in observations so one inbox item can evolve over time.
    fingerprint: 'metric-alerts',
    kind: criticalCount > 0 ? 'risk' : 'decision',
    title: criticalCount > 0
      ? `${criticalCount} 个关键业务指标异常`
      : `${warningCount} 个业务指标需要关注`,
    summary: alerts.slice(0, 4).map((row) => `${row.metric_key}：${row.summary || row.metric_value}`).join('；'),
    impact: '这些状态由项目维护的只读指标 View 明确标记，建议结合业务目标复核原因和下一步。',
    urgency: criticalCount > 0 ? 'high' : 'medium',
    confidence: 1,
    suggestedActions: ['让助理分析指标变化', '查看指标 View'],
    evidenceRefs: evidenceFor(config),
    source: 'PostgreSQL Connector'
  }
}

export class PostgresConnector implements ConnectorAdapter {
  readonly kind = 'postgres' as const

  constructor(private readonly credentialVault: CredentialVault) {}

  async test(context: ConnectorContext): Promise<ConnectorProbe> {
    const { config, result } = await this.withReadOnlyClient(context, async (client) => {
      const connection = await client.query<{ database: string; username: string }>(`
        SELECT current_database() AS database, current_user AS username
      `)
      return connection.rows[0]
    })

    return {
      summary: config.privateSource
        ? `连接正常：${config.analyticsProfile ?? '生产只读数据库'} · ${result.database}`
        : `连接正常：${result.database} · ${result.username} · ${config.host}:${config.port}`,
      evidenceRefs: evidenceFor(config)
    }
  }

  async collect(context: ConnectorContext): Promise<ConnectorCollection> {
    const resolved = this.resolveConnection(context)
    const config = resolved.config

    if (config.analyticsProfile === 'roombase-daily-v0') {
      const { result: data } = await this.withResolvedReadOnlyClient(resolved, collectRoombaseDailyMetrics)
      return {
        summary: `已计算 Roombase ${data.reportDate} 的完整日指标与 7 日基线。`,
        evidenceRefs: evidenceFor(config),
        signal: null,
        data
      }
    }
    if (config.analyticsProfile === 'vows-growth-v1') {
      const { result: data } = await this.withResolvedReadOnlyClient(resolved, collectVowsDailyMetrics)
      const paidWithoutWedding = Number(data.snapshot.paid_without_wedding ?? 0)
      return {
        summary: `已计算 Vows ${data.reportDate} 的付费、婚礼创建与宾客互动指标。`,
        evidenceRefs: evidenceFor(config),
        signal: paidWithoutWedding > 0 ? {
          fingerprint: 'vows-paid-without-wedding',
          kind: 'risk',
          title: `${paidWithoutWedding} 个已支付订单尚未创建婚礼`,
          summary: '已支付订单与 wedding_id 的交付链路存在缺口。',
          impact: '用户已经付费但未获得核心交付，需优先确认补偿或重试。',
          urgency: 'high', confidence: 1,
          suggestedActions: ['检查支付回调与婚礼创建日志', '逐单确认交付状态'],
          evidenceRefs: evidenceFor(config), source: 'Vows Analytics Profile'
        } : null,
        resolvedSignals: paidWithoutWedding === 0 ? [{
          fingerprint: 'vows-paid-without-wedding', summary: '没有已支付但未创建婚礼的订单。', evidenceRefs: evidenceFor(config)
        }] : [],
        data
      }
    }
    if (config.analyticsProfile === 'ai-marketing-production-v1') {
      const { result: data } = await this.withResolvedReadOnlyClient(resolved, collectAiMarketingDailyMetrics)
      const stuckJobs = Number(data.snapshot.stuck_generation_jobs ?? 0)
      const heartbeatAge = data.snapshot.worker_heartbeat_age_minutes
      const workerStale = heartbeatAge === null || Number(heartbeatAge) > 5
      const unhealthy = stuckJobs > 0 || workerStale
      return {
        summary: `已计算 AI Marketing ${data.reportDate} 的生成、评审与交付指标。`,
        evidenceRefs: evidenceFor(config),
        signal: unhealthy ? {
          fingerprint: 'ai-marketing-production-health',
          kind: 'risk',
          title: 'AI Marketing 素材生产链路需要处理',
          summary: `${stuckJobs} 个停滞任务；Worker 心跳 ${heartbeatAge === null ? '缺失' : `${heartbeatAge} 分钟前`}。`,
          impact: '生成任务可能无法按预期进入评审与交付。', urgency: workerStale ? 'high' : 'medium', confidence: 1,
          suggestedActions: ['检查 generation worker', '查看停滞任务错误与重试状态'],
          evidenceRefs: evidenceFor(config), source: 'AI Marketing Analytics Profile'
        } : null,
        resolvedSignals: unhealthy ? [] : [{
          fingerprint: 'ai-marketing-production-health', summary: '生成任务与 Worker 心跳当前正常。', evidenceRefs: evidenceFor(config)
        }],
        data
      }
    }
    if (config.analyticsProfile) {
      throw new Error(`未知的 PostgreSQL Analytics Profile：${config.analyticsProfile}`)
    }
    if (!config.metricView) {
      const probe = await this.test(context)
      return {
        summary: `${probe.summary} · 尚未配置指标 View`,
        evidenceRefs: probe.evidenceRefs,
        signal: null
      }
    }

    const metricView = quoteMetricView(config.metricView)
    const { result: rows } = await this.withResolvedReadOnlyClient(resolved, async (client) => {
      const result = await client.query<MetricRow>(`
        SELECT metric_key::text, metric_value::text, status::text, summary::text, observed_at
        FROM ${metricView}
        WHERE status::text IN ('info', 'warning', 'critical')
        ORDER BY CASE status::text WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
          observed_at DESC NULLS LAST
        LIMIT 100
      `)
      return result.rows
    })

    const alerts = rows.filter((row) => row.status === 'warning' || row.status === 'critical')
    return {
      summary: `读取 ${rows.length} 个指标，其中 ${alerts.length} 个需要关注。`,
      evidenceRefs: evidenceFor(config),
      signal: buildSignal(config, rows),
      resolvedSignals: alerts.length === 0 ? [{
        fingerprint: 'metric-alerts',
        summary: '本次指标巡检未发现 warning 或 critical 状态，之前的指标异常已解除。',
        evidenceRefs: evidenceFor(config)
      }] : [],
      data: { rows }
    }
  }

  private resolveConnection(context: ConnectorContext): ResolvedConnection {
    if (context.config.credentialSource === 'env-file') {
      const path = requiredString(context.config, 'envFilePath')
      const key = typeof context.config.envKey === 'string' ? context.config.envKey : 'DATABASE_URL'
      const connectionString = readEnvValue(path, key)
      return {
        config: parseConnectionUrl(connectionString, context.config),
        connectionString
      }
    }

    const config = parseDirectConfig(context.config)
    const password = context.credentialRef ? this.credentialVault.get(context.credentialRef) : undefined
    if (context.credentialRef && password === null) {
      throw new Error('PostgreSQL 凭证引用存在，但 Keychain 中没有对应密码。')
    }
    return { config, password: password ?? undefined }
  }

  private async withReadOnlyClient<T>(
    context: ConnectorContext,
    operation: (client: Client) => Promise<T>
  ): Promise<{ config: PostgresConfig; result: T }> {
    return this.withResolvedReadOnlyClient(this.resolveConnection(context), operation)
  }

  private async withResolvedReadOnlyClient<T>(
    resolved: ResolvedConnection,
    operation: (client: Client) => Promise<T>
  ): Promise<{ config: PostgresConfig; result: T }> {
    const { config } = resolved
    const client = new Client({
      ...(resolved.connectionString
        ? { connectionString: resolved.connectionString }
        : {
            host: config.host,
            port: config.port,
            database: config.database,
            user: config.user,
            password: resolved.password,
            ssl: config.sslMode === 'require'
          }),
      application_name: 'project-agent-readonly',
      connectionTimeoutMillis: 8_000,
      query_timeout: 20_000,
      statement_timeout: 20_000
    })

    try {
      await client.connect()
      await client.query('BEGIN TRANSACTION READ ONLY')
      try {
        return { config, result: await operation(client) }
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
      }
    } finally {
      await client.end().catch(() => undefined)
    }
  }
}
