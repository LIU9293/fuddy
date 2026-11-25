import { Check, ChevronDown, CircleCheck, LoaderCircle, MoreHorizontal, Play, RefreshCw, Target, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { GoalMilestone, GoalPriority, GoalStatus, Project, ProjectGoal } from '../../../shared/contracts'
import { ConfirmationDialog } from '../components/ConfirmationDialog'
import { ActionMenu, SelectMenu } from '../components/SelectMenu'
import { formatRelativeTime } from './shared'

export function EmptyState({ title, detail }: { title: string; detail: string }): React.JSX.Element {
  return (
    <div className="empty-state">
      <CircleCheck size={32} strokeWidth={1.4} />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  )
}

const goalStatusLabels: Record<GoalStatus, string> = {
  planned: '已规划',
  active: '进行中',
  'at-risk': '有风险',
  completed: '已完成',
  paused: '已暂停'
}

export function formatGoalDate(value: string | null): string {
  if (!value) return '未设置'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
  }).format(new Date(value))
}

export function buildMilestoneDraftPrompt(project: Project, goal: ProjectGoal, milestone: GoalMilestone): string {
  return `请开始推进项目“${project.name}”的 Milestone“${milestone.title}”。

关联目标：${goal.title}
目标说明：${goal.description}

请先检查项目已配置的 Workspace Roots、README/AGENTS.md 和项目文件空间，确认已有证据、素材与产物，再给出并执行可以安全开始的第一步。代码、随产品发布的资源和仓库文档放在对应 Workspace；Marketing、运营、研究、报告和宣传素材等代码无关产物放在项目文件空间，并在回复中列出产物路径。不要因为开始执行就把 Milestone 标记为完成；涉及账号注册、登录、2FA、正式发布、付费或不可逆操作时先等待我确认。`
}

export function GoalsView({
  goals,
  checkingGoalId,
  onCheck,
  onPriority,
  onStartTask,
  onCompleteMilestone,
  onDeleteMilestone
}: {
  goals: ProjectGoal[]
  checkingGoalId: string | null
  onCheck: (id: string) => Promise<void>
  onPriority: (id: string, priority: GoalPriority) => Promise<void>
  onStartTask: (goal: ProjectGoal, milestone: GoalMilestone) => void
  onCompleteMilestone: (goalId: string, milestoneId: string) => Promise<void>
  onDeleteMilestone: (goalId: string, milestoneId: string) => Promise<void>
}): React.JSX.Element {
  const activeCount = goals.filter((goal) => goal.status === 'active').length
  const atRiskCount = goals.filter((goal) => goal.status === 'at-risk').length
  const completedCount = goals.filter((goal) => goal.status === 'completed').length
  const goalScopeKey = [...new Set(goals.map((goal) => goal.projectId))].sort().join(':')
  const [expandedGoalIds, setExpandedGoalIds] = useState<Set<string>>(
    () => new Set(goals.filter((goal) => goal.status === 'active' || goal.status === 'at-risk').map((goal) => goal.id))
  )
  const [milestoneToDelete, setMilestoneToDelete] = useState<{
    goalId: string
    milestoneId: string
    title: string
  } | null>(null)
  const [deletingMilestone, setDeletingMilestone] = useState(false)
  const orderedGoals = [...goals].sort((left, right) => {
    const priorityRank: Record<GoalPriority, number> = { P0: 0, P1: 1, P2: 2 }
    return (
      priorityRank[left.priority] - priorityRank[right.priority] ||
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    )
  })
  const priorityOptions: Array<{ value: GoalPriority; label: string }> = [
    { value: 'P0', label: 'P0' },
    { value: 'P1', label: 'P1' },
    { value: 'P2', label: 'P2' }
  ]

  useEffect(() => {
    setExpandedGoalIds(
      new Set(goals.filter((goal) => goal.status === 'active' || goal.status === 'at-risk').map((goal) => goal.id))
    )
  }, [goalScopeKey])

  function toggleGoal(goalId: string): void {
    setExpandedGoalIds((current) => {
      const next = new Set(current)
      if (next.has(goalId)) next.delete(goalId)
      else next.add(goalId)
      return next
    })
  }

  function renderGoal(goal: ProjectGoal): React.JSX.Element {
    const progress = Math.round(goal.progress * 100)
    const current = goal.metric.current ?? '—'
    const target = goal.metric.target ?? '—'
    const expanded = expandedGoalIds.has(goal.id)

    return (
      <article className={`goal-row goal-${goal.status} ${expanded ? 'is-expanded' : 'is-collapsed'}`} key={goal.id}>
        <div className="goal-row-header">
          <div className="goal-heading-copy">
            <div className="goal-meta">
              <SelectMenu
                className={`goal-priority-menu goal-priority-menu-${goal.priority.toLowerCase()}`}
                value={goal.priority}
                options={priorityOptions}
                onChange={(value) => void onPriority(goal.id, value)}
                ariaLabel="目标优先级"
                position="down"
              />
              <span className={`goal-status-label status-${goal.status}`}>{goalStatusLabels[goal.status]}</span>
            </div>
            <h2>{goal.title}</h2>
            <p>{goal.description}</p>
            {!expanded && (
              <small className="goal-collapsed-summary">
                {goal.metric.label} · {goal.milestones.length} 个里程碑 · {progress}%
              </small>
            )}
          </div>
          <div className="goal-row-controls">
            <button
              type="button"
              className="goal-collapse-button"
              aria-label={expanded ? `折叠目标：${goal.title}` : `展开目标：${goal.title}`}
              aria-expanded={expanded}
              onClick={() => toggleGoal(goal.id)}
            >
              <ChevronDown className={expanded ? 'is-expanded' : ''} size={15} />
            </button>
          </div>
        </div>

        {expanded && (
          <div className="goal-expanded-content">
            <div className="goal-progress-block">
              <div className="goal-progress-heading">
                <span>{goal.metric.label}</span>
                <strong>
                  {current}
                  {goal.metric.unit ? ` ${goal.metric.unit}` : ''} <i>/</i> {target}
                  {goal.metric.unit ? ` ${goal.metric.unit}` : ''}
                </strong>
              </div>
              <div className="goal-progress-track">
                <i style={{ width: `${progress}%` }} />
              </div>
              <div className="goal-progress-caption">
                <span>{progress}% 完成</span>
                <span>
                  截止 {formatGoalDate(goal.deadline)} · 下次检查 {formatGoalDate(goal.nextCheckInAt)}
                </span>
              </div>
            </div>

            <div className="goal-detail-grid">
              <div className="goal-milestones">
                <span className="goal-section-label">里程碑</span>
                {goal.milestones.map((milestone) => (
                  <div className={`goal-milestone milestone-${milestone.status}`} key={milestone.id}>
                    <div>
                      <strong>{milestone.title}</strong>
                      <span className="goal-milestone-actions">
                        {milestone.dueAt && <small>{formatGoalDate(milestone.dueAt)}</small>}
                        {milestone.status !== 'completed' && (
                          <button onClick={() => onStartTask(goal, milestone)}>
                            <Play size={11} fill="currentColor" /> 开始任务
                          </button>
                        )}
                        <ActionMenu
                          className="goal-milestone-menu"
                          ariaLabel={`${milestone.title}操作`}
                          trigger={<MoreHorizontal size={15} />}
                          options={[
                            ...(milestone.status === 'completed'
                              ? []
                              : [{ value: 'complete' as const, label: '标记完成', icon: <Check size={13} /> }]),
                            { value: 'delete' as const, label: '删除', icon: <Trash2 size={13} />, danger: true }
                          ]}
                          onSelect={(action) => {
                            if (action === 'complete') {
                              void onCompleteMilestone(goal.id, milestone.id)
                              return
                            }
                            setMilestoneToDelete({ goalId: goal.id, milestoneId: milestone.id, title: milestone.title })
                          }}
                        />
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="goal-checkin-panel">
                <span className="goal-section-label">Agent Check-in</span>
                <p>{goal.agentSummary}</p>
                {goal.checkIns[0] && (
                  <span className="goal-checkin-meta">
                    {formatRelativeTime(goal.checkIns[0].createdAt)} · {goal.checkIns[0].evidenceRefs.length} 条证据
                  </span>
                )}
                <button
                  className="goal-check-button"
                  disabled={
                    checkingGoalId === goal.id ||
                    goal.status === 'planned' ||
                    goal.status === 'paused' ||
                    goal.status === 'completed'
                  }
                  onClick={() => void onCheck(goal.id)}
                >
                  {checkingGoalId === goal.id ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
                  {checkingGoalId === goal.id ? '正在检查…' : '检查进展'}
                </button>
              </div>
            </div>
          </div>
        )}
      </article>
    )
  }

  return (
    <>
      <section className="goals-view">
      <div className="goal-overview">
        <span>
          <strong>{goals.length}</strong> 个目标
        </span>
        <span>
          <strong>{activeCount}</strong> 个进行中
        </span>
        <span className={atRiskCount > 0 ? 'is-risk' : ''}>
          <strong>{atRiskCount}</strong> 个有风险
        </span>
        <span>
          <strong>{completedCount}</strong> 个已完成
        </span>
      </div>
      {orderedGoals.length > 0 ? (
        <div className="goal-list">{orderedGoals.map((goal) => renderGoal(goal))}</div>
      ) : (
        <div className="goals-empty-state is-compact">
          <span>
            <Target size={25} strokeWidth={1.6} />
          </span>
          <strong>还没有目标</strong>
          <p>在下方描述下一步想达成的结果，目标 Agent 会整理指标和里程碑。</p>
        </div>
      )}
      </section>
      {milestoneToDelete && (
        <ConfirmationDialog
          title="删除里程碑？"
          description={`“${milestoneToDelete.title}”将从目标中移除。`}
          confirmLabel="删除"
          destructive
          busy={deletingMilestone}
          onCancel={() => setMilestoneToDelete(null)}
          onConfirm={() => {
            setDeletingMilestone(true)
            void onDeleteMilestone(milestoneToDelete.goalId, milestoneToDelete.milestoneId)
              .then(() => setMilestoneToDelete(null))
              .finally(() => setDeletingMilestone(false))
          }}
        />
      )}
    </>
  )
}
