import type { DailyBriefing, DecisionItem, GenerateDailyBriefingResult } from '../../shared/contracts'
import { ConnectorRuntime } from '../connectors/connector-runtime'
import type { AgentRuntime } from './pi-runtime'
import { AppDatabase, type DecisionInspectionInput } from './database'
import { previousCompleteShanghaiDate } from './daily-briefing-time'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return '无可比基线'
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`
}

function buildAgentPrompt(
  projectName: string,
  data: Record<string, unknown>,
  currentInbox: Array<
    Pick<
      DecisionItem,
      'id' | 'dedupeKey' | 'title' | 'summary' | 'status' | 'waitingReason' | 'resolutionSummary' | 'lastSeenAt'
    >
  >
): string {
  return `你是 ${projectName} 的每日项目助理。请根据下面由只读 SQL 已计算好的聚合数据，写一份中文每日项目总结。

规则：
- 只解释给定数字，禁止补造原因、指标或用户故事。
- 核心变化必须优先对比此前 7 个完整自然日均值，也可补充前一日。
- firstBookingUsers 不是同日注册转化率，不得写成转化率。
- 小绝对值噪音不要升级成风险。
- “相关历史事项”包含待处理、进行中、等待中和已完成记录；同一 dedupeKey 不是今天的新问题。如果新证据与已完成状态冲突，应描述为问题仍存在或重新出现。
- 不要因为今天没有新动作就重复创建建议，也不要仅凭缺少数据宣称问题已经完成。
- 最多 3 个发现、3 个动作，明确哪些原因仍未知。
- 输出 Markdown。第一段使用引用块写一句结论，然后是“关键变化”“今天建议”“口径提醒”。

聚合数据：
${JSON.stringify(data, null, 2)}

相关历史事项：
${JSON.stringify(currentInbox, null, 2)}`
}

export interface DailyBriefingStrategy {
  analyticsProfile: string
  headline(data: Record<string, unknown>): string
  render(data: Record<string, unknown>): string
  inspections(data: Record<string, unknown>, observedAt: string): DecisionInspectionInput[]
}

const dailyBriefingStrategies = new Map<string, DailyBriefingStrategy>()

export function registerDailyBriefingStrategy(strategy: DailyBriefingStrategy): void {
  if (dailyBriefingStrategies.has(strategy.analyticsProfile)) {
    throw new Error(`Daily briefing strategy 已注册：${strategy.analyticsProfile}`)
  }
  dailyBriefingStrategies.set(strategy.analyticsProfile, strategy)
}

function genericHeadline(projectName: string): string {
  return `${projectName} 的聚合指标已更新，请结合目标和历史基线检查变化。`
}

function renderGenericBriefing(projectName: string, data: Record<string, unknown>): string {
  const reportDate = String(data.reportDate ?? '未知日期')
  const metrics = object(data.metrics)
  const lines = Object.entries(metrics)
    .slice(0, 12)
    .map(([key, value]) => {
      const record = object(value)
      const metricValue = record.value ?? value
      const baseline =
        typeof record.vsSevenDayAveragePct === 'number' ? `，较 7 日均值 ${pct(record.vsSevenDayAveragePct)}` : ''
      return `- ${key}：${String(metricValue)}${baseline}`
    })
  return [
    `# ${projectName} · ${reportDate} 项目总结`,
    '',
    `> ${genericHeadline(projectName)}`,
    '',
    '## 关键变化',
    '',
    ...(lines.length > 0 ? lines : ['- 当前 Profile 没有返回可展示的标准指标。']),
    '',
    '## 今天建议',
    '',
    '1. 结合项目目标检查异常指标，并在获得证据后再创建行动项。',
    '',
    '## 口径提醒',
    '',
    '- 本总结只使用 Connector 返回的聚合数据，不推断未提供的原因。'
  ].join('\n')
}

function headlineFromBody(body: string, fallback: string): string {
  const line = body
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith('>'))
  if (!line) return fallback
  const headline = line.replace(/^>\s*/, '').replace(/[*_]/g, '').trim()
  return headline && headline.length <= 160 ? headline : fallback
}

export class DailyBriefingService {
  constructor(
    private readonly database: AppDatabase,
    private readonly connectorRuntime: ConnectorRuntime,
    private readonly agentRuntime: AgentRuntime
  ) {}

  async generate(projectId: string): Promise<GenerateDailyBriefingResult> {
    const project = this.database.listProjects().find((candidate) => candidate.id === projectId)
    if (!project) throw new Error(`项目不存在：${projectId}`)
    const connector = this.database
      .listConnectors()
      .find((candidate) => candidate.projectId === projectId && candidate.kind === 'postgres')
    if (!connector) throw new Error(`项目 ${project.name} 尚未配置 PostgreSQL Connector。`)
    const analyticsProfile =
      typeof connector.config.analyticsProfile === 'string' ? connector.config.analyticsProfile : null
    const strategy = analyticsProfile ? dailyBriefingStrategies.get(analyticsProfile) : undefined
    const fallbackDate = previousCompleteShanghaiDate()
    const generatedAt = new Date().toISOString()

    try {
      const connectorResult = await this.connectorRuntime.runConnector(`postgres-${projectId}`)
      if (connectorResult.run.status !== 'completed' || !connectorResult.run.data) {
        throw new Error(connectorResult.message || '生产数据聚合失败。')
      }
      const data = connectorResult.run.data
      const reportDate = typeof data.reportDate === 'string' ? data.reportDate : fallbackDate
      const fallbackHeadline = strategy?.headline(data) ?? genericHeadline(project.name)
      let body = strategy?.render(data) ?? renderGenericBriefing(project.name, data)
      let generation: DailyBriefing['generation'] = 'deterministic'

      if (this.agentRuntime.isConfigured()) {
        try {
          const currentInbox = this.database
            .listDecisions()
            .filter((item) => item.projectId === projectId)
            .map((item) => ({
              id: item.id,
              dedupeKey: item.dedupeKey,
              title: item.title,
              summary: item.summary,
              status: item.status,
              waitingReason: item.waitingReason,
              resolutionSummary: item.resolutionSummary,
              lastSeenAt: item.lastSeenAt
            }))
          body = await this.agentRuntime.run(buildAgentPrompt(project.name, data, currentInbox))
          generation = 'agent'
        } catch {
          // A model outage must not prevent the morning briefing from being available.
        }
      }

      const inspections = strategy?.inspections(data, generatedAt) ?? []
      const inspected = inspections.map((item) => this.database.applyDecisionInspection(item))
      const createdSignals = inspected.flatMap((item) => (item.created && item.decision ? [item.decision] : []))
      const activeSignalIds = inspected.flatMap((item) => (!item.resolved && item.decision ? [item.decision.id] : []))
      const briefing = this.database.upsertDailyBriefing({
        id: `daily-${projectId}-${reportDate}`,
        projectId,
        reportDate,
        timezone: 'Asia/Shanghai',
        status: 'completed',
        headline: headlineFromBody(body, fallbackHeadline),
        body,
        metrics: data,
        signalIds: activeSignalIds,
        generatedAt,
        error: null,
        generation
      })
      return { briefing, createdSignals }
    } catch (error) {
      const message = error instanceof Error ? error.message : '每日项目总结生成失败。'
      const briefing = this.database.upsertDailyBriefing({
        id: `daily-${projectId}-${fallbackDate}`,
        projectId,
        reportDate: fallbackDate,
        timezone: 'Asia/Shanghai',
        status: 'failed',
        headline: '今日项目总结尚未生成',
        body: '生产数据聚合未完成，请检查只读 Connector 后重试。',
        metrics: null,
        signalIds: [],
        generatedAt,
        error: message,
        generation: 'deterministic'
      })
      return { briefing, createdSignals: [] }
    }
  }
}
