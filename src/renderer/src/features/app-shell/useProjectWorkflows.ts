import { useRef, useState } from 'react'
import type {
  AgentRun,
  AgentSessionUpdate,
  AppBootstrap,
  AppBootstrapDataKey,
  DecisionItem,
  DecisionStatus,
  GoalMilestone,
  GoalPriority,
  Project,
  ProjectGoal,
  WorkAssistantImageAttachment,
  WorkAssistantTaskReference
} from '../../../../shared/contracts'
import { buildMilestoneDraftPrompt } from '../../views/InboxGoalsView'
import { morningBriefingBootstrapKeys, mutableBootstrapKeys } from './app-bootstrap-state'

interface UseProjectWorkflowsOptions {
  bootstrap: AppBootstrap | null
  setBootstrap: React.Dispatch<React.SetStateAction<AppBootstrap | null>>
  refreshDomains: (keys: readonly AppBootstrapDataKey[]) => Promise<void>
  onNotice: (notice: string | null) => void
  onOpenRun: (runId: string) => void
  onOpenProject: (projectId: string, section: 'settings') => void
  onAgentRunPrefill: (prefill: { runId: string; prompt: string; requestId: string } | null) => void
}

export interface ProjectWorkflowController {
  checkingGoalId: string | null
  handlingDecisionId: string | null
  briefingGenerating: boolean
  updateDecisionStatus: (id: string, status: DecisionStatus) => Promise<void>
  updateGoalPriority: (id: string, priority: GoalPriority) => Promise<void>
  completeMilestone: (goalId: string, milestoneId: string) => Promise<void>
  deleteMilestone: (goalId: string, milestoneId: string) => Promise<void>
  checkGoal: (id: string) => Promise<void>
  startMilestoneTask: (goal: ProjectGoal, milestone: GoalMilestone) => Promise<void>
  handleDecision: (item: DecisionItem) => Promise<void>
  generateMorningBriefing: () => Promise<void>
  askMorningBriefing: (
    briefingId: string | null,
    question: string,
    taskContext: WorkAssistantTaskReference | null,
    attachments: WorkAssistantImageAttachment[],
    onUpdate: (update: AgentSessionUpdate) => void
  ) => Promise<void>
  executeWorkAssistantAction: (messageId: string, proposalId: string, optionId: string) => Promise<void>
}

export function useProjectWorkflows(options: UseProjectWorkflowsOptions): ProjectWorkflowController {
  const [checkingGoalId, setCheckingGoalId] = useState<string | null>(null)
  const [handlingDecisionId, setHandlingDecisionId] = useState<string | null>(null)
  const [briefingGenerating, setBriefingGenerating] = useState(false)
  const startingMilestoneIds = useRef<Set<string>>(new Set())

  async function updateDecisionStatus(id: string, status: DecisionStatus): Promise<void> {
    const updated = await window.projectAgent.updateDecisionStatus(id, status)
    options.setBootstrap((current) => current ? {
      ...current,
      decisions: current.decisions.map((item) => item.id === id ? updated : item)
    } : current)
  }

  async function updateGoalPriority(id: string, priority: GoalPriority): Promise<void> {
    const updated = await window.projectAgent.updateGoalPriority(id, priority)
    options.setBootstrap((current) => current ? {
      ...current,
      goals: current.goals.map((goal) => goal.id === id ? updated : goal)
    } : current)
  }

  async function updateMilestone(
    goalId: string,
    operation: () => Promise<ProjectGoal>,
    successNotice: string,
    failureNotice: string
  ): Promise<void> {
    try {
      const updated = await operation()
      options.setBootstrap((current) => current ? {
        ...current,
        goals: current.goals.map((goal) => goal.id === goalId ? updated : goal)
      } : current)
      options.onNotice(successNotice)
    } catch (error) {
      options.onNotice(error instanceof Error ? error.message : failureNotice)
    }
  }

  async function completeMilestone(goalId: string, milestoneId: string): Promise<void> {
    await updateMilestone(
      goalId,
      () => window.projectAgent.completeGoalMilestone(goalId, milestoneId),
      '里程碑已标记完成。',
      '无法标记里程碑完成。'
    )
  }

  async function deleteMilestone(goalId: string, milestoneId: string): Promise<void> {
    await updateMilestone(
      goalId,
      () => window.projectAgent.deleteGoalMilestone(goalId, milestoneId),
      '里程碑已删除。',
      '无法删除里程碑。'
    )
  }

  async function checkGoal(id: string): Promise<void> {
    if (checkingGoalId) return
    setCheckingGoalId(id)
    options.onNotice(null)
    try {
      const result = await window.projectAgent.checkGoal(id)
      options.onNotice(result.message)
      await options.refreshDomains(['goals', 'decisions', 'decisionRemediations'])
    } catch (error) {
      options.onNotice(error instanceof Error ? error.message : '目标检查失败。')
    } finally {
      setCheckingGoalId(null)
    }
  }

  async function startMilestoneTask(goal: ProjectGoal, milestone: GoalMilestone): Promise<void> {
    if (startingMilestoneIds.current.has(milestone.id)) return
    const project = options.bootstrap?.projects.find((item) => item.id === goal.projectId)
    if (!project) {
      options.onNotice('没有找到这个任务所属的项目。')
      return
    }
    startingMilestoneIds.current.add(milestone.id)
    options.onNotice(null)
    try {
      const existing = options.bootstrap?.runs.find((run) => activeMilestoneRun(run, project, goal, milestone))
      const detail = existing
        ? await window.projectAgent.getAgentRun(existing.id)
        : await window.projectAgent.createAgentRunDraft({
            projectId: project.id,
            goalId: goal.id,
            milestoneId: milestone.id,
            title: milestone.title,
            draftPrompt: buildMilestoneDraftPrompt(project, goal, milestone)
          })
      await options.refreshDomains(['runs'])
      options.onOpenRun(detail.run.id)
    } catch (error) {
      options.onNotice(error instanceof Error ? error.message : 'Agent Run 创建失败。')
    } finally {
      startingMilestoneIds.current.delete(milestone.id)
    }
  }

  async function handleDecision(item: DecisionItem): Promise<void> {
    if (handlingDecisionId) return
    if (!options.bootstrap) return
    setHandlingDecisionId(item.id)
    options.onNotice(null)
    try {
      const existing = options.bootstrap.runs.find(
        (run) => run.decisionId === item.id && run.status !== 'completed' && run.status !== 'cancelled'
      )
      const detail = existing
        ? await window.projectAgent.getAgentRun(existing.id)
        : await window.projectAgent.createAgentRunDraft({
            projectId: item.projectId,
            decisionId: item.id,
            provider: options.bootstrap.providerSettings.codingAgents.defaultAgent,
            title: `处理 · ${item.title}`,
            draftPrompt: item.summary
          })
      await updateDecisionStatus(item.id, 'in_progress')
      await options.refreshDomains(['runs'])
      options.onOpenRun(detail.run.id)
    } catch (error) {
      options.onNotice(error instanceof Error ? error.message : 'Agent Run 创建失败。')
    } finally {
      setHandlingDecisionId(null)
    }
  }

  async function generateMorningBriefing(): Promise<void> {
    setBriefingGenerating(true)
    options.onNotice(null)
    try {
      const result = await window.projectAgent.generateMorningBriefing()
      options.onNotice(
        result.briefing.status === 'completed'
          ? `已生成 ${result.briefing.reportDate} 跨项目简报，新增 ${result.createdSignals.length} 条决策信号。`
          : `简报暂未生成：${result.briefing.error ?? '数据聚合失败'}`
      )
      await options.refreshDomains(morningBriefingBootstrapKeys)
    } finally {
      setBriefingGenerating(false)
    }
  }

  async function askMorningBriefing(
    briefingId: string | null,
    question: string,
    taskContext: WorkAssistantTaskReference | null,
    attachments: WorkAssistantImageAttachment[],
    onUpdate: (update: AgentSessionUpdate) => void
  ): Promise<void> {
    await window.projectAgent.askMorningBriefing({
      requestId: crypto.randomUUID(),
      briefingId,
      question,
      attachments,
      taskContext
    }, onUpdate)
    await options.refreshDomains(morningBriefingBootstrapKeys)
  }

  async function executeWorkAssistantAction(messageId: string, proposalId: string, optionId: string): Promise<void> {
    try {
      const result = await window.projectAgent.executeWorkAssistantAction({ messageId, proposalId, optionId })
      options.onNotice(result.notice)
      if (result.navigation?.kind === 'agent-run') {
        options.onOpenRun(result.navigation.id)
        options.onAgentRunPrefill(result.navigation.draftPrompt ? {
          runId: result.navigation.id,
          prompt: result.navigation.draftPrompt,
          requestId: crypto.randomUUID()
        } : null)
      } else if (result.navigation?.kind === 'project') {
        options.onOpenProject(result.navigation.id, 'settings')
      }
      await options.refreshDomains(mutableBootstrapKeys)
    } catch (error) {
      options.onNotice(error instanceof Error ? error.message : 'Action 执行失败。')
    }
  }

  return {
    checkingGoalId,
    handlingDecisionId,
    briefingGenerating,
    updateDecisionStatus,
    updateGoalPriority,
    completeMilestone,
    deleteMilestone,
    checkGoal,
    startMilestoneTask,
    handleDecision,
    generateMorningBriefing,
    askMorningBriefing,
    executeWorkAssistantAction
  }
}

function activeMilestoneRun(
  run: AgentRun,
  project: Project,
  goal: ProjectGoal,
  milestone: GoalMilestone
): boolean {
  return run.projectId === project.id
    && run.goalId === goal.id
    && run.milestoneId === milestone.id
    && run.status !== 'completed'
    && run.status !== 'cancelled'
}
