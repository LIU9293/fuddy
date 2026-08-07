import { randomUUID } from 'node:crypto'
import type {
  AgentRun,
  AgentRunArtifact,
  AskMorningBriefingResult,
  AgentSessionUpdate,
  BriefingMessage,
  DailyBriefing,
  DecisionItem,
  GenerateMorningBriefingResult,
  MorningBriefing,
  Project,
  ProjectGoal,
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
    .filter((item) => item.status === 'inbox')
    .sort((a, b) => rankDecision(b) - rankDecision(a) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, 4)
}

export function buildMorningBriefingContent(input: {
  reportDate: string
  roombaseBriefing: DailyBriefing | null
  decisions: DecisionItem[]
  projects: Project[]
  goals?: ProjectGoal[]
  runs?: AgentRun[]
  artifacts?: AgentRunArtifact[]
  generatedAt?: string
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
    runs: input.runs ?? [],
    artifacts: input.artifacts ?? [],
    projectBriefings: roombaseBriefing ? [roombaseBriefing] : [],
    dataSummaries: roombaseLine ? { roombase: roombaseLine } : {},
    reportDate,
    generatedAt: input.generatedAt ?? `${reportDate}T16:00:00.000Z`
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

function buildQuestionPrompt(input: {
  briefing: MorningBriefing | null
  question: string
  decisions: DecisionItem[]
  history: BriefingMessage[]
  goals: ProjectGoal[]
  projects: Project[]
  taskContext: WorkAssistantTaskContext | null
}): string {
  return `你是用户的工作助理。这个频道用于跨项目讨论、规划和推进工作；每日简报只是频道中的一种上下文，不是对话边界。

要求：
- 使用 Markdown 和简洁中文，先给结论，再给依据和下一步。
- Markdown 加粗结束符后如果紧跟正文，必须加一个空格，例如“**结论：** 下一步”，不要输出“**结论：**下一步”。
- 简单问题直接回答；复杂问题才使用短标题或列表，不要机械套模板。
- 建议必须具体、可执行，并说明最关键的判断依据。
- 使用提供的项目现状、目标、里程碑、决策和简报上下文；不知道就明确说明。
- 如果有“当前开始的任务”，先确认完成标准，再给出可以立即执行的第一步；不要因为开始任务就把里程碑标记为完成。
- 不要编造项目数据或原因。
- 不要输出隐藏思考过程，只给结论、证据和必要说明。
- 最多 400 个中文字。

当前开始的任务：
${input.taskContext ? JSON.stringify(input.taskContext, null, 2) : '无'}

项目现状：
${JSON.stringify(input.projects.map((project) => ({
    id: project.id,
    name: project.name,
    stage: project.profile.stage,
    mission: project.profile.mission,
    vision: project.profile.vision,
    currentState: project.profile.currentState
  })), null, 2)}

最近一份每日简报：
${input.briefing?.body ?? '尚未生成；仍可根据项目、目标和对话上下文工作。'}

当前待处理决策：
${JSON.stringify(input.decisions.slice(0, 8).map((item) => ({
    projectId: item.projectId,
    title: item.title,
    summary: item.summary,
    urgency: item.urgency,
    actions: item.suggestedActions
  })), null, 2)}

当前项目目标：
${JSON.stringify(input.goals.slice(0, 12).map((goal) => ({
    projectId: goal.projectId,
    title: goal.title,
    priority: goal.priority,
    status: goal.status,
    progress: goal.progress,
    metric: goal.metric,
    deadline: goal.deadline,
    agentSummary: goal.agentSummary,
    milestones: goal.milestones.map((item) => ({ title: item.title, status: item.status }))
  })), null, 2)}

最近对话：
${input.history.slice(-6).map((message) => `${message.role}: ${message.content}${
    message.attachments.length > 0
      ? ` [图片：${message.attachments.map((attachment) => attachment.name).join('、')}]`
      : ''
  }`).join('\n')}

用户问题：${input.question}`
}

function deterministicAnswer(
  question: string,
  briefing: MorningBriefing | null,
  decisions: DecisionItem[],
  projects: Project[],
  projectBriefings: DailyBriefing[],
  goals: ProjectGoal[],
  taskContext: WorkAssistantTaskContext | null
): string {
  const priorities = topDecisions(decisions)
  const normalized = question.toLowerCase()
  const roombase = projectBriefings.find((item) => item.projectId === 'roombase')

  if (taskContext) {
    return `已进入 **${taskContext.projectName}** 的任务“**${taskContext.milestoneTitle}**”。先确认完成标准：需要有可核验的产出，并能说明它如何推进目标“${taskContext.goalTitle}”。第一步建议先列出现状、缺口和需要的账号或素材；确认后再决定由我调用 Browser、Computer Use 或 Coding Agent 执行哪一部分。开始任务不会自动把里程碑标记为完成。`
  }

  if (/目标|进度|里程碑|milestone/.test(normalized)) {
    const relevant = goals.filter((goal) => goal.status === 'active' || goal.status === 'at-risk')
    if (relevant.length === 0) return '当前还没有正在追踪的项目目标。你可以进入项目的「目标」页，让 Agent 根据结果描述创建目标和里程碑。'
    const risky = relevant.filter((goal) => goal.status === 'at-risk')
    return risky.length > 0
      ? `当前有 ${risky.length} 个目标存在风险：${risky.map((goal) => `“${goal.title}”`).join('、')}。建议先查看对应 Check-in 和证据，再决定是否调整执行路径。`
      : `当前有 ${relevant.length} 个目标按计划追踪：${relevant.slice(0, 4).map((goal) => `“${goal.title}” ${Math.round(goal.progress * 100)}%`).join('；')}。`
  }

  if (/最重要|优先|先做|今天做什么/.test(question)) {
    const item = priorities[0]
    return item
      ? `今天最优先处理“${item.title}”。依据是：${item.summary} 建议先做：${item.suggestedActions[0] ?? '确认负责人和完成时间'}。`
      : '今天没有高优先级待处理项，可以按项目既定计划推进。'
  }
  if (/roombase|营收|实收|预订|用户|经营数据/.test(normalized) && roombase?.metrics) {
    const data = roombase.metrics
    const users = metric(data, 'newUsers')
    const first = metric(data, 'firstBookingUsers')
    const bookings = metric(data, 'bookings')
    const paid = metric(data, 'netPaidCny')
    return `Roombase ${roombase.reportDate}：新用户 ${number(users.value)}（较 7 日均值 ${pct(users.vsSevenDayAveragePct)}），首次预订用户 ${number(first.value)}（${pct(first.vsSevenDayAveragePct)}），预订 ${number(bookings.value)}（${pct(bookings.vsSevenDayAveragePct)}），净实收 ¥${number(paid.value).toLocaleString('zh-CN')}（${pct(paid.vsSevenDayAveragePct)}）。当前数字只能确认变化，原因还需要进一步分群分析。`
  }
  const project = projects.find((item) => normalized.includes(item.name.toLowerCase()))
  if (project) {
    const projectDecision = priorities.find((item) => item.projectId === project.id)
    return projectDecision
      ? `${project.name} 当前最值得推进的是“${projectDecision.title}”。${projectDecision.summary} 下一步建议：${projectDecision.suggestedActions[0] ?? project.profile.nextMoves[0]}。`
      : `${project.name} 当前没有新的数据异常；既定目标是${project.profile.mission}，建议继续推进“${project.profile.nextMoves[0]}”。`
  }
  return `${briefing ? `基于最近一份简报，${briefing.headline}` : '当前还没有每日简报，但工作助理仍可继续处理项目任务。'}${priorities[0] ? ` 当前最高优先级是“${priorities[0].title}”。` : ''} 我可以先按已有项目现状、目标和决策回答；更开放的原因分析需要可用的 LLM Provider。`
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
    private readonly workspaceAgentActions?: WorkspaceAgentActions
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
    const projects = this.database.listProjects().filter((project) => project.status === 'active')
    const decisions = this.database.listDecisions()
    const goals = this.database.listGoals()
    const runs = this.database.listRuns()
    const artifacts = runs.flatMap((run) => this.database.listAgentRunArtifacts(run.id))
    const roombaseBriefing = projectResult.briefing.status === 'completed' ? projectResult.briefing : null
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
      runs,
      artifacts,
      projectBriefings: roombaseBriefing ? [roombaseBriefing] : [],
      dataSummaries: roombaseLine ? { roombase: roombaseLine } : {},
      reportDate,
      generatedAt
    })
    const deterministicContent = buildMorningBriefingContent({
      reportDate,
      roombaseBriefing,
      decisions,
      projects,
      goals,
      runs,
      artifacts,
      generatedAt,
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
    const taskContext = resolveTaskContext(this.database, taskReference)
    const now = new Date().toISOString()
    const userMessage = this.database.createBriefingMessage({
      id: randomUUID(),
      briefingId: briefing?.id ?? null,
      role: 'user',
      content: question,
      attachments,
      taskContext,
      createdAt: now
    })
    const decisions = this.database.listDecisions().filter((item) => item.status === 'inbox')
    const history = this.database.listBriefingMessages()
    const goals = this.database.listGoals()
    const projects = this.database.listProjects()
    let content: string
    const recentImages = history
      .slice(-6)
      .flatMap((message) => message.attachments)
      .slice(-4)
    const actionResult = attachments.length === 0
      ? await this.workspaceAgentActions?.tryExecute(question)
      : null
    if (actionResult) {
      content = actionResult
      onUpdate({
        sessionUpdate: 'agent_message_chunk',
        messageId: randomUUID(),
        content: { type: 'text', text: content }
      })
    } else if (this.agentRuntime.isConfigured()) {
      try {
        content = await this.agentRuntime.runStream(
          buildQuestionPrompt({ briefing, question, decisions, history, goals, projects, taskContext }),
          onUpdate,
          recentImages
        )
      } catch (error) {
        const reason = error instanceof Error ? error.message : '未知错误'
        const fallback = deterministicAnswer(
          question,
          briefing,
          decisions,
          projects,
          this.database.listDailyBriefings(),
          goals,
          taskContext
        )
        const imageNotice = attachments.length > 0 ? '\n\n**图片尚未被分析**：当前模型 Provider 不可用。' : ''
        content = `**LLM 当前不可用**（${reason}）${imageNotice}\n\n以下是本地规则给出的临时结果：\n\n${fallback}`
        onUpdate({
          sessionUpdate: 'agent_message_chunk',
          messageId: randomUUID(),
          content: { type: 'text', text: content }
        })
      }
    } else {
      const fallback = deterministicAnswer(
        question,
        briefing,
        decisions,
        projects,
        this.database.listDailyBriefings(),
        goals,
        taskContext
      )
      const imageNotice = attachments.length > 0 ? '\n\n**图片尚未被分析**：请先配置支持图片输入的模型 Provider。' : ''
      content = `**尚未配置可用的 LLM Provider**${imageNotice}\n\n以下是本地规则给出的临时结果：\n\n${fallback}`
      onUpdate({
        sessionUpdate: 'agent_message_chunk',
        messageId: randomUUID(),
        content: { type: 'text', text: content }
      })
    }
    const assistantMessage = this.database.createBriefingMessage({
      id: randomUUID(),
      briefingId: briefing?.id ?? null,
      role: 'assistant',
      content,
      attachments: [],
      taskContext,
      createdAt: new Date().toISOString()
    })
    return { userMessage, assistantMessage }
  }
}
