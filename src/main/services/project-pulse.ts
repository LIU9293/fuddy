import type {
  AgentRun,
  AgentRunArtifact,
  DailyBriefing,
  DecisionItem,
  GoalMilestone,
  Project,
  ProjectGoal
} from '../../shared/contracts'

export type ProjectPulseStatus = 'attention' | 'moving' | 'stale' | 'quiet' | 'setup'

export interface ProjectPulse {
  projectId: string
  projectName: string
  status: ProjectPulseStatus
  headline: string
  currentFocus: string
  verifiedChanges: string[]
  pendingItems: string[]
  nextAction: string
  dataCoverage: 'business-and-execution' | 'business' | 'execution' | 'context-only'
  decisionIds: string[]
}

interface BuildProjectPulsesInput {
  projects: Project[]
  goals: ProjectGoal[]
  decisions: DecisionItem[]
  runs: AgentRun[]
  artifacts: AgentRunArtifact[]
  projectBriefings: DailyBriefing[]
  dataSummaries?: Record<string, string>
  reportDate: string
  generatedAt: string
}

const priorityRank: Record<ProjectGoal['priority'], number> = { P0: 0, P1: 1, P2: 2 }
const urgencyRank: Record<DecisionItem['urgency'], number> = { high: 0, medium: 1, low: 2 }

function shanghaiDate(value: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value))
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function daysBetween(left: string, right: string): number {
  const [leftYear, leftMonth, leftDay] = left.split('-').map(Number)
  const [rightYear, rightMonth, rightDay] = right.split('-').map(Number)
  const leftTime = Date.UTC(leftYear, leftMonth - 1, leftDay)
  const rightTime = Date.UTC(rightYear, rightMonth - 1, rightDay)
  return Math.max(0, Math.round((rightTime - leftTime) / 86_400_000))
}

function newestDate(values: Array<string | null | undefined>): string | null {
  const valid = values.filter((value): value is string => Boolean(value))
  return valid.sort((left, right) => right.localeCompare(left))[0] ?? null
}

function activeGoal(goals: ProjectGoal[]): ProjectGoal | null {
  return [...goals]
    .filter((goal) => goal.status === 'active' || goal.status === 'at-risk')
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === 'at-risk' ? -1 : 1
      return priorityRank[left.priority] - priorityRank[right.priority] || right.updatedAt.localeCompare(left.updatedAt)
    })[0] ?? null
}

function firstPendingMilestone(goal: ProjectGoal | null): GoalMilestone | null {
  if (!goal) return null
  return goal.milestones.find((milestone) => milestone.status === 'blocked')
    ?? goal.milestones.find((milestone) => milestone.status === 'pending')
    ?? null
}

function openDecisions(decisions: DecisionItem[]): DecisionItem[] {
  return decisions
    .filter((decision) => decision.status === 'inbox')
    .sort((left, right) => urgencyRank[left.urgency] - urgencyRank[right.urgency] || left.createdAt.localeCompare(right.createdAt))
}

function latestRun(runs: AgentRun[]): AgentRun | null {
  return [...runs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
}

function goalActivityAt(goal: ProjectGoal | null, runs: AgentRun[]): string | null {
  if (!goal) return null
  return newestDate([
    goal.updatedAt,
    ...goal.milestones.map((milestone) => milestone.updatedAt),
    ...runs.filter((run) => run.goalId === goal.id).map((run) => run.updatedAt)
  ])
}

function runChange(run: AgentRun, artifacts: AgentRunArtifact[], milestone: GoalMilestone | null): string {
  const runArtifacts = artifacts.filter((artifact) => artifact.runId === run.id)
  if (runArtifacts.length > 0) {
    const paths = runArtifacts.slice(0, 2).map((artifact) => `「${artifact.relativePath}」`).join('、')
    const pending = milestone && milestone.status !== 'completed' ? '，关联里程碑仍待确认' : ''
    return `Agent Run「${run.title}」已生成产物 ${paths}${pending}。`
  }
  if (run.status === 'completed') return `Agent Run「${run.title}」已经完成。`
  if (run.status === 'idle') return `Agent Run「${run.title}」正在等待继续。`
  if (run.status === 'failed') return `Agent Run「${run.title}」执行失败，需要处理。`
  return `Agent Run「${run.title}」当前状态为${run.status}。`
}

function runNextAction(
  run: AgentRun,
  artifacts: AgentRunArtifact[],
  milestone: GoalMilestone | null
): string | null {
  const runArtifacts = artifacts.filter((artifact) => artifact.runId === run.id)
  if (run.status === 'failed') return `检查 Agent Run「${run.title}」的失败原因并决定是否重试。`
  if (runArtifacts.length > 0 && milestone && milestone.status !== 'completed') {
    return `审阅并确认「${runArtifacts[0].relativePath}」，补齐未确认信息后继续推进「${milestone.title}」。`
  }
  if (run.status === 'idle' && milestone) return `继续 Agent Run「${run.title}」，推进「${milestone.title}」。`
  return null
}

export function buildProjectPulses(input: BuildProjectPulsesInput): ProjectPulse[] {
  const generatedDate = shanghaiDate(input.generatedAt)

  return input.projects.map((project) => {
    const goals = input.goals.filter((goal) => goal.projectId === project.id)
    const decisions = openDecisions(input.decisions.filter((decision) => decision.projectId === project.id))
    const runs = input.runs.filter((run) => run.projectId === project.id)
    const artifacts = input.artifacts.filter((artifact) => artifact.projectId === project.id)
    const briefing = input.projectBriefings.find((item) => item.projectId === project.id && item.status === 'completed') ?? null
    const focusGoal = activeGoal(goals)
    const milestone = firstPendingMilestone(focusGoal)
    const run = latestRun(runs)
    const verifiedChanges: string[] = []
    const pendingItems: string[] = []

    if (briefing) {
      verifiedChanges.push(input.dataSummaries?.[project.id] ?? `最新业务数据结论：${briefing.headline}`)
    }

    if (focusGoal && shanghaiDate(focusGoal.updatedAt) === input.reportDate) {
      verifiedChanges.push(`${focusGoal.priority} 目标「${focusGoal.title}」当前进度 ${Math.round(focusGoal.progress * 100)}%。`)
    }

    if (run && shanghaiDate(run.updatedAt) === input.reportDate) {
      verifiedChanges.push(runChange(run, artifacts, milestone))
    }

    const topDecision = decisions[0] ?? null
    if (topDecision) {
      const age = daysBetween(shanghaiDate(topDecision.createdAt), generatedDate)
      pendingItems.push(age > 0
        ? `「${topDecision.title}」已待处理 ${age} 天。`
        : `「${topDecision.title}」仍待处理。`)
    }

    const activityAt = goalActivityAt(focusGoal, runs)
    const inactiveDays = activityAt ? daysBetween(shanghaiDate(activityAt), generatedDate) : 0
    if (!topDecision && focusGoal && inactiveDays >= 3) {
      pendingItems.push(`目标「${focusGoal.title}」连续 ${inactiveDays} 天没有已验证的推进记录。`)
    }

    if (run?.status === 'failed') pendingItems.push(`Agent Run「${run.title}」执行失败。`)
    if (run?.status === 'idle' && inactiveDays >= 3) pendingItems.push(`Agent Run「${run.title}」已等待继续 ${inactiveDays} 天。`)

    const currentFocus = focusGoal?.title
      || topDecision?.title
      || project.focus
      || project.profile.currentState.summary
      || '尚未确认当前焦点'

    const nextAction = topDecision?.suggestedActions[0]
      ?? (run ? runNextAction(run, artifacts, milestone) : null)
      ?? (milestone ? `开始推进「${milestone.title}」。` : null)
      ?? project.profile.nextMoves.find(Boolean)
      ?? '确认这个项目当前最重要的结果，并创建一个可追踪目标。'

    const hasBusinessData = Boolean(briefing)
    const hasExecutionData = Boolean(focusGoal || run || topDecision || verifiedChanges.length > 0)
    const dataCoverage: ProjectPulse['dataCoverage'] = hasBusinessData && hasExecutionData
      ? 'business-and-execution'
      : hasBusinessData
        ? 'business'
        : hasExecutionData
          ? 'execution'
          : 'context-only'

    let status: ProjectPulseStatus = 'quiet'
    let headline = '没有新的异常，按当前计划继续推进。'
    if (topDecision?.urgency === 'high' || run?.status === 'failed') {
      status = 'attention'
      headline = '有高优先级事项尚未处理。'
    } else if (pendingItems.length > 0) {
      status = 'stale'
      headline = '存在等待处理或长时间没有推进的事项。'
    } else if (run && shanghaiDate(run.updatedAt) === input.reportDate) {
      status = 'moving'
      headline = artifacts.some((artifact) => artifact.runId === run.id)
        ? '已有新产物，等待确认后继续推进。'
        : '最近有执行进展，下一步已经明确。'
    } else if (!focusGoal) {
      status = 'setup'
      headline = '尚未建立当前可追踪焦点。'
    } else if (verifiedChanges.length > 0) {
      status = 'moving'
      headline = '目标正在推进，今天继续完成下一步。'
    }

    if (verifiedChanges.length === 0) verifiedChanges.push('未发现新的已验证业务或执行变化。')

    return {
      projectId: project.id,
      projectName: project.name,
      status,
      headline,
      currentFocus,
      verifiedChanges: verifiedChanges.slice(0, 3),
      pendingItems: pendingItems.slice(0, 2),
      nextAction,
      dataCoverage,
      decisionIds: decisions.map((decision) => decision.id)
    }
  })
}
