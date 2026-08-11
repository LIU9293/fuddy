import { randomUUID } from 'node:crypto'
import type {
  AgentRun,
  AgentRunArtifact,
  AskMorningBriefingResult,
  AgentSessionUpdate,
  BriefingMessage,
  DailyBriefing,
  DecisionItem,
  ExecuteWorkAssistantActionInput,
  ExecuteWorkAssistantActionResult,
  DecisionRemediation,
  GenerateMorningBriefingResult,
  MorningBriefing,
  Project,
  ProjectGoal,
  WorkAssistantActionProposal,
  WorkAssistantImageAttachment,
  WorkAssistantTaskContext,
  WorkAssistantTaskReference
} from '../../shared/contracts'
import { AppDatabase } from './database'
import { DailyBriefingService } from './daily-briefing'
import { previousCompleteShanghaiDate } from './daily-briefing-time'
import type { AgentRuntime } from './pi-runtime'
import type { GoalTrackingService } from './goal-tracking'
import { buildProjectPulses, type ProjectPulse } from './project-pulse'
import type { WorkspaceAgentActions } from './workspace-agent-actions'
import type { DecisionRemediationService } from './decision-remediation'
import type { WorkAssistantAgentRuntime } from './work-assistant-agent'

const MAX_NARRATION_CHARACTERS = 620
const CHINESE_CHARACTERS_PER_SECOND = 4

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function metric(data: Record<string, unknown>, key: string): Record<string, unknown> {
  return object(object(data.metrics)[key])
}

function pct(value: unknown): string {
  const numeric = number(value)
  return `${numeric > 0 ? '+' : ''}${numeric.toFixed(1)}%`
}

function shortenNarration(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= MAX_NARRATION_CHARACTERS) return compact
  const candidate = compact.slice(0, MAX_NARRATION_CHARACTERS - 1)
  const sentenceEnd = Math.max(candidate.lastIndexOf('。'), candidate.lastIndexOf('！'))
  return `${candidate.slice(0, sentenceEnd > 420 ? sentenceEnd + 1 : candidate.length)}。`
}

function rankDecision(item: DecisionItem): number {
  const urgency = item.urgency === 'high' ? 30 : item.urgency === 'medium' ? 20 : 10
  const kind = item.kind === 'risk' ? 4 : item.kind === 'decision' ? 3 : item.kind === 'opportunity' ? 2 : 1
  return urgency + kind
}

function topDecisions(decisions: DecisionItem[]): DecisionItem[] {
  return decisions
    .filter((item) => item.status === 'inbox' || item.status === 'in_progress' || item.status === 'waiting')
    .sort((a, b) => rankDecision(b) - rankDecision(a) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, 4)
}

export function buildMorningBriefingContent(input: {
  reportDate: string
  roombaseBriefing: DailyBriefing | null
  decisions: DecisionItem[]
  remediations?: DecisionRemediation[]
  projects: Project[]
  goals?: ProjectGoal[]
  runs?: AgentRun[]
  artifacts?: AgentRunArtifact[]
  generatedAt?: string
  executionWindowStartAt?: string | null
  pulses?: ProjectPulse[]
}): Pick<MorningBriefing, 'headline' | 'body' | 'narration' | 'estimatedDurationSeconds' | 'signalIds'> {
  const { reportDate, roombaseBriefing, projects } = input
  const metrics = roombaseBriefing?.metrics ?? null
  let roombaseLine: string | null = null
  if (metrics) {
    const newUsers = metric(metrics, 'newUsers')
    const firstBookings = metric(metrics, 'firstBookingUsers')
    const bookings = metric(metrics, 'bookings')
    const netPaid = metric(metrics, 'netPaidCny')
    roombaseLine = `Roombase：新用户 ${number(newUsers.value)}，较 7 日均值 ${pct(newUsers.vsSevenDayAveragePct)}；首次预订用户 ${number(firstBookings.value)}，较基线 ${pct(firstBookings.vsSevenDayAveragePct)}；预订 ${number(bookings.value)}，净实收 ¥${number(netPaid.value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}。`
  }

  const pulses = input.pulses ?? buildProjectPulses({
    projects,
    goals: input.goals ?? [],
    decisions: input.decisions,
    remediations: input.remediations ?? [],
    runs: input.runs ?? [],
    artifacts: input.artifacts ?? [],
    projectBriefings: roombaseBriefing ? [roombaseBriefing] : [],
    dataSummaries: roombaseLine ? { roombase: roombaseLine } : {},
    reportDate,
    generatedAt: input.generatedAt ?? `${reportDate}T16:00:00.000Z`,
    executionWindowStartAt: input.executionWindowStartAt
  })
  const attention = pulses.filter((pulse) => pulse.status === 'attention')
  const stale = pulses.filter((pulse) => pulse.status === 'stale')
  const setup = pulses.filter((pulse) => pulse.status === 'setup')
  const headline = attention.length > 0
    ? `今天有 ${attention.length} 个项目需要优先跟进，其他项目也都有明确的下一步。`
    : stale.length > 0
      ? `今天有 ${stale.length} 个项目出现停滞，需要恢复推进。`
      : setup.length > 0
        ? `今天没有新的高风险信号，但有 ${setup.length} 个项目需要建立当前焦点。`
        : '今天没有新的高风险信号，重点是继续推进每个项目的下一步。'
  const statusLabels: Record<ProjectPulse['status'], string> = {
    attention: '需要跟进',
    moving: '有新进展',
    stale: '推进停滞',
    quiet: '按计划推进',
    setup: '待建立焦点'
  }
  const coverageLabels: Record<ProjectPulse['dataCoverage'], string> = {
    'business-and-execution': '业务数据与执行证据',
    business: '业务数据',
    execution: '目标、任务与执行证据',
    'context-only': '仅项目现状；不推测业务变化'
  }
  const pulseRank: Record<ProjectPulse['status'], number> = {
    attention: 50,
    stale: 40,
    moving: 30,
    setup: 20,
    quiet: 10
  }
  const rankedPulses = [...pulses].sort((left, right) => pulseRank[right.status] - pulseRank[left.status])
  const priorityLines = rankedPulses.slice(0, 3).map((pulse, index) =>
    `${index + 1}. **${pulse.projectName}：** ${pulse.nextAction}`)
  const projectSections = pulses.flatMap((pulse) => [
    `### ${pulse.projectName} · ${statusLabels[pulse.status]}`,
    '',
    `- **当前焦点：** ${pulse.currentFocus}`,
    `- **已验证：** ${pulse.verifiedChanges.join(' ')}`,
    ...(pulse.pendingItems.length > 0 ? [`- **待处理：** ${pulse.pendingItems.join(' ')}`] : []),
    `- **今天下一步：** ${pulse.nextAction}`,
    `- **证据覆盖：** ${coverageLabels[pulse.dataCoverage]}`,
    ''
  ])

  const body = [
    `# ${reportDate} · 每日简报`,
    '',
    `> ${headline}`,
    '',
    '## 今天最值得处理',
    '',
    ...priorityLines,
    '',
    '## 各项目脉搏',
    '',
    ...projectSections
  ].join('\n')

  const narration = shortenNarration([
    '早上好，下面是今天的跨项目简报。',
    headline,
    rankedPulses[0] ? `如果今天只能先做一件事，建议先处理 ${rankedPulses[0].projectName}：${rankedPulses[0].nextAction}` : '',
    ...pulses.map((pulse) => `${pulse.projectName}，${pulse.headline}${pulse.pendingItems[0] ?? ''}今天建议：${pulse.nextAction}`),
    '以上是今天的简报。你可以继续问我某个项目的证据、优先级或下一步。'
  ].join(''))

  return {
    headline,
    body,
    narration,
    estimatedDurationSeconds: Math.min(180, Math.max(20, Math.ceil(narration.length / CHINESE_CHARACTERS_PER_SECOND))),
    signalIds: [...new Set(rankedPulses.flatMap((pulse) => pulse.decisionIds))].slice(0, 6)
  }
}

function buildAgentBriefingPrompt(reportDate: string, pulses: ProjectPulse[]): string {
  return `请根据下面已经由系统核验的 Project Pulse，生成今天的跨项目中文简报。只输出一个 JSON 对象，不要代码块。

JSON 结构：
{"headline":"","body":"","narration":""}

规则：
- body 使用 Markdown，必须包含“今天最值得处理”和“各项目脉搏”，并覆盖每一个项目。
- 每个项目说明当前焦点、已验证变化、待处理事项和一个今天下一步。
- 没有业务 Connector 不等于没有内容；可以总结目标、任务、Run 与产物，但不得推测业务变化。
- 未解决事项即使不是今天新出现的，也要继续提醒；不要声称创建了新的收件箱事项。
- 如果 Project Pulse 已提供 PR、CI、Review 或发布进度，必须保留对应 PR 编号和“生产问题是否仍存在”的事实，下一步使用 Pulse 给出的当前关口，不得退回最初的排查建议。
- PR 已提交、CI 通过或已经合并都不等于生产问题解决；只有 Pulse 明确写明生产问题已解除时才能这样表述。
- narration 是自然的中文口播，最多 ${MAX_NARRATION_CHARACTERS} 个字符、三分钟内；优先讲需要跟进、停滞和有新产物的项目。
- 只能使用输入事实，不得添加数字、原因、完成状态或用户反馈。
- headline 最多 80 个中文字符。

报告日期：${reportDate}
Project Pulse：
${JSON.stringify(pulses, null, 2)}`
}

function parseAgentBriefing(
  value: string,
  projects: ProjectPulse[]
): Pick<MorningBriefing, 'headline' | 'body' | 'narration' | 'estimatedDurationSeconds'> | null {
  const cleaned = value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
    const headline = typeof parsed.headline === 'string' ? parsed.headline.trim() : ''
    const body = typeof parsed.body === 'string' ? parsed.body.trim() : ''
    const narration = typeof parsed.narration === 'string' ? shortenNarration(parsed.narration) : ''
    if (!headline || !body || !narration) return null
    if (!projects.every((project) => body.includes(project.projectName))) return null
    const requiredPullRequests = [...new Set(projects.flatMap((project) =>
      `${project.verifiedChanges.join(' ')} ${project.nextAction}`.match(/PR #\d+/g) ?? []))]
    if (!requiredPullRequests.every((reference) => body.includes(reference))) return null
    return {
      headline: headline.slice(0, 160),
      body,
      narration,
      estimatedDurationSeconds: Math.min(180, Math.max(20, Math.ceil(narration.length / CHINESE_CHARACTERS_PER_SECOND)))
    }
  } catch {
    return null
  }
}

function resolveTaskContext(
  database: AppDatabase,
  reference: WorkAssistantTaskReference | null
): WorkAssistantTaskContext | null {
  if (!reference) return null
  const project = database.listProjects().find((item) => item.id === reference.projectId)
  const goal = database.listGoals(reference.projectId).find((item) => item.id === reference.goalId)
  const milestone = goal?.milestones.find((item) => item.id === reference.milestoneId)
  if (!project || !goal || !milestone) throw new Error('没有找到要开始的项目任务。')
  return {
    ...reference,
    projectName: project.name,
    goalTitle: goal.title,
    milestoneTitle: milestone.title
  }
}

export class MorningBriefingService {
  constructor(
    private readonly database: AppDatabase,
    private readonly dailyBriefingService: DailyBriefingService,
    private readonly agentRuntime: AgentRuntime,
    private readonly goalTrackingService?: GoalTrackingService,
    private readonly workspaceAgentActions?: WorkspaceAgentActions,
    private readonly decisionRemediationService?: DecisionRemediationService,
    private readonly workAssistantAgent?: WorkAssistantAgentRuntime
  ) {}

  async generate(): Promise<GenerateMorningBriefingResult> {
    const generatedAt = new Date().toISOString()
    const reportDate = previousCompleteShanghaiDate()
    try {
      await this.goalTrackingService?.checkDueGoals()
    } catch {
      // A goal check failure must not prevent the morning briefing from arriving.
    }
    const projectResult = await this.dailyBriefingService.generate('roombase')
    try {
      await this.decisionRemediationService?.sync()
    } catch {
      // GitHub state is enrichment. Missing remote evidence must not erase the last verified state.
    }
    const projects = this.database.listProjects().filter((project) => project.status === 'active')
    const decisions = this.database.listDecisions()
    const remediations = this.database.listDecisionRemediations()
    const goals = this.database.listGoals()
    const runs = this.database.listRuns()
    const artifacts = runs.flatMap((run) => this.database.listAgentRunArtifacts(run.id))
    const roombaseBriefing = projectResult.briefing.status === 'completed' ? projectResult.briefing : null
    const previousMorningBriefing = this.database.listMorningBriefings()
      .find((item) => item.status === 'completed' && item.id !== `morning-${reportDate}`) ?? null
    let roombaseLine: string | null = null
    if (roombaseBriefing?.metrics) {
      const data = roombaseBriefing.metrics
      const newUsers = metric(data, 'newUsers')
      const firstBookings = metric(data, 'firstBookingUsers')
      const bookings = metric(data, 'bookings')
      const netPaid = metric(data, 'netPaidCny')
      roombaseLine = `Roombase：新用户 ${number(newUsers.value)}，较 7 日均值 ${pct(newUsers.vsSevenDayAveragePct)}；首次预订用户 ${number(firstBookings.value)}，较基线 ${pct(firstBookings.vsSevenDayAveragePct)}；预订 ${number(bookings.value)}，净实收 ¥${number(netPaid.value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}。`
    }
    const pulses = buildProjectPulses({
      projects,
      goals,
      decisions,
      remediations,
      runs,
      artifacts,
      projectBriefings: roombaseBriefing ? [roombaseBriefing] : [],
      dataSummaries: roombaseLine ? { roombase: roombaseLine } : {},
      reportDate,
      generatedAt,
      executionWindowStartAt: previousMorningBriefing?.generatedAt ?? null
    })
    const deterministicContent = buildMorningBriefingContent({
      reportDate,
      roombaseBriefing,
      decisions,
      remediations,
      projects,
      goals,
      runs,
      artifacts,
      generatedAt,
      executionWindowStartAt: previousMorningBriefing?.generatedAt ?? null,
      pulses
    })
    let content = deterministicContent
    let generation: MorningBriefing['generation'] = 'deterministic'
    if (this.agentRuntime.isConfigured()) {
      try {
        const generated = parseAgentBriefing(
          await this.agentRuntime.run(buildAgentBriefingPrompt(reportDate, pulses)),
          pulses
        )
        if (generated) {
          content = { ...deterministicContent, ...generated }
          generation = 'agent'
        }
      } catch {
        // The deterministic Project Pulse summary remains available if the model is unavailable.
      }
    }
    const briefing = this.database.upsertMorningBriefing({
      id: `morning-${reportDate}`,
      reportDate,
      timezone: 'Asia/Shanghai',
      status: 'completed',
      ...content,
      sourceBriefingIds: projectResult.briefing.status === 'completed' ? [projectResult.briefing.id] : [],
      generatedAt,
      error: projectResult.briefing.status === 'failed' ? projectResult.briefing.error : null,
      generation
    })
    return { briefing, createdSignals: projectResult.createdSignals }
  }

  async ask(
    briefingId: string | null,
    question: string,
    taskReference: WorkAssistantTaskReference | null = null,
    attachments: WorkAssistantImageAttachment[] = [],
    onUpdate: (update: AgentSessionUpdate) => void = () => undefined
  ): Promise<AskMorningBriefingResult> {
    const requestedBriefing = briefingId ? this.database.getMorningBriefingById(briefingId) : null
    if (briefingId && !requestedBriefing) throw new Error('没有找到这份每日简报。')
    const briefing = requestedBriefing ?? this.database.listMorningBriefings().find((item) => item.status === 'completed') ?? null
    const previousHistory = this.database.listBriefingMessages()
    const explicitTaskContext = resolveTaskContext(this.database, taskReference)
    const taskContext = explicitTaskContext
    const now = new Date().toISOString()
    const userMessage = this.database.createBriefingMessage({
      id: randomUUID(),
      briefingId: briefing?.id ?? null,
      role: 'user',
      content: question,
      attachments,
      taskContext,
      linkedRunId: null,
      createdAt: now
    })
    let content: string
    let proposals: WorkAssistantActionProposal[] = []
    let linkedRunId: string | null = null
    if (this.workAssistantAgent?.isConfigured()) {
      try {
        const result = await this.workAssistantAgent.runTurn({
          question,
          attachments,
          taskContext,
          history: previousHistory,
          onUpdate
        })
        content = result.content
        proposals = result.proposals
        linkedRunId = result.linkedRunId
      } catch (error) {
        const reason = error instanceof Error ? error.message : '未知错误'
        content = `**工作助理 Agent 当前不可用**（${reason}）\n\n本轮没有执行任何工具或修改。`
      }
    } else {
      content = '**尚未配置可用的工作助理 Agent**\n\n本轮没有执行任何工具或修改。'
    }
    const assistantMessage = this.database.createBriefingMessage({
      id: randomUUID(),
      briefingId: briefing?.id ?? null,
      role: 'assistant',
      content,
      attachments: [],
      taskContext,
      linkedRunId,
      actions: proposals,
      createdAt: new Date().toISOString()
    })
    return { userMessage, assistantMessage }
  }

  async executeAction(input: ExecuteWorkAssistantActionInput): Promise<ExecuteWorkAssistantActionResult> {
    if (!this.workspaceAgentActions) throw new Error('工作助理能力尚未初始化。')
    return await this.workspaceAgentActions.executeProposal(input)
  }
}
