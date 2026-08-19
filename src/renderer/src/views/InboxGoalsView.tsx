import {
  ArchiveX,
  ArrowDown,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Copy,
  Clock3,
  Database,
  Folder,
  GitBranch,
  Headphones,
  Inbox,
  Lightbulb,
  LayoutGrid,
  LoaderCircle,
  Mic2,
  MoreHorizontal,
  PanelLeft,
  Pause,
  Pencil,
  Play,
  Plus,
  Plug,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Smartphone,
  Square,
  Target,
  Workflow,
  X,
  Trash2
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { QRCodeSVG } from 'qrcode.react'
import { ChatComposer } from '../components/ChatComposer'
import { ConfirmationDialog } from '../components/ConfirmationDialog'
import { AgentRunsView } from '../components/AgentRunsView'
import { ConversationMessageActions } from '../components/ConversationMessageActions'
import { isProjectImageIcon, ProjectIcon } from '../components/ProjectIcon'
import { ActionMenu, SelectMenu, SuggestionInput } from '../components/SelectMenu'
import { WorkspaceFilesView } from '../components/WorkspaceFilesView'
import { AutomationsView } from '../components/AutomationsView'
import { normalizeChatMarkdown } from '../markdown'
import { maxChatImages, prepareChatImages } from '../chat-attachments'
import { workAssistantRunIds } from '../work-assistant-links'
import { chatIsAtLatest } from '../chat-scroll'
import { microphoneAccessError } from '../voice-input'
import fuddyWordmark from '../assets/fuddy-wordmark.png'
import type {
  AgentPlanEntry,
  AgentRun,
  AgentProviderMode,
  AgentSessionUpdate,
  AgentEndpointSettings,
  AppBootstrap,
  AsrModelStatus,
  Capability,
  CodingAgentModelCatalog,
  CodingAgentProvider,
  CodingAgentSettings,
  ConnectorInstance,
  ConnectorKind,
  ConnectorRun,
  BriefingMessage,
  DecisionItem,
  DecisionKind,
  DecisionStatus,
  DecisionWaitingReason,
  GoalMilestone,
  GoalPriority,
  GoalStatus,
  MorningBriefing,
  Project,
  ProjectGoal,
  TtsEndpointSettings,
  TtsProviderMode,
  UpdateProjectInput,
  WorkAssistantImageAttachment,
  WorkAssistantActionProposal,
  WorkAssistantTaskContext,
  WorkAssistantTaskReference
} from '../../../shared/contracts'
import { normalizeWorkspaceRoots } from '../../../shared/project-workspaces'
import type { CompanionMacStatus, CompanionPairingSession } from '../../../shared/companion-sync'
import { defaultCompanionRelayUrl } from '../../../shared/companion-sync'
import { buildAgentModelLabels } from '../../../shared/model-display'
import { agentProviderDefinitions, codingAgentProviders } from '../../../shared/agent-providers'
import {
  codingAgentOptions,
  connectorStatusLabels,
  decisionWaitingReasonLabels,
  formatDecisionSource,
  formatExpiryLabel,
  formatRelativeTime,
  kindIcons,
  kindLabels,
  settingsNavigationItems,
  settingsSectionTitles,
  useAutoDismissMessage,
  type SettingsSection
} from './shared'

export function DecisionRow({
  item,
  project,
  onStatus,
  onHandle,
  handling
}: {
  item: DecisionItem
  project?: Project
  onStatus: (id: string, status: DecisionStatus) => Promise<void>
  onHandle: (item: DecisionItem) => Promise<void>
  handling: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const KindIcon = kindIcons[item.kind]

  if (item.status === 'resolved') {
    return (
      <article className="decision-completion-card">
        <div className="decision-completion-heading">
          <span className="decision-completion-icon">
            <CircleCheck size={18} />
          </span>
          <div>
            <span>已完成</span>
            <small>{item.resolvedAt ? `${formatRelativeTime(item.resolvedAt)}完成` : '已有可核验的完成证据'}</small>
          </div>
        </div>
        <div className="decision-completion-copy">
          <div className="decision-meta">
            {project && (
              <span className="project-name">
                <span className="project-dot" style={{ background: project.accent }} />
                {project.name}
              </span>
            )}
            {!project && <span className="project-name">全部项目</span>}
            <span>·</span>
            <span>{kindLabels[item.kind]}</span>
          </div>
          <strong>{item.title}</strong>
          <p>{item.resolutionSummary ?? '事项已经完成。'}</p>
          {item.evidenceRefs.length > 0 && (
            <div className="decision-completion-evidence" aria-label="完成证据">
              {item.evidenceRefs.map((evidence) => (
                <a key={`${evidence.label}:${evidence.uri}`} href={evidence.uri} target="_blank" rel="noreferrer">
                  <Check size={12} /> {evidence.label}
                </a>
              ))}
            </div>
          )}
        </div>
        <button className="icon-text-action decision-undo-action" onClick={() => void onStatus(item.id, 'in_progress')}>
          <RefreshCw size={14} />
          取消完成
        </button>
      </article>
    )
  }

  return (
    <article className={`decision-row ${expanded ? 'is-expanded' : ''}`}>
      <div className="decision-summary">
        <div className="decision-project-cell">
          <span className="project-dot" style={{ background: project?.accent ?? '#9a9a93' }} />
          <span>{project?.name ?? '全部项目'}</span>
        </div>
        <div>
          <span className={`decision-kind-pill kind-${item.kind}`}>
            <KindIcon size={12} strokeWidth={2} />
            {kindLabels[item.kind]}
          </span>
        </div>
        <button
          type="button"
          className="decision-title-button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <strong>{item.title}</strong>
          <span>
            {formatRelativeTime(item.lastSeenAt ?? item.createdAt)}
            {(item.occurrenceCount ?? 1) > 1 ? ` · 已更新 ${(item.occurrenceCount ?? 1) - 1} 次` : ''}
          </span>
        </button>
        <button
          type="button"
          className="decision-preview-button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <span>{item.status === 'waiting' && item.statusSummary ? item.statusSummary : item.summary}</span>
        </button>
        <div className="decision-row-actions">
          {(item.status === 'in_progress' || item.status === 'waiting') && (
            <span className={`decision-status-label ${item.status === 'waiting' ? 'is-waiting' : ''}`}>
              {item.status === 'waiting'
                ? item.waitingReason
                  ? decisionWaitingReasonLabels[item.waitingReason]
                  : '等待中'
                : '进行中'}
            </span>
          )}
          <button className="primary-action" disabled={handling} onClick={() => void onHandle(item)}>
            {handling ? <LoaderCircle size={13} className="spin" /> : <Workflow size={13} />}
            {handling
              ? '正在打开…'
              : item.status === 'in_progress' || item.status === 'waiting'
                ? '继续处理'
                : '去处理'}
          </button>
          {item.status !== 'ignored' && (
            <button className="decision-ignore-button" onClick={() => void onStatus(item.id, 'ignored')}>
              忽略
            </button>
          )}
          <button
            type="button"
            className="decision-expand-button"
            onClick={() => setExpanded((value) => !value)}
            aria-label={expanded ? `收起 ${item.title}` : `展开 ${item.title}`}
            aria-expanded={expanded}
          >
            {item.urgency === 'high' && item.status === 'inbox' && <span className="urgent-dot" />}
            <ChevronDown className="row-chevron" size={15} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="decision-detail">
          <div className="detail-section">
            <span className="detail-label">影响</span>
            <p>{item.impact}</p>
          </div>
          <div className="detail-section source-section">
            <span className="detail-label">来源</span>
            <p>{formatDecisionSource(item)}</p>
          </div>
          <div className="detail-section suggestion-section">
            <span className="detail-label">建议</span>
            <p>{item.suggestedActions[0] ?? '让 Agent 先分析问题并明确下一步'}</p>
          </div>
        </div>
      )}
    </article>
  )
}

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
