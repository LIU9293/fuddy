import { randomUUID } from 'node:crypto'
import type {
  CheckGoalResult,
  EvidenceRef,
  GoalCheckIn,
  GoalMilestoneStatus,
  GoalMetric,
  GoalPriority,
  GoalStatus,
  Project,
  ProjectGoal,
  WorkAssistantImageAttachment
} from '../../shared/contracts'
import { AppDatabase } from './database'
import type { AgentRuntime } from './pi-runtime'
import { collectProjectRepoContext, type ProjectRepoContext } from './project-repo-context'
import { evaluateAggressivePermission } from '../../shared/permissions'

type GoalDraft = {
  title?: unknown
  description?: unknown
  metric?: unknown
  deadline?: unknown
  nextCheckInAt?: unknown
  monitoringSources?: unknown
  milestones?: unknown
  currentStateSummary?: unknown
  priority?: unknown
  status?: unknown
}

type CheckDraft = {
  status?: unknown
  progress?: unknown
  currentValue?: unknown
  confidence?: unknown
  summary?: unknown
  milestoneUpdates?: unknown
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown, fallback = '', maxLength = 2_000): string {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maxLength)
    : fallback
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function dateString(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function addDays(value: Date, days: number): string {
  return new Date(value.getTime() + days * 86_400_000).toISOString()
}

function jsonObject(value: string): Record<string, unknown> | null {
  const cleaned = value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return record(JSON.parse(cleaned.slice(start, end + 1)))
  } catch {
    return null
  }
}

function fallbackMilestones(project: Project): string[] {
  const moves = project.profile.nextMoves.filter(Boolean).slice(0, 3)
  return moves.length > 0
    ? moves
    : ['定义成功指标与验收口径', '建立当前数据基线', '完成第一次目标复盘']
}

function normalizeMetric(value: unknown): GoalMetric {
  const metric = record(value)
  return {
    label: text(metric.label, '完成度', 80),
    unit: text(metric.unit, '%', 30),
    baseline: finiteNumber(metric.baseline),
    current: finiteNumber(metric.current),
    target: finiteNumber(metric.target)
  }
}

function calculateProgress(metric: GoalMetric, milestones: ProjectGoal['milestones']): number {
  if (metric.current !== null && metric.target !== null && metric.baseline !== metric.target) {
    const baseline = metric.baseline ?? 0
    return Math.max(0, Math.min(1, (metric.current - baseline) / (metric.target - baseline)))
  }
  if (milestones.length === 0) return 0
  return milestones.filter((item) => item.status === 'completed').length / milestones.length
}

function status(value: unknown, fallback: GoalStatus): GoalStatus {
  return value === 'active' || value === 'at-risk' || value === 'completed'
    ? value
    : fallback
}

function milestoneStatus(value: unknown): GoalMilestoneStatus | null {
  return value === 'pending' || value === 'completed' || value === 'blocked' ? value : null
}

function priority(value: unknown, fallback: GoalPriority): GoalPriority {
  return value === 'P0' || value === 'P1' || value === 'P2' ? value : fallback
}

function creationPrompt(
  project: Project,
  prompt: string,
  repoContext: ProjectRepoContext,
  connectorEvidence: Array<{
    connectorId: string
    status: string
    summary: string
    completedAt: string
    data: Record<string, unknown> | null
  }>
): string {
  return `请把用户的目标描述整理成一个可追踪的项目目标。只输出一个 JSON 对象，不要 Markdown。

规则：
- 不要替用户发明没有提供的具体数字或截止日期；不知道就用 null。
- 必须先用证据判断项目现状，再提出一个最值得追踪的下一目标。
- Git、README 和测试只能证明工程实现与开发活动，不能证明生产用户、收入、转化或市场验证。
- 只有 Connector 数据可以作为业务指标证据；没有生产数据时必须在 currentStateSummary 中明确说明。
- Project Profile 中 source=user 的项目现状是用户确认事实，优先级高于 Repo 和 Agent 推断，不得反驳或降级。
- title 是清晰的结果，不是待办事项。
- priority 只能是 P0、P1、P2；status 只能是 active 或 planned。当前正在推进的事项用 active，未来 Roadmap 用 planned。
- metric 只保留一个主指标，结构为 label、unit、baseline、current、target。
- milestones 为 2 到 5 个可验证的阶段结果，不要写日常过程。
- nextCheckInAt 默认可以是从现在起 7 天后的 ISO 时间。
- monitoringSources 只使用项目已有数据源，或用户明确提到的来源。

JSON 结构：
{"currentStateSummary":"","title":"","description":"","priority":"P0","status":"active","metric":{"label":"","unit":"","baseline":null,"current":null,"target":null},"deadline":null,"nextCheckInAt":null,"monitoringSources":[],"milestones":[{"title":"","dueAt":null}]}

项目：
${JSON.stringify({
    name: project.name,
    mission: project.profile.mission,
    vision: project.profile.vision,
    stage: project.profile.stage,
    focusAreas: project.profile.focusAreas,
    dataSources: project.profile.dataSources,
    nextMoves: project.profile.nextMoves,
    currentState: project.profile.currentState
  }, null, 2)}

通用 Repo 证据：
${JSON.stringify(repoContext, null, 2)}

最近 Connector 证据：
${JSON.stringify(connectorEvidence, null, 2)}

用户描述：${prompt}`
}

function checkPrompt(input: {
  project: Project
  goal: ProjectGoal
  decisions: Array<{
    id: string
    dedupeKey: string | null
    title: string
    summary: string
    status: string
    lastSeenAt: string
  }>
  connectorEvidence: Array<{ summary: string; data: Record<string, unknown> | null; completedAt: string }>
}): string {
  return `请检查一个项目目标的最新进展。只输出一个 JSON 对象，不要 Markdown。

规则：
- 只能依据给出的目标、里程碑、决策和 Connector 数据。
- 不得改变成功指标、目标值或截止日期。
- 没有证据时保守维持现状，并在 summary 中明确缺少什么。
- 收件箱 Item 是持续问题，不是每日消息。已有目标风险仍存在时，status 保持 at-risk，summary 用最新证据更新原 Item；不要创建同义的新问题。
- 只有证据直接证明阻塞已经解除、指标恢复或目标完成时，才把 status 改为 active 或 completed；这会让系统主动完成对应的旧收件箱 Item。
- 缺少新数据、暂时没有异常记录、或无法检查，都不等于问题已完成。
- status 只能是 active、at-risk、completed。
- progress 是 0 到 1。
- milestoneUpdates 只能引用现有里程碑的完整 title。

JSON 结构：
{"status":"active","progress":0,"currentValue":null,"confidence":0.5,"summary":"","milestoneUpdates":[{"title":"","status":"pending"}]}

上下文：
${JSON.stringify(input, null, 2)}`
}

export class GoalTrackingService {
  constructor(
    private readonly database: AppDatabase,
    private readonly agentRuntime: AgentRuntime
  ) {}

  async createFromPrompt(
    projectId: string,
    prompt: string,
    options: {
      priority?: GoalPriority
      status?: Extract<GoalStatus, 'planned' | 'active'>
      attachments?: WorkAssistantImageAttachment[]
      evidenceRefs?: EvidenceRef[]
    } = {}
  ): Promise<ProjectGoal> {
    const project = this.database.listProjects().find((item) => item.id === projectId)
    if (!project) throw new Error('没有找到这个项目。')

    const permissionIntent = {
      tool: 'project-context',
      action: 'read project repository context',
      target: project.profile.repoPath,
      projectRoot: project.profile.repoPath,
      description: '读取 README、Git 历史、变更路径、Package Scripts 与项目 Skill 元数据，用于生成有证据的项目目标。'
    }
    const permission = evaluateAggressivePermission(permissionIntent)
    this.database.recordPermissionEvaluation(permissionIntent, permission)
    if (permission.decision === 'requires-confirmation') {
      throw new Error(`读取项目上下文需要确认：${permission.reason}`)
    }
    const repoContext = await collectProjectRepoContext(project.profile.repoPath)
    const connectorEvidence = this.database.listConnectorRuns()
      .filter((item) => item.projectId === projectId)
      .slice(0, 8)
      .map((item) => ({
        connectorId: item.connectorId,
        status: item.status,
        summary: item.summary,
        completedAt: item.completedAt,
        data: item.data
      }))
    const contextEvidenceRefs: EvidenceRef[] = [
      ...(options.evidenceRefs ?? []),
      ...(project.profile.currentState.source === 'user'
        ? [{ label: '用户确认的项目现状', uri: `project-agent://projects/${project.id}/current-state` }]
        : []),
      ...(repoContext.available
        ? [
            { label: `${project.name} Repo`, uri: `file://${repoContext.repoPath}` },
            ...(repoContext.readme ? [{ label: 'README', uri: `file://${repoContext.repoPath}/README.md` }] : [])
          ]
        : [])
    ]

    let draft: GoalDraft = {}
    let generatedByAgent = false
    if (this.agentRuntime.isConfigured()) {
      try {
        const response = await this.agentRuntime.run(
          creationPrompt(project, prompt, repoContext, connectorEvidence),
          options.attachments ?? []
        )
        draft = jsonObject(response) ?? {}
        generatedByAgent = Boolean(draft.title)
      } catch {
        // A deterministic goal is still useful when the configured provider is temporarily unavailable.
      }
    }

    const now = new Date()
    const nowIso = now.toISOString()
    const draftMilestones = Array.isArray(draft.milestones)
      ? draft.milestones.map(record).map((item) => ({
          title: text(item.title, '', 200),
          dueAt: dateString(item.dueAt)
        })).filter((item) => item.title).slice(0, 5)
      : []
    const milestoneInputs = draftMilestones.length > 0
      ? draftMilestones
      : fallbackMilestones(project).map((title) => ({ title, dueAt: null }))
    const goalId = randomUUID()
    const metric = normalizeMetric(draft.metric)
    const goalPriority = options.priority ?? priority(draft.priority, 'P0')
    const goalStatus: Extract<GoalStatus, 'planned' | 'active'> = options.status ?? (draft.status === 'planned' ? 'planned' : 'active')
    const currentStateSummary = text(
      draft.currentStateSummary,
      project.profile.currentState.source === 'user'
        ? [project.profile.currentState.summary, ...project.profile.currentState.facts].join('；')
        : repoContext.available
        ? `Repo 当前位于 ${repoContext.branch ?? '未知分支'} · ${repoContext.head ?? '未知版本'}，最近有 ${repoContext.recentCommits.length} 条提交记录和 ${repoContext.changedPaths.length} 个未提交文件；尚无可用于验证业务结果的生产 Connector 数据。`
        : '尚未取得可用于判断项目现状的 Repo 或业务数据证据。',
      1_500
    )
    const goal: ProjectGoal = {
      id: goalId,
      projectId,
      title: text(draft.title, prompt, 120),
      description: text(draft.description, prompt, 2_000),
      status: goalStatus,
      priority: goalPriority,
      metric,
      deadline: dateString(draft.deadline),
      nextCheckInAt: goalStatus === 'planned' ? null : dateString(draft.nextCheckInAt) ?? addDays(now, 7),
      progress: 0,
      confidence: generatedByAgent ? 0.7 : 0.5,
      agentSummary: generatedByAgent
        ? currentStateSummary
        : `${currentStateSummary} 模型暂不可用，已按项目上下文建立基础目标。`,
      monitoringSources: Array.isArray(draft.monitoringSources)
        ? draft.monitoringSources.map((item) => text(item, '', 150)).filter(Boolean).slice(0, 10)
        : project.profile.dataSources.slice(0, 6),
      milestones: milestoneInputs.map((item, index) => ({
        id: randomUUID(),
        goalId,
        title: item.title,
        status: 'pending',
        dueAt: item.dueAt,
        evidenceRefs: [],
        sortOrder: index,
        createdAt: nowIso,
        updatedAt: nowIso,
        completedAt: null
      })),
      checkIns: [{
        id: randomUUID(),
        goalId,
        status: goalStatus,
        progress: 0,
        summary: currentStateSummary,
        evidenceRefs: contextEvidenceRefs,
        generation: generatedByAgent ? 'agent' : 'deterministic',
        createdAt: nowIso
      }],
      createdBy: 'agent',
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: null
    }
    return this.database.createGoal(goal)
  }

  async check(goalId: string): Promise<CheckGoalResult> {
    const goal = this.database.getGoal(goalId)
    if (goal.status === 'planned') throw new Error('这个目标还在 Roadmap 中，请先设为进行中。')
    if (goal.status === 'paused') throw new Error('这个目标已暂停，请先恢复后再检查。')
    if (goal.status === 'completed') throw new Error('这个目标已经完成。')
    const project = this.database.listProjects().find((item) => item.id === goal.projectId)
    if (!project) throw new Error('没有找到目标所属项目。')

    const connectorRuns = this.database.listConnectorRuns()
      .filter((item) => item.projectId === goal.projectId && item.status === 'completed')
      .slice(0, 8)
    const evidenceRefs: EvidenceRef[] = connectorRuns.flatMap((item) => item.evidenceRefs).slice(0, 12)
    const decisions = this.database.listDecisions()
      .filter((item) => item.projectId === goal.projectId && (item.goalId === goal.id || item.status === 'inbox' || item.status === 'in_progress' || item.status === 'waiting'))
      .slice(0, 10)
      .map((item) => ({
        id: item.id,
        dedupeKey: item.dedupeKey ?? null,
        title: item.title,
        summary: item.summary,
        status: item.status,
        lastSeenAt: item.lastSeenAt ?? item.createdAt
      }))

    let draft: CheckDraft = {}
    let generation: GoalCheckIn['generation'] = 'deterministic'
    if (this.agentRuntime.isConfigured()) {
      try {
        const response = await this.agentRuntime.run(checkPrompt({
          project,
          goal,
          decisions,
          connectorEvidence: connectorRuns.map((item) => ({
            summary: item.summary,
            data: item.data,
            completedAt: item.completedAt
          }))
        }))
        draft = jsonObject(response) ?? {}
        generation = Object.keys(draft).length > 0 ? 'agent' : 'deterministic'
      } catch {
        // Continue with the evidence-only check below.
      }
    }

    const requestedUpdates = Array.isArray(draft.milestoneUpdates)
      ? draft.milestoneUpdates.map(record).flatMap((item) => {
          const title = text(item.title, '', 200)
          const nextStatus = milestoneStatus(item.status)
          return title && nextStatus && goal.milestones.some((milestone) => milestone.title === title)
            ? [{ title, status: nextStatus }]
            : []
        })
      : []
    if (requestedUpdates.length > 0) this.database.updateGoalMilestones(goal.id, requestedUpdates)

    const updatedMilestones = this.database.getGoal(goal.id).milestones
    const metric = { ...goal.metric }
    const currentValue = finiteNumber(draft.currentValue)
    if (currentValue !== null) metric.current = currentValue
    const calculated = calculateProgress(metric, updatedMilestones)
    const requestedProgress = finiteNumber(draft.progress)
    const measuredProgress = Math.max(0, Math.min(1, requestedProgress ?? calculated))
    const now = new Date()
    const overdue = Boolean(goal.deadline && new Date(goal.deadline).getTime() < now.getTime() && measuredProgress < 1)
    const blocked = updatedMilestones.some((item) => item.status === 'blocked')
    const nextStatus = status(
      draft.status,
      measuredProgress >= 1 ? 'completed' : overdue || blocked ? 'at-risk' : goal.status
    )
    const progress = nextStatus === 'completed' ? 1 : measuredProgress
    const summary = text(
      draft.summary,
      evidenceRefs.length > 0
        ? `已检查 ${connectorRuns.length} 次最新数据采集；目前没有足够证据改变目标状态。`
        : '还没有可用于验证目标进展的 Connector 数据，请先接入或运行相关数据源。',
      1_000
    )
    const checkIn: GoalCheckIn = {
      id: randomUUID(),
      goalId: goal.id,
      status: nextStatus,
      progress,
      summary,
      evidenceRefs,
      generation,
      createdAt: now.toISOString()
    }
    this.database.createGoalCheckIn(checkIn)
    const updated = this.database.updateGoalTracking({
      id: goal.id,
      status: nextStatus,
      progress,
      metric,
      confidence: finiteNumber(draft.confidence) ?? (generation === 'agent' ? 0.7 : 0.45),
      agentSummary: summary,
      nextCheckInAt: nextStatus === 'completed' ? null : addDays(now, 7)
    })

    let createdSignal = null
    let resolvedSignal = false
    const riskDedupeKey = `goal:${goal.id}:at-risk`
    if (nextStatus === 'at-risk') {
      const date = now.toISOString().slice(0, 10)
      const inspected = this.database.applyDecisionInspection({
        projectId: goal.projectId,
        dedupeKey: riskDedupeKey,
        observationKey: `goal:${goal.id}:${date}`,
        state: 'active',
        observedAt: now.toISOString(),
        summary,
        evidenceRefs,
        decision: {
          id: `goal-risk-${goal.id}-${date}`,
          projectId: goal.projectId,
          goalId: goal.id,
          dedupeKey: riskDedupeKey,
          kind: 'risk',
          title: `目标需要关注：${goal.title}`,
          summary,
          impact: '如果不调整路径、资源或预期，这个目标可能无法按当前标准达成。',
          urgency: overdue || blocked ? 'high' : 'medium',
          confidence: updated.confidence,
          suggestedActions: ['查看目标 Check-in 证据', '决定是否调整执行路径'],
          evidenceRefs,
          status: 'inbox',
          source: '目标监控',
          createdAt: now.toISOString()
        }
      })
      createdSignal = inspected.created ? inspected.decision : null
    } else {
      resolvedSignal = this.database.applyDecisionInspection({
        projectId: goal.projectId,
        dedupeKey: riskDedupeKey,
        observationKey: `goal:${goal.id}:${now.toISOString().slice(0, 10)}:resolved`,
        state: 'resolved',
        observedAt: now.toISOString(),
        summary: `最新目标巡检已确认风险解除：${summary}`,
        evidenceRefs
      }).resolved
    }

    return {
      goal: updated,
      checkIn,
      createdSignal,
      message: createdSignal
        ? '检查完成，发现一项需要决策的风险。'
        : resolvedSignal
          ? '检查完成，并根据最新证据将此前的目标风险标记为已完成。'
          : '目标进展已检查并记录。'
    }
  }

  async checkDueGoals(projectId?: string): Promise<CheckGoalResult[]> {
    const now = Date.now()
    const due = this.database.listGoals(projectId).filter((goal) =>
      (goal.status === 'active' || goal.status === 'at-risk') &&
      Boolean(goal.nextCheckInAt && new Date(goal.nextCheckInAt).getTime() <= now)
    )
    const results: CheckGoalResult[] = []
    for (const goal of due.slice(0, 5)) results.push(await this.check(goal.id))
    return results
  }
}
