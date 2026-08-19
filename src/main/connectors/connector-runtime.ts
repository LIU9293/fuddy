import { randomUUID } from 'node:crypto'
import type {
  ConnectorActionResult,
  ConnectorCatalogItem,
  ConnectorInstance,
  ConnectorRun,
  ConfigureCloudflareInput,
  ConfigureGa4Input,
  ConfigureProjectAgentInput,
  ConfigurePostgresInput,
  DecisionItem,
  RunConnectorsResult
} from '../../shared/contracts'
import { evaluateAggressivePermission } from '../../shared/permissions'
import { AppDatabase } from '../services/database'
import { CredentialVault } from '../services/credential-vault'
import { PostgresConnector, quoteMetricView } from './postgres-connector'
import { RepoConnector } from './repo-connector'
import { CloudflareConnector } from './cloudflare-connector'
import { Ga4Connector } from './ga4-connector'
import { normalizeProjectAgentConfig, ProjectAgentConnector } from './project-agent-connector'
import { getProjectAnalyticsProfile, requireAnalyticsProfile } from '../analytics/project-analytics-profiles'
import type { ConnectorAdapter, ConnectorSignal } from './types'
import { throwIfCancelled } from '../services/cancellation'

export const connectorCatalog: ConnectorCatalogItem[] = [
  {
    kind: 'repo',
    label: 'Local Repo',
    description: '安全读取 Git 元数据、Agent 指令与项目 Skill 状态，不读取代码内容或凭证。',
    availability: 'built-in',
    authType: 'none',
    capabilities: ['连接检查', 'Repo 巡检', '证据回投']
  },
  {
    kind: 'postgres',
    label: 'PostgreSQL',
    description: '通过项目级只读账号和预定义数据视图读取业务指标。',
    availability: 'built-in',
    authType: 'credential',
    capabilities: ['只读查询', '指标快照', '异常信号']
  },
  {
    kind: 'cloudflare',
    label: 'Cloudflare',
    description: '连接 Pages、Workers、Web Analytics 与 R2 元数据。',
    availability: 'built-in',
    authType: 'credential',
    capabilities: ['部署健康', '流量分析', 'R2 元数据']
  },
  {
    kind: 'ga4',
    label: 'Google Analytics 4',
    description: '读取网站流量、来源、事件和转化漏斗。',
    availability: 'built-in',
    authType: 'oauth',
    capabilities: ['流量来源', '事件分析', '转化漏斗']
  },
  {
    kind: 'project-agent',
    label: 'Fuddy',
    description: '连接项目专属 Agent 或远程自动化能力。',
    availability: 'built-in',
    authType: 'project-api',
    capabilities: ['任务派发', '状态读取', '结果回投']
  }
]

function decisionFromSignal(
  connector: ConnectorInstance,
  signal: ConnectorSignal
): DecisionItem {
  return {
    id: `connector-${connector.id}-${signal.fingerprint}`,
    projectId: connector.projectId,
    dedupeKey: `connector:${connector.id}:${signal.fingerprint}`,
    kind: signal.kind,
    title: signal.title,
    summary: signal.summary,
    impact: signal.impact,
    urgency: signal.urgency,
    confidence: signal.confidence,
    suggestedActions: signal.suggestedActions,
    evidenceRefs: signal.evidenceRefs,
    status: 'inbox',
    source: signal.source,
    createdAt: new Date().toISOString()
  }
}

export function parsePostgresConnectionString(connectionString: string): {
  config: Record<string, string | number | boolean>
  password: string
} {
  if (connectionString.length > 4_000) throw new Error('PostgreSQL 连接字符串过长。')

  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error('PostgreSQL 连接字符串格式无效。')
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('连接字符串必须使用 postgres:// 或 postgresql://。')
  }

  const host = url.hostname
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  const user = decodeURIComponent(url.username)
  if (!host || !database || !user) {
    throw new Error('连接字符串必须包含 host、database 和 user。')
  }

  const port = url.port ? Number(url.port) : 5432
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PostgreSQL 端口无效。')

  const sslParameter = url.searchParams.get('sslmode')
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  const sslMode = sslParameter === 'disable' || (!sslParameter && isLocal) ? 'disable' : 'require'

  return {
    config: { host, port, database, user, sslMode },
    password: url.password ? decodeURIComponent(url.password) : ''
  }
}

export class ConnectorRuntime {
  private readonly adapters = new Map<string, ConnectorAdapter>()

  constructor(
    private readonly database: AppDatabase,
    private readonly credentialVault: CredentialVault
  ) {
    const repoConnector = new RepoConnector()
    const postgresConnector = new PostgresConnector(credentialVault)
    const cloudflareConnector = new CloudflareConnector(credentialVault)
    const ga4Connector = new Ga4Connector(credentialVault)
    const projectAgentConnector = new ProjectAgentConnector(credentialVault)
    this.adapters.set(repoConnector.kind, repoConnector)
    this.adapters.set(postgresConnector.kind, postgresConnector)
    this.adapters.set(cloudflareConnector.kind, cloudflareConnector)
    this.adapters.set(ga4Connector.kind, ga4Connector)
    this.adapters.set(projectAgentConnector.kind, projectAgentConnector)
  }

  async configurePostgres(input: ConfigurePostgresInput): Promise<ConnectorActionResult> {
    const project = this.database.listProjects().find((candidate) => candidate.id === input.projectId)
    if (!project) throw new Error('没有找到对应项目。')
    const parsed = parsePostgresConnectionString(input.connectionString)

    const metricView = input.metricView?.trim() || ''
    if (metricView) quoteMetricView(metricView)
    const analyticsProfile = input.analyticsProfile?.trim()
      || (!metricView ? getProjectAnalyticsProfile(project.id)?.id : undefined)
    if (analyticsProfile) requireAnalyticsProfile(analyticsProfile, project.id)

    const id = `postgres-${project.id}`
    let existingCredentialRef: string | null = null
    try {
      existingCredentialRef = this.database.getConnector(id).credentialRef
    } catch {
      // This is the first configuration for the project.
    }

    const password = parsed.password
    const credentialRef = password ? `connector:${id}:password` : existingCredentialRef
    if (password) this.credentialVault.set(credentialRef as string, password)

    this.database.upsertConnector({
      id,
      projectId: project.id,
      kind: 'postgres',
      name: `${project.name} PostgreSQL`,
      config: { ...parsed.config, metricView, analyticsProfile: analyticsProfile ?? '' },
      credentialRef,
      capabilities: ['health', 'collect', analyticsProfile ? 'analytics-profile' : 'metric-view', 'evidence'],
      sortOrder: 100
    })

    return this.runConnector(id)
  }

  async configureCloudflare(input: ConfigureCloudflareInput): Promise<ConnectorActionResult> {
    const project = this.requireProject(input.projectId)
    const accountId = input.accountId.trim()
    const zoneId = input.zoneId?.trim() || ''
    if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('Cloudflare account ID 无效。')
    if (zoneId && !/^[a-f0-9]{32}$/i.test(zoneId)) throw new Error('Cloudflare zone ID 无效。')
    const id = `cloudflare-${project.id}`
    const credentialRef = this.saveOptionalCredential(id, 'api-token', input.apiToken)
    if (!credentialRef) throw new Error('首次配置 Cloudflare 时必须提供 API Token。')
    this.database.upsertConnector({
      id, projectId: project.id, kind: 'cloudflare', name: `${project.name} Cloudflare`,
      config: { accountId, zoneId }, credentialRef,
      capabilities: ['pages', 'workers', 'r2', 'analytics', 'evidence'], sortOrder: 110
    })
    return this.runConnector(id)
  }

  async configureGa4(input: ConfigureGa4Input): Promise<ConnectorActionResult> {
    const project = this.requireProject(input.projectId)
    const propertyId = input.propertyId.trim().replace(/^properties\//, '')
    if (!/^\d+$/.test(propertyId)) throw new Error('GA4 Property ID 必须是数字。')
    const id = `ga4-${project.id}`
    const supplied = input.accessToken?.trim() ? JSON.stringify({
      accessToken: input.accessToken.trim(),
      refreshToken: input.refreshToken?.trim() || '',
      clientId: input.clientId?.trim() || '',
      clientSecret: input.clientSecret?.trim() || ''
    }) : undefined
    const credentialRef = this.saveOptionalCredential(id, 'oauth', supplied)
    if (!credentialRef) throw new Error('首次配置 GA4 时必须提供 OAuth Access Token。')
    this.database.upsertConnector({
      id, projectId: project.id, kind: 'ga4', name: `${project.name} GA4`,
      config: { propertyId }, credentialRef,
      capabilities: ['traffic', 'channels', 'events', 'key-events', 'evidence'], sortOrder: 120
    })
    return this.runConnector(id)
  }

  async configureProjectAgent(input: ConfigureProjectAgentInput): Promise<ConnectorActionResult> {
    const project = this.requireProject(input.projectId)
    const normalized = normalizeProjectAgentConfig({
      baseUrl: input.baseUrl,
      statusPath: input.statusPath ?? '/status',
      agentName: input.agentName
    })
    const id = `project-agent-${project.id}`
    const credentialRef = this.saveOptionalCredential(id, 'api-key', input.apiKey)
    this.database.upsertConnector({
      id, projectId: project.id, kind: 'project-agent', name: `${project.name} · ${normalized.agentName}`,
      config: { ...normalized }, credentialRef,
      capabilities: ['health', 'status', 'blockers', 'evidence'], sortOrder: 130
    })
    return this.runConnector(id)
  }

  async runConnector(id: string, cancellationSignal?: AbortSignal): Promise<ConnectorActionResult> {
    throwIfCancelled(cancellationSignal)
    const connector = this.database.getConnector(id)
    const startedAt = new Date().toISOString()

    if (!connector.enabled) {
      const run: ConnectorRun = {
        id: randomUUID(),
        connectorId: connector.id,
        projectId: connector.projectId,
        status: 'failed',
        startedAt,
        completedAt: startedAt,
        summary: 'Connector 已停用。',
        evidenceRefs: [],
        decisionId: null,
        data: null
      }
      this.database.createConnectorRun(run)
      return { connector, run, decision: null, message: run.summary }
    }

    this.database.markConnectorRunning(id, startedAt)
    const adapter = this.adapters.get(connector.kind)

    try {
      if (!adapter) throw new Error(`${connector.kind} Connector 尚未安装。`)
      const permissionIntent = {
        tool: `${connector.kind}-connector`,
        action: 'collect project evidence',
        target: typeof connector.config.repoPath === 'string' ? connector.config.repoPath : connector.name,
        projectRoot: typeof connector.config.repoPath === 'string' ? connector.config.repoPath : undefined,
        description: 'Read connector-scoped metadata and return evidence to the decision inbox.',
        handlesCredentials: Boolean(connector.credentialRef || connector.config.credentialSource),
        production: connector.config.credentialSource === 'env-file'
      }
      const permission = evaluateAggressivePermission(permissionIntent)
      this.database.recordPermissionEvaluation(permissionIntent, permission)
      if (permission.decision === 'requires-confirmation') {
        throw new Error(`Connector 巡检需要确认：${permission.reason}`)
      }
      const collection = await adapter.collect({
        config: connector.config,
        credentialRef: connector.credentialRef,
        cancellationSignal
      })
      throwIfCancelled(cancellationSignal)
      const completedAt = new Date().toISOString()
      const activeInspection = collection.signal ? this.database.applyDecisionInspection({
        projectId: connector.projectId,
        dedupeKey: `connector:${connector.id}:${collection.signal.fingerprint}`,
        observationKey: `connector:${connector.id}:${collection.signal.fingerprint}:${completedAt.slice(0, 10)}`,
        state: 'active',
        observedAt: completedAt,
        summary: collection.signal.summary,
        evidenceRefs: collection.signal.evidenceRefs,
        decision: decisionFromSignal(connector, collection.signal)
      }) : null
      const resolvedInspections = (collection.resolvedSignals ?? []).map((signal) =>
        this.database.applyDecisionInspection({
          projectId: connector.projectId,
          dedupeKey: `connector:${connector.id}:${signal.fingerprint}`,
          observationKey: `connector:${connector.id}:${signal.fingerprint}:${completedAt.slice(0, 10)}:resolved`,
          state: 'resolved',
          observedAt: completedAt,
          summary: signal.summary,
          evidenceRefs: signal.evidenceRefs
        })
      )
      const decision = activeInspection?.decision
        ?? resolvedInspections.find((item) => item.resolved)?.decision
        ?? null
      const run: ConnectorRun = {
        id: randomUUID(),
        connectorId: connector.id,
        projectId: connector.projectId,
        status: 'completed',
        startedAt,
        completedAt,
        summary: collection.summary,
        evidenceRefs: collection.evidenceRefs,
        decisionId: decision?.id ?? null,
        data: collection.data ?? null
      }
      this.database.createConnectorRun(run)
      const updated = this.database.completeConnector(id, 'connected', completedAt, null)
      return {
        connector: updated,
        run,
        decision,
        message: activeInspection?.created && decision
          ? `巡检完成，并向决策收件箱投递了“${decision.title}”。`
          : activeInspection?.updated && decision
            ? `巡检完成，并用最新证据更新了“${decision.title}”。`
            : resolvedInspections.some((item) => item.resolved) && decision
              ? `巡检完成，并将“${decision.title}”标记为已完成。`
          : '巡检完成；当前状态已记录，没有产生新的决策项。'
      }
    } catch (error) {
      const completedAt = new Date().toISOString()
      const message = error instanceof Error ? error.message : 'Connector 运行失败。'
      const run: ConnectorRun = {
        id: randomUUID(),
        connectorId: connector.id,
        projectId: connector.projectId,
        status: 'failed',
        startedAt,
        completedAt,
        summary: message,
        evidenceRefs: [],
        decisionId: null,
        data: null
      }
      this.database.createConnectorRun(run)
      const updated = this.database.completeConnector(id, 'error', completedAt, message)
      throwIfCancelled(cancellationSignal)
      return { connector: updated, run, decision: null, message }
    }
  }

  async runConnectors(projectId: string | null, cancellationSignal?: AbortSignal): Promise<RunConnectorsResult> {
    throwIfCancelled(cancellationSignal)
    const connectors = this.database
      .listConnectors()
      .filter((connector) => connector.enabled && (!projectId || connector.projectId === projectId))
    const results = await Promise.all(connectors.map((connector) => (
      this.runConnector(connector.id, cancellationSignal)
    )))
    throwIfCancelled(cancellationSignal)
    return {
      results,
      succeeded: results.filter((result) => result.run.status === 'completed').length,
      failed: results.filter((result) => result.run.status === 'failed').length
    }
  }

  setEnabled(id: string, enabled: boolean): ConnectorInstance {
    return this.database.setConnectorEnabled(id, enabled)
  }

  private requireProject(projectId: string) {
    const project = this.database.listProjects().find((candidate) => candidate.id === projectId)
    if (!project) throw new Error('没有找到对应项目。')
    return project
  }

  private saveOptionalCredential(connectorId: string, suffix: string, value?: string): string | null {
    let existing: string | null = null
    try { existing = this.database.getConnector(connectorId).credentialRef } catch { /* first configuration */ }
    const secret = value?.trim()
    if (!secret) return existing
    const reference = `connector:${connectorId}:${suffix}`
    this.credentialVault.set(reference, secret)
    return reference
  }
}
