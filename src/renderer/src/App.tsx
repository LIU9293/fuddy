import {
  ArchiveX,
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
  LoaderCircle,
  MoreHorizontal,
  PanelLeft,
  Pause,
  Play,
  Plus,
  Plug,
  RefreshCw,
  Search,
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
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { QRCodeSVG } from 'qrcode.react'
import { ChatComposer } from './components/ChatComposer'
import { AgentRunsSidebar, AgentRunsView } from './components/AgentRunsView'
import { ConversationMessageActions } from './components/ConversationMessageActions'
import { ActionMenu, SelectMenu, SuggestionInput } from './components/SelectMenu'
import { WorkspaceFilesView } from './components/WorkspaceFilesView'
import { AutomationsView } from './components/AutomationsView'
import { normalizeChatMarkdown } from './markdown'
import { maxChatImages, prepareChatImages } from './chat-attachments'
import fuddyWordmark from './assets/fuddy-wordmark.png'
import type {
  AgentPlanEntry,
  AgentRun,
  AgentProviderMode,
  AgentSessionUpdate,
  AgentEndpointSettings,
  AppBootstrap,
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
} from '../../shared/contracts'
import { normalizeWorkspaceRoots } from '../../shared/project-workspaces'
import type { CompanionMacStatus, CompanionPairingSession } from '../../shared/companion-sync'
import { defaultCompanionRelayUrl } from '../../shared/companion-sync'

type Navigation = 'briefing' | 'inbox' | 'files' | 'runs' | 'automations' | 'settings'
type ProjectSection = 'inbox' | 'status' | 'goals' | 'settings'
type SidebarSelection = 'briefing' | 'inbox' | 'files' | 'runs' | 'automations' | 'all-projects' | `project:${string}`
type SettingsSection = 'general' | 'models' | 'voice' | 'connectors' | 'permissions'

const decisionWaitingReasonLabels: Record<DecisionWaitingReason, string> = {
  deployment: '等待部署',
  verification: '等待验证',
  external: '等待外部处理',
  measurement: '等待指标',
  user: '等待用户',
  scheduled: '等待复查'
}

const defaultSidebarWidth = 258
const minimumSidebarWidth = 220
const maximumSidebarWidth = 420
const sidebarWidthStorageKey = 'project-agent.sidebar-width'
const codingAgentOptions: Array<{ id: CodingAgentProvider; label: string }> = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'opencode', label: 'OpenCode' }
]

function clampSidebarWidth(value: number): number {
  return Math.round(Math.min(maximumSidebarWidth, Math.max(minimumSidebarWidth, value)))
}

function initialSidebarWidth(): number {
  const stored = Number.parseFloat(window.localStorage.getItem(sidebarWidthStorageKey) ?? '')
  return Number.isFinite(stored) ? clampSidebarWidth(stored) : defaultSidebarWidth
}

const settingsSectionMeta: Record<SettingsSection, { title: string; description: string }> = {
  general: { title: '通用', description: '查看工作助理、每日简报、项目和运行能力的全局状态。' },
  models: { title: '模型', description: '配置项目助理用于总结、分析和对话的模型 Provider。' },
  voice: { title: '语音与 TTS', description: '配置每日简报的云端语音模型、声音和表达风格。' },
  connectors: { title: '连接器', description: '管理项目数据源、巡检任务和 Connector 能力。' },
  permissions: { title: '权限与安全', description: '管理审批策略、危险操作门禁、凭证和审计规则。' }
}

const settingsNavigationItems = [
  { id: 'general', label: '通用', keywords: '工作助理 每日简报 项目 工作区 能力', icon: Settings2 },
  { id: 'models', label: '模型', keywords: 'Agent LLM Provider Backup', icon: Bot },
  { id: 'voice', label: '语音与 TTS', keywords: '声音 ElevenLabs OpenAI Backup', icon: Headphones },
  { id: 'permissions', label: '权限与安全', keywords: '审批 危险操作 凭证 审计', icon: ShieldCheck }
] satisfies Array<{ id: Exclude<SettingsSection, 'connectors'>; label: string; keywords: string; icon: typeof Settings2 }>

const kindLabels: Record<DecisionKind, string> = {
  risk: '风险',
  opportunity: '机会',
  decision: '待决策',
  result: '结果',
  info: '信息'
}

const kindIcons: Record<DecisionKind, typeof CircleAlert> = {
  risk: CircleAlert,
  opportunity: Lightbulb,
  decision: Sparkles,
  result: CircleCheck,
  info: Inbox
}

const connectorStatusLabels: Record<ConnectorInstance['status'], string> = {
  connected: '已连接',
  'needs-setup': '等待首次巡检',
  running: '巡检中',
  error: '需要处理',
  disabled: '已停用'
}

function formatRelativeTime(value: string): string {
  const diffMinutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000))
  if (diffMinutes < 1) return '刚刚'
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`
  const hours = Math.round(diffMinutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

function formatDecisionSource(item: DecisionItem): string {
  const explicitDate = [item.source, ...item.evidenceRefs.map((evidence) => evidence.label)]
    .join(' ')
    .match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  const date = explicitDate
    ? `${explicitDate[1]}年${Number(explicitDate[2])}月${Number(explicitDate[3])}日`
    : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
        .format(new Date(item.lastSeenAt ?? item.createdAt))
  const source = item.source.trim()

  if (/用户|手动/.test(source)) return `用户消息 · ${date}`
  if (/每日项目总结|每日巡检|巡检/.test(source)) return `${date}巡检`
  return source ? `${source} · ${date}` : date
}

function formatExpiryLabel(value: string): string {
  const diffMinutes = Math.ceil((new Date(value).getTime() - Date.now()) / 60_000)
  if (diffMinutes <= 0) return '二维码已经失效'
  if (diffMinutes < 60) return `二维码将在 ${diffMinutes} 分钟后失效`
  const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
  return `二维码将在 ${time} 失效`
}

function useAutoDismissMessage(
  message: string | null | undefined,
  onDismiss: () => void,
  delay = 5_000
): void {
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss

  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => onDismissRef.current(), delay)
    return () => window.clearTimeout(timer)
  }, [message, delay])
}

function DecisionRow({
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
          <span className="decision-completion-icon"><CircleCheck size={18} /></span>
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
      <button className="decision-summary" onClick={() => setExpanded((value) => !value)}>
        <span className={`kind-icon kind-${item.kind}`}>
          <KindIcon size={17} strokeWidth={1.9} />
        </span>
        <span className="decision-copy">
          <span className="decision-meta">
            {project && (
              <span className="project-name">
                <span className="project-dot" style={{ background: project.accent }} />
                {project.name}
              </span>
            )}
            {!project && <span className="project-name">全部项目</span>}
            <span>{kindLabels[item.kind]}</span>
            {item.status === 'in_progress' && <span className="decision-status-label">进行中</span>}
            {item.status === 'waiting' && (
              <span className="decision-status-label is-waiting">
                {item.waitingReason ? decisionWaitingReasonLabels[item.waitingReason] : '等待中'}
              </span>
            )}
            <span>·</span>
            <span>{formatRelativeTime(item.lastSeenAt ?? item.createdAt)}</span>
            {(item.occurrenceCount ?? 1) > 1 && (
              <>
                <span>·</span>
                <span>已更新 {(item.occurrenceCount ?? 1) - 1} 次</span>
              </>
            )}
          </span>
          <strong>{item.title}</strong>
          <span className="decision-preview">{item.summary}</span>
          {item.status === 'waiting' && item.statusSummary && (
            <span className="decision-preview decision-waiting-summary">{item.statusSummary}</span>
          )}
        </span>
        <span className="decision-trailing">
          {item.urgency === 'high' && item.status === 'inbox' && <span className="urgent-dot" />}
          <ChevronRight className="row-chevron" size={17} />
        </span>
      </button>

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
          <div className="decision-actions">
            <button className="primary-action" disabled={handling} onClick={() => void onHandle(item)}>
              {handling ? <LoaderCircle size={14} className="spin" /> : <Workflow size={14} />}
              {handling ? '正在打开…' : item.status === 'in_progress' || item.status === 'waiting' ? '继续处理' : '去处理'}
            </button>
            <button className="icon-text-action" onClick={() => void onStatus(item.id, 'ignored')}>
              <ArchiveX size={14} />
              忽略
            </button>
          </div>
        </div>
      )}
    </article>
  )
}

function EmptyState({ title, detail }: { title: string; detail: string }): React.JSX.Element {
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

function formatGoalDate(value: string | null): string {
  if (!value) return '未设置'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
  }).format(new Date(value))
}

function buildMilestoneDraftPrompt(project: Project, goal: ProjectGoal, milestone: GoalMilestone): string {
  return `请开始推进项目“${project.name}”的 Milestone“${milestone.title}”。

关联目标：${goal.title}
目标说明：${goal.description}

请先检查项目已配置的 Workspace Roots、README/AGENTS.md 和项目文件空间，确认已有证据、素材与产物，再给出并执行可以安全开始的第一步。代码、随产品发布的资源和仓库文档放在对应 Workspace；Marketing、运营、研究、报告和宣传素材等代码无关产物放在项目文件空间，并在回复中列出产物路径。不要因为开始执行就把 Milestone 标记为完成；涉及账号注册、登录、2FA、正式发布、付费或不可逆操作时先等待我确认。`
}

function GoalsView({
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
  const orderedGoals = [...goals].sort((left, right) => {
    const priorityRank: Record<GoalPriority, number> = { P0: 0, P1: 1, P2: 2 }
    return priorityRank[left.priority] - priorityRank[right.priority]
      || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  })
  const priorityOptions: Array<{ value: GoalPriority; label: string }> = [
    { value: 'P0', label: 'P0' },
    { value: 'P1', label: 'P1' },
    { value: 'P2', label: 'P2' }
  ]

  useEffect(() => {
    setExpandedGoalIds(new Set(
      goals.filter((goal) => goal.status === 'active' || goal.status === 'at-risk').map((goal) => goal.id)
    ))
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
            {!expanded && <small className="goal-collapsed-summary">{goal.metric.label} · {goal.milestones.length} 个里程碑 · {progress}%</small>}
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

        {expanded && <div className="goal-expanded-content">
          <div className="goal-progress-block">
            <div className="goal-progress-heading">
              <span>{goal.metric.label}</span>
              <strong>{current}{goal.metric.unit ? ` ${goal.metric.unit}` : ''} <i>/</i> {target}{goal.metric.unit ? ` ${goal.metric.unit}` : ''}</strong>
            </div>
            <div className="goal-progress-track"><i style={{ width: `${progress}%` }} /></div>
            <div className="goal-progress-caption">
              <span>{progress}% 完成</span>
              <span>截止 {formatGoalDate(goal.deadline)} · 下次检查 {formatGoalDate(goal.nextCheckInAt)}</span>
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
                          ...(milestone.status === 'completed' ? [] : [{ value: 'complete' as const, label: '标记完成', icon: <Check size={13} /> }]),
                          { value: 'delete' as const, label: '删除', icon: <Trash2 size={13} />, danger: true }
                        ]}
                        onSelect={(action) => {
                          if (action === 'complete') {
                            void onCompleteMilestone(goal.id, milestone.id)
                            return
                          }
                          if (window.confirm(`确定删除里程碑“${milestone.title}”吗？`)) {
                            void onDeleteMilestone(goal.id, milestone.id)
                          }
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
                disabled={checkingGoalId === goal.id || goal.status === 'planned' || goal.status === 'paused' || goal.status === 'completed'}
                onClick={() => void onCheck(goal.id)}
              >
                {checkingGoalId === goal.id ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
                {checkingGoalId === goal.id ? '正在检查…' : '检查进展'}
              </button>
            </div>
          </div>
        </div>}
      </article>
    )
  }

  return (
    <section className="goals-view">
      <div className="goal-overview">
        <span><strong>{goals.length}</strong> 个目标</span>
        <span><strong>{activeCount}</strong> 个进行中</span>
        <span className={atRiskCount > 0 ? 'is-risk' : ''}><strong>{atRiskCount}</strong> 个有风险</span>
        <span><strong>{completedCount}</strong> 个已完成</span>
      </div>
      {orderedGoals.length > 0 ? (
        <div className="goal-list">{orderedGoals.map((goal) => renderGoal(goal))}</div>
      ) : (
        <div className="goals-empty-state is-compact">
          <span><Target size={25} strokeWidth={1.6} /></span>
          <strong>还没有目标</strong>
          <p>在下方描述下一步想达成的结果，目标 Agent 会整理指标和里程碑。</p>
        </div>
      )}
    </section>
  )
}

function ProjectStatusView({
  project,
  onSaved,
  onNotice
}: {
  project: Project
  onSaved: () => Promise<void>
  onNotice: (message: string) => void
}): React.JSX.Element {
  const [mission, setMission] = useState(project.profile.mission)
  const [vision, setVision] = useState(project.profile.vision)
  const [currentStateSummary, setCurrentStateSummary] = useState(project.profile.currentState.summary)
  const [currentStateFacts, setCurrentStateFacts] = useState(project.profile.currentState.facts.join('\n'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useAutoDismissMessage(error, () => setError(null))

  useEffect(() => {
    setMission(project.profile.mission)
    setVision(project.profile.vision)
    setCurrentStateSummary(project.profile.currentState.summary)
    setCurrentStateFacts(project.profile.currentState.facts.join('\n'))
    setError(null)
  }, [project])

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      await window.projectAgent.updateProject({
        ...project,
        profile: {
          ...project.profile,
          mission: mission.trim(),
          vision: vision.trim(),
          currentState: {
            summary: currentStateSummary.trim(),
            facts: currentStateFacts.split('\n').map((item) => item.trim()).filter(Boolean),
            source: 'user',
            updatedAt: new Date().toISOString()
          }
        }
      })
      await onSaved()
      onNotice(`${project.name} 项目状态已保存。`)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '项目状态保存失败。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="project-status-page">
      <div className="project-status-section">
        <div className="project-status-heading">
          <strong>方向</strong>
          <p>使命说明现在为什么行动，愿景描述项目长期希望抵达的位置。</p>
        </div>
        <div className="project-status-fields">
          <label>
            <span>使命</span>
            <textarea rows={3} value={mission} onChange={(event) => setMission(event.target.value)} />
          </label>
          <label>
            <span>愿景</span>
            <textarea rows={3} value={vision} onChange={(event) => setVision(event.target.value)} />
          </label>
        </div>
      </div>

      <div className="project-status-section">
        <div className="project-status-heading">
          <strong>当前现状</strong>
          <p>这里保存已经确认的事实，是工作助理判断下一步和检查目标进展的基础。</p>
        </div>
        <div className="project-status-fields">
          <label>
            <span>现状总结</span>
            <textarea rows={4} value={currentStateSummary} onChange={(event) => setCurrentStateSummary(event.target.value)} />
          </label>
          <label>
            <span>已确认事实（每行一项）</span>
            <textarea rows={6} value={currentStateFacts} onChange={(event) => setCurrentStateFacts(event.target.value)} />
          </label>
        </div>
      </div>

      {error && <p className="project-settings-error">{error}</p>}
      <div className="project-settings-actions">
        <button
          className="provider-save-button"
          onClick={() => void save()}
          disabled={saving || !mission.trim() || !vision.trim() || !currentStateSummary.trim()}
        >
          {saving ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}
          保存项目状态
        </button>
      </div>
    </section>
  )
}

function ProjectSettingsView({
  project,
  onSaved,
  onNotice
}: {
  project: Project
  onSaved: () => Promise<void>
  onNotice: (message: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<UpdateProjectInput>(structuredClone(project))
  const [listFields, setListFields] = useState({
    surfaces: project.profile.surfaces.join('\n'),
    focusAreas: project.profile.focusAreas.join('\n'),
    dataSources: project.profile.dataSources.join('\n'),
    nextMoves: project.profile.nextMoves.join('\n')
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useAutoDismissMessage(error, () => setError(null))

  useEffect(() => {
    setDraft(structuredClone(project))
    setListFields({
      surfaces: project.profile.surfaces.join('\n'),
      focusAreas: project.profile.focusAreas.join('\n'),
      dataSources: project.profile.dataSources.join('\n'),
      nextMoves: project.profile.nextMoves.join('\n')
    })
    setError(null)
  }, [project])

  function updateProfile(patch: Partial<Project['profile']>): void {
    setDraft((current) => ({
      ...current,
      profile: { ...current.profile, ...patch }
    }))
  }

  function lines(value: string): string[] {
    return value.split('\n').map((item) => item.trim()).filter(Boolean)
  }

  function updateWorkspaceRoot(id: string, patch: { label?: string; path?: string }): void {
    updateProfile({
      workspaceRoots: draft.profile.workspaceRoots.map((root) => root.id === id ? { ...root, ...patch } : root)
    })
  }

  function addWorkspaceRoot(): void {
    const id = `workspace-${Date.now()}`
    updateProfile({
      workspaceRoots: [...draft.profile.workspaceRoots, { id, label: 'New workspace', path: '' }],
      primaryWorkspaceRootId: draft.profile.primaryWorkspaceRootId ?? id
    })
  }

  function removeWorkspaceRoot(id: string): void {
    const workspaceRoots = draft.profile.workspaceRoots.filter((root) => root.id !== id)
    updateProfile({
      workspaceRoots,
      primaryWorkspaceRootId: draft.profile.primaryWorkspaceRootId === id
        ? workspaceRoots[0]?.id ?? null
        : draft.profile.primaryWorkspaceRootId
    })
  }

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const workspaces = normalizeWorkspaceRoots(draft.profile)
      await window.projectAgent.updateProject({
        ...draft,
        name: draft.name.trim(),
        summary: draft.summary.trim(),
        focus: draft.focus.trim(),
        profile: {
          ...draft.profile,
          productType: draft.profile.productType.trim(),
          stage: draft.profile.stage.trim(),
          ...workspaces,
          websiteUrl: draft.profile.websiteUrl?.trim() || null,
          surfaces: lines(listFields.surfaces),
          focusAreas: lines(listFields.focusAreas),
          dataSources: lines(listFields.dataSources),
          nextMoves: lines(listFields.nextMoves)
        }
      })
      await onSaved()
      onNotice(`${draft.name.trim()} 项目设置已保存。`)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '项目设置保存失败。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="project-settings-page">
      <div className="project-setting-section">
        <div className="project-setting-heading">
          <h2>基本信息</h2>
          <p>项目在侧边栏、简报和 Agent 上下文中的身份。</p>
        </div>
        <div className="project-setting-fields">
          <label>
            <span>项目名称</span>
            <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
          </label>
          <div className="project-setting-field">
            <span>状态</span>
            <SelectMenu
              value={draft.status}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'watching', label: 'Watching' },
                { value: 'paused', label: 'Paused' }
              ]}
              onChange={(status) => setDraft((current) => ({ ...current, status }))}
              ariaLabel="项目状态"
            />
          </div>
          <label>
            <span>一句话介绍</span>
            <textarea rows={2} value={draft.summary} onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))} />
          </label>
          <label>
            <span>Agent 分析视角</span>
            <input value={draft.focus} onChange={(event) => setDraft((current) => ({ ...current, focus: event.target.value }))} placeholder="Growth / Data / Operations" />
          </label>
        </div>
      </div>

      <div className="project-setting-section">
        <div className="project-setting-heading">
          <h2>产品上下文</h2>
          <p>帮助 Agent 理解项目形态、阶段和当前工作范围。</p>
        </div>
        <div className="project-setting-fields">
          <label>
            <span>产品类型</span>
            <input value={draft.profile.productType} onChange={(event) => updateProfile({ productType: event.target.value })} />
          </label>
          <label>
            <span>当前阶段</span>
            <input value={draft.profile.stage} onChange={(event) => updateProfile({ stage: event.target.value })} />
          </label>
          <label>
            <span>产品形态（每行一项）</span>
            <textarea rows={3} value={listFields.surfaces} onChange={(event) => setListFields((current) => ({ ...current, surfaces: event.target.value }))} />
          </label>
          <label>
            <span>重点领域（每行一项）</span>
            <textarea rows={4} value={listFields.focusAreas} onChange={(event) => setListFields((current) => ({ ...current, focusAreas: event.target.value }))} />
          </label>
        </div>
      </div>

      <div className="project-setting-section">
        <div className="project-setting-heading">
          <h2>代码与入口</h2>
          <p>普通 Run 和 Coding Run 都从主 Workspace 启动，并可访问此处列出的项目目录。</p>
        </div>
        <div className="project-setting-fields">
          <div className="project-setting-field workspace-roots-field">
            <span>Workspace Roots</span>
            <div className="workspace-root-editor">
              {draft.profile.workspaceRoots.map((root) => (
                <div className="workspace-root-row" key={root.id}>
                  <input
                    aria-label="Workspace 名称"
                    value={root.label}
                    onChange={(event) => updateWorkspaceRoot(root.id, { label: event.target.value })}
                    placeholder="名称"
                  />
                  <input
                    aria-label="Workspace 路径"
                    value={root.path}
                    onChange={(event) => updateWorkspaceRoot(root.id, { path: event.target.value })}
                    placeholder="/Users/name/Code/project"
                  />
                  <button type="button" onClick={() => removeWorkspaceRoot(root.id)} aria-label={`移除 ${root.label}`}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              <button type="button" className="workspace-root-add" onClick={addWorkspaceRoot}>
                <Plus size={13} /> 添加 Workspace
              </button>
            </div>
          </div>
          <div className="project-setting-field">
            <span>主 Workspace</span>
            <SelectMenu
              value={draft.profile.primaryWorkspaceRootId ?? ''}
              options={draft.profile.workspaceRoots.map((root) => ({ value: root.id, label: root.label || root.path || root.id }))}
              onChange={(primaryWorkspaceRootId) => updateProfile({ primaryWorkspaceRootId })}
              ariaLabel="主 Workspace"
            />
          </div>
          <div className="project-setting-field">
            <span>默认 Agent</span>
            <SelectMenu
              value={draft.profile.defaultAgent}
              options={[
                { value: 'pi', label: 'Pi Agent' },
                { value: 'codex', label: 'Codex' },
                { value: 'claude', label: 'Claude Code' },
                { value: 'opencode', label: 'OpenCode' }
              ]}
              onChange={(defaultAgent) => updateProfile({ defaultAgent: defaultAgent as Project['profile']['defaultAgent'] })}
              ariaLabel="默认 Agent"
            />
          </div>
          <label>
            <span>官网</span>
            <input type="url" value={draft.profile.websiteUrl ?? ''} onChange={(event) => updateProfile({ websiteUrl: event.target.value || null })} placeholder="https://example.com" />
          </label>
        </div>
      </div>

      <div className="project-setting-section">
        <div className="project-setting-heading">
          <h2>数据与下一步</h2>
          <p>定义项目自己的证据来源和当前优先事项。</p>
        </div>
        <div className="project-setting-fields">
          <label>
            <span>数据源（每行一项）</span>
            <textarea rows={5} value={listFields.dataSources} onChange={(event) => setListFields((current) => ({ ...current, dataSources: event.target.value }))} />
          </label>
          <label>
            <span>建议下一步（每行一项）</span>
            <textarea rows={5} value={listFields.nextMoves} onChange={(event) => setListFields((current) => ({ ...current, nextMoves: event.target.value }))} />
          </label>
        </div>
      </div>

      {error && <p className="project-settings-error">{error}</p>}
      <div className="project-settings-actions">
        <button
          className="provider-save-button"
          onClick={() => void save()}
          disabled={saving || !draft.name.trim() || !draft.summary.trim()}
        >
          {saving ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}
          保存项目设置
        </button>
      </div>
    </section>
  )
}

function MarkdownMessage({ content, streaming = false }: { content: string; streaming?: boolean }): React.JSX.Element {
  return (
    <div className={`chat-markdown ${streaming ? 'is-streaming' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>
        }}
      >
        {normalizeChatMarkdown(content)}
      </ReactMarkdown>
      {streaming && <span className="streaming-caret" aria-hidden="true" />}
    </div>
  )
}

function TaskContextBadge({ context }: { context: WorkAssistantTaskContext }): React.JSX.Element {
  return (
    <div className="work-task-context">
      <Play size={11} fill="currentColor" />
      <span>{context.projectName}</span>
      <i>·</i>
      <strong>{context.milestoneTitle}</strong>
    </div>
  )
}

function BriefingTranscript({ body }: { body: string }): React.JSX.Element {
  return (
    <div className="briefing-card-transcript">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>
        }}
      >
        {normalizeChatMarkdown(body)}
      </ReactMarkdown>
    </div>
  )
}

function AudioBriefingCard({
  briefing,
  ttsMode,
  generating,
  canRegenerate,
  onGenerate
}: {
  briefing: MorningBriefing
  ttsMode: TtsProviderMode
  generating: boolean
  canRegenerate: boolean
  onGenerate: () => Promise<void>
}): React.JSX.Element {
  const [speaking, setSpeaking] = useState(false)
  const [paused, setPaused] = useState(false)
  const [loadingAudio, setLoadingAudio] = useState(false)
  const [audioError, setAudioError] = useState('')
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window
  useAutoDismissMessage(audioError, () => setAudioError(''))

  useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel()
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [briefing?.id])

  function startSystemSpeech(): void {
    if (!briefing || !speechSupported) return
    if (speaking && paused) {
      window.speechSynthesis.resume()
      setPaused(false)
      return
    }
    if (speaking) {
      window.speechSynthesis.pause()
      setPaused(true)
      return
    }
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(briefing.narration)
    utterance.lang = 'zh-CN'
    utterance.rate = 1.02
    utterance.pitch = 0.98
    const voices = window.speechSynthesis.getVoices()
    utterance.voice = voices.find((voice) =>
      voice.lang.toLowerCase().startsWith('zh') && /tingting|meijia|sin-ji|普通话/i.test(voice.name)
    ) ?? voices.find((voice) => voice.lang.toLowerCase().startsWith('zh')) ?? null
    utterance.onend = () => {
      setSpeaking(false)
      setPaused(false)
    }
    utterance.onerror = () => {
      setSpeaking(false)
      setPaused(false)
    }
    setSpeaking(true)
    setPaused(false)
    window.speechSynthesis.speak(utterance)
  }

  async function toggleAudio(): Promise<void> {
    if (!briefing) return
    setAudioError('')
    if (ttsMode === 'system') {
      startSystemSpeech()
      return
    }
    const current = audioRef.current
    if (current && speaking) {
      if (paused) {
        await current.play()
        setPaused(false)
      } else {
        current.pause()
        setPaused(true)
      }
      return
    }
    setLoadingAudio(true)
    try {
      const result = await window.projectAgent.getMorningBriefingAudio(briefing.id)
      if (result.mode === 'system' || !result.audioDataUrl) {
        startSystemSpeech()
        return
      }
      const audio = new Audio(result.audioDataUrl)
      audioRef.current = audio
      audio.onended = () => {
        setSpeaking(false)
        setPaused(false)
        audioRef.current = null
      }
      audio.onerror = () => {
        setSpeaking(false)
        setPaused(false)
        audioRef.current = null
      }
      setSpeaking(true)
      setPaused(false)
      await audio.play()
    } catch (error) {
      setSpeaking(false)
      setPaused(false)
      audioRef.current = null
      setAudioError(error instanceof Error ? error.message : '云端语音生成失败，请检查 TTS 配置。')
    } finally {
      setLoadingAudio(false)
    }
  }

  function stopSpeech(): void {
    window.speechSynthesis?.cancel()
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      audioRef.current = null
    }
    setSpeaking(false)
    setPaused(false)
  }

  const minutes = Math.max(1, Math.ceil(briefing.estimatedDurationSeconds / 60))
  return (
    <div className={`audio-briefing-card ${transcriptOpen ? 'is-expanded' : ''}`}>
      <div className="audio-briefing-topline">
        <span>{briefing.reportDate} · 全部项目</span>
        <span className="audio-briefing-actions">
          <span>约 {minutes} 分钟 · 中文</span>
          {canRegenerate && (
              <button onClick={() => void onGenerate()} disabled={generating} aria-label="重新生成今日简报">
                {generating ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
              </button>
          )}
        </span>
      </div>
      <h2>{briefing.headline}</h2>
      <div className={`audio-wave ${speaking && !paused ? 'is-playing' : ''}`} aria-hidden="true">
        {Array.from({ length: 34 }).map((_, index) => <i key={index} style={{ height: `${8 + ((index * 13) % 25)}px` }} />)}
      </div>
      <div className="audio-controls">
        <button
          className="audio-play-button"
          onClick={() => void toggleAudio()}
          disabled={loadingAudio || (ttsMode === 'system' && !speechSupported)}
        >
          {loadingAudio
            ? <LoaderCircle className="spin" size={16} />
            : speaking && !paused
              ? <Pause size={16} fill="currentColor" />
              : <Play size={16} fill="currentColor" />}
          {loadingAudio ? '正在生成' : speaking && !paused ? '暂停' : paused ? '继续播放' : '播放简报'}
        </button>
        {speaking && (
          <button className="audio-stop-button" onClick={stopSpeech} aria-label="停止播放">
            <Square size={11} fill="currentColor" />
          </button>
        )}
        <button className="briefing-read-button" onClick={() => setTranscriptOpen((value) => !value)}>
          {transcriptOpen ? '收起全文' : '阅读全文'}
          <ChevronDown className={transcriptOpen ? 'is-expanded' : ''} size={14} />
        </button>
      </div>
      {audioError && <p className="audio-error">{audioError}</p>}
      {transcriptOpen && <BriefingTranscript body={briefing.body} />}
    </div>
  )
}

function MessageImageAttachments({
  attachments
}: {
  attachments: readonly WorkAssistantImageAttachment[]
}): React.JSX.Element | null {
  if (attachments.length === 0) return null
  return (
    <div className="chat-image-attachments">
      {attachments.map((attachment) => (
        <img
          key={attachment.id}
          src={attachment.dataUrl}
          alt={attachment.name}
          title={attachment.name}
          loading="lazy"
        />
      ))}
    </div>
  )
}

function WorkAssistantActionCard({
  messageId,
  proposal,
  busy,
  onExecute
}: {
  messageId: string
  proposal: WorkAssistantActionProposal
  busy: boolean
  onExecute: (messageId: string, proposalId: string, optionId: string) => Promise<void>
}): React.JSX.Element | null {
  const acceptedOption = proposal.options.find((option) => option.id === proposal.acceptedOptionId)
  const options = proposal.options.filter((option) => option.capability !== 'agent-run.open')
  if (options.length === 0 || acceptedOption?.capability === 'agent-run.open') return null
  const accepted = proposal.status === 'accepted'
  const includesLegacyRunLink = options.length !== proposal.options.length
  return (
    <section className={`work-assistant-action-card is-${proposal.status}`} aria-label={includesLegacyRunLink ? '创建新的 Agent Run' : proposal.title}>
      <div className="work-assistant-action-heading">
        <span>{accepted ? <CircleCheck size={17} /> : <Bot size={17} />}</span>
        <div>
          <strong>{includesLegacyRunLink ? '创建新的 Agent Run' : proposal.title}</strong>
          {proposal.context && <small>{proposal.context}</small>}
        </div>
      </div>
      <p>{includesLegacyRunLink ? '如果不继续已有 Run，也可以确认后创建一个新的 Draft Run。' : proposal.description}</p>
      {proposal.status === 'pending' ? (
        <div className="work-assistant-action-options">
          {options.map((option) => (
            <button
              type="button"
              key={option.id}
              className={`is-${option.style}`}
              disabled={busy}
              onClick={() => void onExecute(messageId, proposal.id, option.id)}
            >
              {busy ? <LoaderCircle className="spin" size={14} /> : option.capability === 'agent-run.create' ? <Plus size={14} /> : <ChevronRight size={14} />}
              {option.label}
            </button>
          ))}
        </div>
      ) : (
        <small className="work-assistant-action-result">
          <Check size={13} /> 已确认：{acceptedOption?.label ?? '已处理'}
        </small>
      )}
    </section>
  )
}

function workAssistantRunIds(message: BriefingMessage): string[] {
  const runIds = new Set<string>()
  if (message.linkedRunId) runIds.add(message.linkedRunId)
  for (const proposal of message.actions ?? []) {
    for (const option of proposal.options) {
      if (option.capability === 'agent-run.open') runIds.add(option.payload.runId)
    }
  }
  return [...runIds]
}

function workAssistantMessageContent(message: BriefingMessage): string {
  if (!message.actions?.some((proposal) => proposal.options.some((option) => option.capability === 'agent-run.open'))) {
    return message.content
  }
  return message.content
    .replace('确认后会打开它并预填建议消息，不会自动发送。', '可以通过下方链接直接回到这个 Run。')
    .replace('确认后会打开这个 Run 并预填建议消息，不会自动发送。', '可以通过下方链接直接打开这个 Run。')
    .replace('确认后会打开这个 Run，不会追加或发送消息。', '可以通过下方链接直接打开这个 Run。')
    .replace('请确认后打开。', '可以通过下方链接直接打开。')
}

function WorkAssistantRunLink({ run, onOpen }: { run: AgentRun; onOpen: () => void }): React.JSX.Element {
  return (
    <button className="work-assistant-run-card" type="button" onClick={onOpen}>
      <Bot size={17} />
      <span><strong>{run.title}</strong><small>{run.status === 'draft' ? '草稿 · 首条消息尚未发送' : `${run.provider} · ${run.status}`}</small></span>
      <ChevronRight size={16} />
    </button>
  )
}

function WorkAssistantView({
  briefings,
  messages,
  ttsMode,
  generating,
  runs,
  onOpenRun,
  onExecuteAction,
  onGenerate,
  onAsk
}: {
  briefings: MorningBriefing[]
  messages: BriefingMessage[]
  ttsMode: TtsProviderMode
  generating: boolean
  runs: AgentRun[]
  onOpenRun: (runId: string) => void
  onExecuteAction: (messageId: string, proposalId: string, optionId: string) => Promise<void>
  onGenerate: () => Promise<void>
  onAsk: (
    briefingId: string | null,
    question: string,
    taskContext: WorkAssistantTaskReference | null,
    attachments: WorkAssistantImageAttachment[],
    onUpdate: (update: AgentSessionUpdate) => void
  ) => Promise<void>
}): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const [imageAttachments, setImageAttachments] = useState<WorkAssistantImageAttachment[]>([])
  const [imageError, setImageError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [executingActionId, setExecutingActionId] = useState<string | null>(null)
  const [pendingTurn, setPendingTurn] = useState<{
    userMessage: BriefingMessage
    assistantContent: string
    assistantMessageId: string | null
    plan: AgentPlanEntry[]
  } | null>(null)
  const threadEndRef = useRef<HTMLDivElement | null>(null)
  useAutoDismissMessage(imageError, () => setImageError(null))
  const completedBriefings = briefings.filter((briefing) => briefing.status === 'completed')
  const latestBriefing = completedBriefings[0]
  const timeline = [
    ...completedBriefings.map((briefing) => ({
      id: briefing.id,
      type: 'briefing' as const,
      createdAt: briefing.generatedAt,
      briefing
    })),
    ...messages.map((message) => ({
      id: message.id,
      type: 'message' as const,
      createdAt: message.createdAt,
      message
    }))
  ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'end' })
  }, [timeline.length, asking, pendingTurn?.assistantContent])

  async function submitQuestion(
    value = question,
    taskContext: WorkAssistantTaskContext | null = null,
    attachments = imageAttachments
  ): Promise<void> {
    const prompt = value.trim() || (attachments.length > 0
      ? '请分析这些图片，告诉我关键结论、需要注意的问题和建议的下一步。'
      : '')
    if (!prompt || asking) return
    setAsking(true)
    setQuestion('')
    setImageAttachments([])
    setImageError(null)
    setPendingTurn({
      userMessage: {
        id: `pending-user-${crypto.randomUUID()}`,
        briefingId: latestBriefing?.id ?? null,
        role: 'user',
        content: prompt,
        attachments,
        taskContext,
        createdAt: new Date().toISOString()
      },
      assistantContent: '',
      assistantMessageId: null,
      plan: []
    })
    try {
      await onAsk(
        latestBriefing?.id ?? null,
        prompt,
        taskContext ? {
          projectId: taskContext.projectId,
          goalId: taskContext.goalId,
          milestoneId: taskContext.milestoneId
        } : null,
        attachments,
        (update) => {
        setPendingTurn((current) => {
          if (!current) return current
          if (update.sessionUpdate === 'plan') return { ...current, plan: update.entries }
          const sameMessage = current.assistantMessageId === update.messageId
          return {
            ...current,
            assistantMessageId: update.messageId,
            assistantContent: sameMessage
              ? `${current.assistantContent}${update.content.text}`
              : update.content.text
          }
        })
      })
      setPendingTurn(null)
    } catch (error) {
      setPendingTurn((current) => current ? {
        ...current,
        assistantContent: `**请求失败**\n\n${error instanceof Error ? error.message : 'Agent 暂时不可用。'}`
      } : current)
    } finally {
      setAsking(false)
    }
  }

  async function addImages(files: File[]): Promise<void> {
    const result = await prepareChatImages(files, imageAttachments.length)
    setImageAttachments((current) => [...current, ...result.attachments].slice(0, maxChatImages))
    setImageError(result.error)
  }

  async function executeAction(messageId: string, proposalId: string, optionId: string): Promise<void> {
    if (executingActionId) return
    setExecutingActionId(proposalId)
    try {
      await onExecuteAction(messageId, proposalId, optionId)
    } finally {
      setExecutingActionId(null)
    }
  }

  return (
    <div className="briefing-conversation">
      <section className="briefing-thread" aria-label="与工作助理的对话">
        <div className="briefing-thread-inner">
          {timeline.length === 0 ? (
            <div className="morning-empty">
              <span className="morning-empty-icon"><Headphones size={28} /></span>
              <strong>工作助理已经准备好</strong>
              <p>你可以直接开始项目任务；每天上午 09:00 的三分钟简报也会发送到这里。</p>
              <button className="briefing-button" onClick={() => void onGenerate()} disabled={generating}>
                {generating ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}
                现在生成
              </button>
            </div>
          ) : timeline.map((item) => item.type === 'briefing' ? (
            <article className="chat-turn is-assistant is-briefing" key={item.id}>
              <div className="chat-turn-content">
                <ConversationMessageActions
                  content={`${item.briefing.headline}\n\n${item.briefing.body}`}
                  createdAt={item.createdAt}
                />
                <p className="briefing-delivery-copy">早上好，这是今天值得关注的项目变化。</p>
                <AudioBriefingCard
                  briefing={item.briefing}
                  ttsMode={ttsMode}
                  generating={generating}
                  canRegenerate={item.briefing.id === latestBriefing?.id}
                  onGenerate={onGenerate}
                />
              </div>
            </article>
          ) : (
            <article className={`chat-turn is-${item.message.role}`} key={item.id}>
              <div className="chat-turn-content">
                <ConversationMessageActions content={workAssistantMessageContent(item.message)} createdAt={item.createdAt} />
                {item.message.role === 'user' && item.message.taskContext && <TaskContextBadge context={item.message.taskContext} />}
                {item.message.role === 'user' && <MessageImageAttachments attachments={item.message.attachments} />}
                {item.message.role === 'assistant'
                  ? <MarkdownMessage content={workAssistantMessageContent(item.message)} />
                  : <p className="chat-bubble">{workAssistantMessageContent(item.message)}</p>}
                {item.message.actions?.map((proposal) => (
                  <WorkAssistantActionCard
                    key={proposal.id}
                    messageId={item.message.id}
                    proposal={proposal}
                    busy={executingActionId === proposal.id}
                    onExecute={executeAction}
                  />
                ))}
                {workAssistantRunIds(item.message).map((runId) => {
                  const run = runs.find((candidate) => candidate.id === runId)
                  return run ? <WorkAssistantRunLink key={run.id} run={run} onOpen={() => onOpenRun(run.id)} /> : null
                })}
              </div>
            </article>
          ))}
          {pendingTurn && (
            <>
              <article className="chat-turn is-user is-pending">
                <div className="chat-turn-content">
                  <ConversationMessageActions
                    content={pendingTurn.userMessage.content}
                    createdAt={pendingTurn.userMessage.createdAt}
                  />
                  {pendingTurn.userMessage.taskContext && <TaskContextBadge context={pendingTurn.userMessage.taskContext} />}
                  <MessageImageAttachments attachments={pendingTurn.userMessage.attachments} />
                  <p className="chat-bubble">{pendingTurn.userMessage.content}</p>
                </div>
              </article>
              <article className="chat-turn is-assistant is-pending">
                <div className="chat-turn-content">
                  {pendingTurn.plan.length > 0 && (
                    <div className="agent-plan" aria-label="Agent 计划">
                      {pendingTurn.plan.map((entry, index) => (
                        <span className={`is-${entry.status}`} key={`${entry.content}-${index}`}>
                          <i />{entry.content}
                        </span>
                      ))}
                    </div>
                  )}
                  {pendingTurn.assistantContent
                    ? <MarkdownMessage content={pendingTurn.assistantContent} streaming={asking} />
                    : <div className="briefing-thinking"><LoaderCircle className="spin" size={14} /> 正在处理你的请求…</div>}
                </div>
              </article>
            </>
          )}
          <div ref={threadEndRef} />
        </div>
      </section>

      <footer className="briefing-composer-dock">
        <ChatComposer
          value={question}
          onChange={setQuestion}
          onSubmit={submitQuestion}
          placeholder="和工作助理讨论任务、目标或项目问题…"
          busy={asking}
          attachments={imageAttachments}
          attachmentError={imageError}
          onAttachmentsSelected={addImages}
          onRemoveAttachment={(id) => {
            setImageAttachments((current) => current.filter((attachment) => attachment.id !== id))
            setImageError(null)
          }}
          submitAriaLabel="发送问题"
        />
      </footer>
    </div>
  )
}

function SettingsView({
  bootstrap,
  section,
  projectId,
  projectLocked = false,
  onProjectChange,
  onRefresh,
  onNotice
}: {
  bootstrap: AppBootstrap
  section: SettingsSection
  projectId: string | null
  projectLocked?: boolean
  onProjectChange: (projectId: string | null) => void
  onRefresh: () => Promise<void>
  onNotice: (message: string) => void
}): React.JSX.Element {
  const [busyConnectors, setBusyConnectors] = useState<Set<string>>(new Set())
  const [runningAll, setRunningAll] = useState(false)
  const [postgresFormOpen, setPostgresFormOpen] = useState(false)
  const [postgresConnection, setPostgresConnection] = useState('')
  const [postgresMetricView, setPostgresMetricView] = useState('')
  const [postgresAnalyticsProfile, setPostgresAnalyticsProfile] = useState('')
  const [postgresError, setPostgresError] = useState<string | null>(null)
  const [savingPostgres, setSavingPostgres] = useState(false)
  const [connectorFormKind, setConnectorFormKind] = useState<Exclude<ConnectorKind, 'repo' | 'postgres'> | null>(null)
  const [connectorFields, setConnectorFields] = useState<Record<string, string>>({})
  const [connectorSetupError, setConnectorSetupError] = useState<string | null>(null)
  const [savingConnector, setSavingConnector] = useState(false)
  const [agentPrimary, setAgentPrimary] = useState(bootstrap.providerSettings.agent.primary)
  const [agentBackup, setAgentBackup] = useState(bootstrap.providerSettings.agent.backup)
  const [agentBackupEnabled, setAgentBackupEnabled] = useState(bootstrap.providerSettings.agent.backupEnabled)
  const [agentApiKeys, setAgentApiKeys] = useState({ primary: '', backup: '' })
  const [codingAgents, setCodingAgents] = useState<CodingAgentSettings>(bootstrap.providerSettings.codingAgents)
  const [codingAgentModels, setCodingAgentModels] = useState<CodingAgentModelCatalog | null>(null)
  const [codingModelsLoading, setCodingModelsLoading] = useState(false)
  const [ttsPrimary, setTtsPrimary] = useState(bootstrap.providerSettings.tts.primary)
  const [ttsBackup, setTtsBackup] = useState(bootstrap.providerSettings.tts.backup)
  const [ttsBackupEnabled, setTtsBackupEnabled] = useState(bootstrap.providerSettings.tts.backupEnabled)
  const [ttsApiKeys, setTtsApiKeys] = useState({ primary: '', backup: '' })
  const [providerBusy, setProviderBusy] = useState<'agent' | 'coding-agents' | 'coding-detect' | 'tts' | 'tts-test' | 'tts-voice-design' | null>(null)
  const [providerError, setProviderError] = useState<string | null>(null)
  const [requestingComputerPermissions, setRequestingComputerPermissions] = useState(false)
  const [projectAgentBusy, setProjectAgentBusy] = useState<string | null>(null)
  const [companionStatus, setCompanionStatus] = useState<CompanionMacStatus | null>(null)
  const [companionRelayUrl, setCompanionRelayUrl] = useState(defaultCompanionRelayUrl)
  const [companionPairing, setCompanionPairing] = useState<CompanionPairingSession | null>(null)
  const [companionBusy, setCompanionBusy] = useState<'pair' | 'sync' | 'disconnect' | null>(null)
  const [companionError, setCompanionError] = useState<string | null>(null)
  useAutoDismissMessage(postgresError, () => setPostgresError(null))
  useAutoDismissMessage(connectorSetupError, () => setConnectorSetupError(null))
  useAutoDismissMessage(providerError, () => setProviderError(null))
  useAutoDismissMessage(companionError, () => setCompanionError(null))
  const visibleConnectors = bootstrap.connectors.filter(
    (connector) => !projectId || connector.projectId === projectId
  )
  const catalogConnectors = bootstrap.connectorCatalog.filter((item) => item.kind !== 'repo')
  const selectedProject = bootstrap.projects.find((project) => project.id === projectId)
  const selectedPostgres = bootstrap.connectors.find(
    (connector) => connector.projectId === projectId && connector.kind === 'postgres'
  )

  useEffect(() => {
    setAgentPrimary(bootstrap.providerSettings.agent.primary)
    setAgentBackup(bootstrap.providerSettings.agent.backup)
    setAgentBackupEnabled(bootstrap.providerSettings.agent.backupEnabled)
    setCodingAgents(bootstrap.providerSettings.codingAgents)
    setTtsPrimary(bootstrap.providerSettings.tts.primary)
    setTtsBackup(bootstrap.providerSettings.tts.backup)
    setTtsBackupEnabled(bootstrap.providerSettings.tts.backupEnabled)
  }, [bootstrap.providerSettings])

  useEffect(() => {
    let active = true
    void window.projectAgent.getCompanionStatus().then((status) => {
      if (!active) return
      setCompanionStatus(status)
      if (status.configuration) setCompanionRelayUrl(status.configuration.relayUrl)
    }).catch((error: unknown) => {
      if (active) setCompanionError(error instanceof Error ? error.message : '无法读取 iPhone Companion 状态。')
    })
    const unsubscribe = window.projectAgent.onCompanionStatusChanged((status) => {
      if (active) setCompanionStatus(status)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (section !== 'models') return
    let active = true
    setCodingModelsLoading(true)
    void window.projectAgent.listCodingAgentModels()
      .then((catalog) => {
        if (active) setCodingAgentModels(catalog)
      })
      .catch((error: unknown) => {
        if (active) setProviderError(error instanceof Error ? error.message : 'Coding Agent 模型读取失败。')
      })
      .finally(() => {
        if (active) setCodingModelsLoading(false)
      })
    return () => { active = false }
  }, [section])

  function updateAgentEndpoint(slot: 'primary' | 'backup', patch: Partial<AgentEndpointSettings>): void {
    const setter = slot === 'primary' ? setAgentPrimary : setAgentBackup
    setter((current) => ({ ...current, ...patch }))
  }

  function changeAgentMode(slot: 'primary' | 'backup', mode: AgentProviderMode): void {
    const current = slot === 'primary' ? agentPrimary : agentBackup
    if (current.mode === mode) return
    updateAgentEndpoint(slot, {
      mode,
      baseUrl: current.mode === 'cc-switch-codex-oauth' ? 'https://api.openai.com/v1' : current.baseUrl
    })
  }

  function updateTtsEndpoint(slot: 'primary' | 'backup', patch: Partial<TtsEndpointSettings>): void {
    const setter = slot === 'primary' ? setTtsPrimary : setTtsBackup
    setter((current) => ({ ...current, ...patch }))
  }

  function changeTtsMode(slot: 'primary' | 'backup', mode: TtsProviderMode): void {
    const current = slot === 'primary' ? ttsPrimary : ttsBackup
    if (current.mode === mode) return
    if (mode === 'elevenlabs') {
      updateTtsEndpoint(slot, {
        mode,
        baseUrl: 'https://api.elevenlabs.io/v1',
        model: 'eleven_multilingual_v2',
        voice: '',
        instructions: ''
      })
      return
    }
    if (mode === 'openai-compatible') {
      updateTtsEndpoint(slot, {
        mode,
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini-tts',
        voice: 'marin',
        instructions: '使用自然、清晰、克制的中文语气，像一位熟悉业务的项目助理。'
      })
      return
    }
    updateTtsEndpoint(slot, { mode })
  }

  function latestRunFor(connectorId: string): ConnectorRun | undefined {
    return bootstrap.connectorRuns.find((run) => run.connectorId === connectorId)
  }

  async function runConnector(connector: ConnectorInstance): Promise<void> {
    setBusyConnectors((current) => new Set(current).add(connector.id))
    try {
      const result = await window.projectAgent.runConnector(connector.id)
      onNotice(result.message)
      await onRefresh()
    } finally {
      setBusyConnectors((current) => {
        const next = new Set(current)
        next.delete(connector.id)
        return next
      })
    }
  }

  async function runAll(): Promise<void> {
    setRunningAll(true)
    try {
      const result = await window.projectAgent.runConnectors(projectId)
      const decisions = result.results.filter((item) => item.decision).length
      onNotice(`巡检完成：${result.succeeded} 个成功，${result.failed} 个失败，新增 ${decisions} 条决策项。`)
      await onRefresh()
    } finally {
      setRunningAll(false)
    }
  }

  async function toggleConnector(connector: ConnectorInstance): Promise<void> {
    await window.projectAgent.setConnectorEnabled(connector.id, !connector.enabled)
    onNotice(`${connector.name} 已${connector.enabled ? '停用' : '启用'}。`)
    await onRefresh()
  }

  function openPostgresForm(): void {
    if (!projectId) return
    if (selectedPostgres?.config.credentialSource === 'env-file') {
      onNotice('Roombase 生产分析连接由项目 Analytics Profile 管理，不在 UI 中展开凭证。')
      return
    }
    if (selectedPostgres) {
      const { host, port, database, user, sslMode, metricView } = selectedPostgres.config
      setPostgresConnection(
        `postgresql://${encodeURIComponent(String(user))}@${String(host)}:${String(port)}/${encodeURIComponent(String(database))}?sslmode=${String(sslMode)}`
      )
      setPostgresMetricView(typeof metricView === 'string' ? metricView : '')
      setPostgresAnalyticsProfile(typeof selectedPostgres.config.analyticsProfile === 'string'
        ? selectedPostgres.config.analyticsProfile
        : '')
    } else {
      setPostgresConnection('')
      setPostgresMetricView('')
      setPostgresAnalyticsProfile(bootstrap.analyticsProfiles.find((profile) => profile.projectId === projectId)?.id ?? '')
    }
    setPostgresError(null)
    setPostgresFormOpen(true)
  }

  function closePostgresForm(): void {
    setPostgresFormOpen(false)
    setPostgresConnection('')
    setPostgresMetricView('')
    setPostgresAnalyticsProfile('')
    setPostgresError(null)
  }

  async function configurePostgres(): Promise<void> {
    if (!projectId || !postgresConnection.trim()) return
    setSavingPostgres(true)
    setPostgresError(null)
    try {
      const result = await window.projectAgent.configurePostgres({
        projectId,
        connectionString: postgresConnection.trim(),
        metricView: postgresMetricView.trim() || undefined,
        analyticsProfile: postgresAnalyticsProfile || undefined
      })
      if (result.run.status === 'failed') {
        setPostgresError(result.message)
      } else {
        setPostgresFormOpen(false)
        setPostgresConnection('')
        onNotice(`${selectedProject?.name ?? '项目'} PostgreSQL 已保存并通过只读连接测试。`)
      }
      await onRefresh()
    } catch (error) {
      setPostgresError(error instanceof Error ? error.message : 'PostgreSQL 配置失败。')
    } finally {
      setSavingPostgres(false)
    }
  }

  async function requestComputerPermissions(): Promise<void> {
    if (requestingComputerPermissions) return
    setRequestingComputerPermissions(true)
    try {
      const capabilities = await window.projectAgent.requestComputerUsePermissions()
      const computer = capabilities.find((item) => item.id === 'computer')
      await onRefresh()
      onNotice(computer?.status === 'ready'
        ? 'Computer Use 所需的屏幕录制与辅助功能权限已就绪。'
        : '已打开 macOS 权限设置。完成授权后请重启 Project Agent，使 CUA Driver 继承新的权限。')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '无法请求 Computer Use 权限。')
    } finally {
      setRequestingComputerPermissions(false)
    }
  }

  async function beginCompanionPairing(): Promise<void> {
    if (companionBusy) return
    setCompanionBusy('pair')
    setCompanionError(null)
    try {
      const pairing = await window.projectAgent.beginCompanionPairing(companionRelayUrl.trim())
      setCompanionPairing(pairing)
      setCompanionStatus(pairing.status)
      onNotice('已创建一次性 iPhone 配对信息，请在 10 分钟内扫描或粘贴到手机。')
    } catch (error) {
      setCompanionError(error instanceof Error ? error.message : '创建 iPhone 配对失败。')
    } finally {
      setCompanionBusy(null)
    }
  }

  async function syncCompanionNow(): Promise<void> {
    if (companionBusy) return
    setCompanionBusy('sync')
    setCompanionError(null)
    try {
      setCompanionStatus(await window.projectAgent.syncCompanionNow())
      onNotice('iPhone Companion 已同步。')
    } catch (error) {
      setCompanionError(error instanceof Error ? error.message : '同步失败。')
    } finally {
      setCompanionBusy(null)
    }
  }

  async function disconnectCompanion(): Promise<void> {
    if (companionBusy) return
    setCompanionBusy('disconnect')
    setCompanionError(null)
    try {
      await window.projectAgent.disconnectCompanion()
      setCompanionPairing(null)
      setCompanionStatus(await window.projectAgent.getCompanionStatus())
      onNotice('已断开 iPhone Companion。')
    } catch (error) {
      setCompanionError(error instanceof Error ? error.message : '断开 Companion 失败。')
    } finally {
      setCompanionBusy(null)
    }
  }

  async function copyCompanionPairing(): Promise<void> {
    if (!companionPairing) return
    await navigator.clipboard.writeText(companionPairing.pairingPayload)
    onNotice('配对信息已复制。')
  }

  async function runProjectAgent(projectProfileId: string): Promise<void> {
    const profile = bootstrap.analyticsProfiles.find((candidate) => candidate.id === projectProfileId)
    if (!profile || !['vows', 'ai-marketing'].includes(profile.projectId)) return
    setProjectAgentBusy(profile.id)
    try {
      const result = await window.projectAgent.dispatchProjectAgent({
        requestId: crypto.randomUUID(),
        projectId: profile.projectId as 'vows' | 'ai-marketing',
        prompt: `围绕当前目标“${profile.objective}”检查最新状态，给出本周最小可执行动作；先产出草案，不执行任何需要批准的外部动作。`
      }, () => undefined)
      onNotice(result.mode === 'repo-skill'
        ? `已创建 ${profile.projectName} Agent Run。`
        : `${profile.projectName} Super Agent 已返回：${result.message.slice(0, 120)}`)
      await onRefresh()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Project Agent 启动失败。')
    } finally {
      setProjectAgentBusy(null)
    }
  }

  function openConnectorForm(kind: Exclude<ConnectorKind, 'repo' | 'postgres'>): void {
    if (!projectId) return
    const existing = bootstrap.connectors.find((connector) => connector.projectId === projectId && connector.kind === kind)
    if (kind === 'cloudflare') {
      setConnectorFields({ accountId: String(existing?.config.accountId ?? ''), zoneId: String(existing?.config.zoneId ?? ''), apiToken: '' })
    } else if (kind === 'ga4') {
      setConnectorFields({ propertyId: String(existing?.config.propertyId ?? ''), accessToken: '', refreshToken: '', clientId: '', clientSecret: '' })
    } else {
      const isAiMarketing = selectedProject?.id === 'ai-marketing'
      setConnectorFields({
        agentName: String(existing?.config.agentName ?? (isAiMarketing ? 'AI Marketing Super Agent' : `${selectedProject?.name ?? 'Project'} Agent`)),
        baseUrl: String(existing?.config.baseUrl ?? ''),
        statusPath: String(existing?.config.statusPath ?? (isAiMarketing ? '/api/super-agent/threads' : '/status')),
        apiKey: ''
      })
    }
    setConnectorSetupError(null)
    setConnectorFormKind(kind)
  }

  async function configureConnector(): Promise<void> {
    if (!projectId || !connectorFormKind) return
    setSavingConnector(true)
    setConnectorSetupError(null)
    try {
      const result = connectorFormKind === 'cloudflare'
        ? await window.projectAgent.configureConnector({
            kind: 'cloudflare', projectId,
            accountId: connectorFields.accountId?.trim() ?? '',
            zoneId: connectorFields.zoneId?.trim() || undefined,
            apiToken: connectorFields.apiToken?.trim() || undefined
          })
        : connectorFormKind === 'ga4'
          ? await window.projectAgent.configureConnector({
              kind: 'ga4', projectId,
              propertyId: connectorFields.propertyId?.trim() ?? '',
              accessToken: connectorFields.accessToken?.trim() || undefined,
              refreshToken: connectorFields.refreshToken?.trim() || undefined,
              clientId: connectorFields.clientId?.trim() || undefined,
              clientSecret: connectorFields.clientSecret?.trim() || undefined
            })
          : await window.projectAgent.configureConnector({
              kind: 'project-agent', projectId,
              agentName: connectorFields.agentName?.trim() ?? '',
              baseUrl: connectorFields.baseUrl?.trim() ?? '',
              statusPath: connectorFields.statusPath?.trim() || undefined,
              apiKey: connectorFields.apiKey?.trim() || undefined
            })
      if (result.run.status === 'failed') setConnectorSetupError(result.message)
      else {
        onNotice(`${result.connector.name} 已保存并通过连接测试。`)
        setConnectorFormKind(null)
        setConnectorFields({})
      }
      await onRefresh()
    } catch (error) {
      setConnectorSetupError(error instanceof Error ? error.message : 'Connector 配置失败。')
    } finally {
      setSavingConnector(false)
    }
  }

  async function saveAgentProvider(): Promise<void> {
    setProviderBusy('agent')
    setProviderError(null)
    try {
      await window.projectAgent.configureAgentProvider({
        primary: {
          mode: agentPrimary.mode,
          baseUrl: agentPrimary.baseUrl,
          model: agentPrimary.model,
          apiKey: agentApiKeys.primary.trim() || undefined
        },
        backup: {
          mode: agentBackup.mode,
          baseUrl: agentBackup.baseUrl,
          model: agentBackup.model,
          apiKey: agentApiKeys.backup.trim() || undefined
        },
        backupEnabled: agentBackupEnabled
      })
      setAgentApiKeys({ primary: '', backup: '' })
      onNotice('模型配置已保存；默认配置失败时会自动切换到备用配置。')
      await onRefresh()
    } catch (error) {
      setProviderError(error instanceof Error ? error.message : 'Agent Provider 保存失败。')
    } finally {
      setProviderBusy(null)
    }
  }

  async function saveCodingAgents(): Promise<void> {
    setProviderBusy('coding-agents')
    setProviderError(null)
    try {
      await window.projectAgent.configureCodingAgents(codingAgents)
      onNotice('默认 Coding Agent 和模型配置已保存。')
      await onRefresh()
    } catch (error) {
      setProviderError(error instanceof Error ? error.message : 'Coding Agent 配置保存失败。')
    } finally {
      setProviderBusy(null)
    }
  }

  async function detectCodingAgents(): Promise<void> {
    setProviderBusy('coding-detect')
    setProviderError(null)
    try {
      const [, catalog] = await Promise.all([
        onRefresh(),
        window.projectAgent.listCodingAgentModels()
      ])
      setCodingAgentModels(catalog)
      onNotice('已重新检测 Coding Agent 并读取可用模型。')
    } catch (error) {
      setProviderError(error instanceof Error ? error.message : 'Coding Agent 检测失败。')
    } finally {
      setProviderBusy(null)
    }
  }

  async function saveTtsProvider(testAfterSave = false): Promise<void> {
    setProviderBusy(testAfterSave ? 'tts-test' : 'tts')
    setProviderError(null)
    try {
      await window.projectAgent.configureTtsProvider({
        primary: {
          mode: ttsPrimary.mode,
          baseUrl: ttsPrimary.baseUrl,
          model: ttsPrimary.model,
          voice: ttsPrimary.voice,
          instructions: ttsPrimary.instructions,
          apiKey: ttsApiKeys.primary.trim() || undefined
        },
        backup: {
          mode: ttsBackup.mode,
          baseUrl: ttsBackup.baseUrl,
          model: ttsBackup.model,
          voice: ttsBackup.voice,
          instructions: ttsBackup.instructions,
          apiKey: ttsApiKeys.backup.trim() || undefined
        },
        backupEnabled: ttsBackupEnabled
      })
      setTtsApiKeys({ primary: '', backup: '' })
      if (testAfterSave) {
        const result = await window.projectAgent.testTtsProvider()
        if (result.audioDataUrl) await new Audio(result.audioDataUrl).play()
        onNotice(result.message)
      } else {
        onNotice('语音配置已保存；默认配置失败时会自动切换到备用配置。')
      }
      await onRefresh()
    } catch (error) {
      setProviderError(error instanceof Error ? error.message : 'TTS Provider 请求失败。')
    } finally {
      setProviderBusy(null)
    }
  }

  async function designElevenLabsVoice(): Promise<void> {
    setProviderBusy('tts-voice-design')
    setProviderError(null)
    try {
      const result = await window.projectAgent.designElevenLabsVoice()
      const nextPrimary = {
        ...ttsPrimary,
        model: 'eleven_flash_v2_5',
        voice: result.voiceId,
        apiKeyConfigured: true
      }
      setTtsPrimary(nextPrimary)
      await window.projectAgent.configureTtsProvider({
        primary: {
          mode: nextPrimary.mode,
          baseUrl: nextPrimary.baseUrl,
          model: nextPrimary.model,
          voice: nextPrimary.voice,
          instructions: nextPrimary.instructions
        },
        backup: {
          mode: ttsBackup.mode,
          baseUrl: ttsBackup.baseUrl,
          model: ttsBackup.model,
          voice: ttsBackup.voice,
          instructions: ttsBackup.instructions
        },
        backupEnabled: ttsBackupEnabled
      })
      await new Audio(result.audioDataUrl).play()
      onNotice(result.message)
      await onRefresh()
    } catch (error) {
      setProviderError(error instanceof Error ? error.message : 'ElevenLabs Voice Design 请求失败。')
    } finally {
      setProviderBusy(null)
    }
  }

  function isLoopbackEndpoint(baseUrl: string): boolean {
    try {
      return ['localhost', '127.0.0.1', '::1'].includes(new URL(baseUrl).hostname)
    } catch {
      return false
    }
  }

  function agentEndpointReady(endpoint: AgentEndpointSettings): boolean {
    if (endpoint.mode === 'cc-switch-codex-oauth') return isLoopbackEndpoint(endpoint.baseUrl)
    return endpoint.apiKeyConfigured || isLoopbackEndpoint(endpoint.baseUrl)
  }

  function agentEndpointStatus(endpoint: AgentEndpointSettings): string {
    if (endpoint.mode === 'cc-switch-codex-oauth') return '本地订阅'
    if (isLoopbackEndpoint(endpoint.baseUrl) && !endpoint.apiKeyConfigured) return '本地代理'
    return endpoint.apiKeyConfigured ? '已配置' : '缺少 Key'
  }

  function endpointStatus(mode: TtsProviderMode, configured: boolean): string {
    if (mode === 'system') return '系统语音'
    return configured ? '已配置' : '缺少 Key'
  }

  function renderAgentEndpoint(slot: 'primary' | 'backup', endpoint: AgentEndpointSettings): React.JSX.Element {
    const apiKey = agentApiKeys[slot]
    return (
      <div className="provider-fields">
        <div className="provider-field">
          <span>API 协议</span>
          <SelectMenu
            value={endpoint.mode}
            options={[
              { value: 'openai-compatible', label: 'OpenAI Compatible API' }
            ]}
            onChange={(mode) => changeAgentMode(slot, mode)}
            ariaLabel={`${slot === 'primary' ? '默认' : '备用'}模型协议`}
          />
        </div>
        <label>
          <span>Base URL</span>
          <input
            value={endpoint.baseUrl}
            onChange={(event) => updateAgentEndpoint(slot, { baseUrl: event.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </label>
        <label>
          <span>Model</span>
          <input
            value={endpoint.model}
            onChange={(event) => updateAgentEndpoint(slot, { model: event.target.value })}
            placeholder="gpt-5.6-sol"
          />
        </label>
        {endpoint.mode === 'openai-compatible' && (
          <label>
            <span>API Key</span>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setAgentApiKeys((current) => ({ ...current, [slot]: event.target.value }))}
              placeholder={endpoint.apiKeyConfigured ? '已保存；留空保持不变' : isLoopbackEndpoint(endpoint.baseUrl) ? '本地代理可留空' : '输入 API Key'}
            />
          </label>
        )}
      </div>
    )
  }

  function renderTtsEndpoint(slot: 'primary' | 'backup', endpoint: TtsEndpointSettings): React.JSX.Element {
    const apiKey = ttsApiKeys[slot]
    return (
      <div className="provider-fields">
        <div className="provider-field">
          <span>语音服务</span>
          <SelectMenu
            value={endpoint.mode}
            options={[
              { value: 'system', label: 'macOS 系统中文语音' },
              { value: 'openai-compatible', label: 'OpenAI Compatible Speech API' },
              { value: 'elevenlabs', label: 'ElevenLabs' }
            ]}
            onChange={(mode) => changeTtsMode(slot, mode)}
            ariaLabel={`${slot === 'primary' ? '默认' : '备用'}语音服务`}
          />
        </div>
        {endpoint.mode === 'system' ? (
          <p className="provider-inline-note">无需 API Key，使用系统语音在本机播放。</p>
        ) : (
          <>
            <label>
              <span>Base URL</span>
              <input
                value={endpoint.baseUrl}
                onChange={(event) => updateTtsEndpoint(slot, { baseUrl: event.target.value })}
                placeholder={endpoint.mode === 'elevenlabs' ? 'https://api.elevenlabs.io/v1' : 'https://api.openai.com/v1'}
              />
            </label>
            <label>
              <span>Model</span>
              {endpoint.mode === 'elevenlabs' ? (
                <SuggestionInput
                  value={endpoint.model}
                  suggestions={['eleven_flash_v2_5', 'eleven_multilingual_v2', 'eleven_v3']}
                  onChange={(model) => updateTtsEndpoint(slot, { model })}
                  ariaLabel="ElevenLabs 模型"
                  placeholder="eleven_flash_v2_5"
                />
              ) : (
                <input
                  value={endpoint.model}
                  onChange={(event) => updateTtsEndpoint(slot, { model: event.target.value })}
                  placeholder="gpt-4o-mini-tts"
                />
              )}
            </label>
            <label>
              <span>{endpoint.mode === 'elevenlabs' ? 'Voice ID' : 'Voice'}</span>
              {endpoint.mode === 'openai-compatible' ? (
                <SuggestionInput
                  value={endpoint.voice}
                  suggestions={['marin', 'cedar', 'coral', 'nova', 'alloy']}
                  onChange={(voice) => updateTtsEndpoint(slot, { voice })}
                  ariaLabel="OpenAI 语音"
                  placeholder="marin"
                />
              ) : (
                <input
                  value={endpoint.voice}
                  onChange={(event) => updateTtsEndpoint(slot, { voice: event.target.value })}
                  placeholder="粘贴 ElevenLabs Voice ID"
                />
              )}
            </label>
            {endpoint.mode === 'openai-compatible' && (
              <label>
                <span>声音指令</span>
                <textarea
                  rows={3}
                  value={endpoint.instructions}
                  onChange={(event) => updateTtsEndpoint(slot, { instructions: event.target.value })}
                />
              </label>
            )}
            <label>
              <span>API Key</span>
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setTtsApiKeys((current) => ({ ...current, [slot]: event.target.value }))}
                placeholder={endpoint.apiKeyConfigured ? '已保存；留空保持不变' : '输入 API Key'}
              />
            </label>
          </>
        )}
      </div>
    )
  }

  return (
    <div className={`settings-view settings-view-${section}`}>
      {section === 'general' && <section className="settings-group-section">
        <div className="settings-group-heading">
          <h2>工作区概览</h2>
          <p>工作助理、每日简报、项目和 Agent 能力的当前状态。</p>
        </div>
        <div className="settings-summary-grid">
          <article>
            <span className="settings-icon"><Headphones size={17} /></span>
            <div>
              <small>每日简报</small>
              <strong>每天 09:00 自动发送</strong>
              <p>汇总所有项目，以语音卡片投递到工作助理时间线。</p>
            </div>
          </article>
          <article>
            <span className="settings-icon"><Folder size={17} /></span>
            <div>
              <small>项目工作区</small>
              <strong>{bootstrap.projects.length} 个项目</strong>
              <p>{bootstrap.projects.map((project) => project.name).join('、')}</p>
            </div>
          </article>
        </div>
        <div className="settings-subsection-heading companion-settings-heading">
          <div>
            <h3>iPhone Companion</h3>
            <p>手机只作为安全客户端；Agent、工具和项目文件仍在这台 Mac 上运行。</p>
          </div>
          <span className={`settings-value-pill ${companionStatus?.realtimeState === 'connected' ? 'is-ready' : ''}`}>
            {!companionStatus?.configuration
              ? '未配对'
              : companionStatus.realtimeState === 'connected'
                ? '实时在线'
                : companionStatus.realtimeState === 'connecting'
                  ? '实时连接中'
                  : companionStatus.state === 'connected'
                    ? '仅同步在线'
                    : '离线'}
          </span>
        </div>
        <div className="companion-settings-card">
          <span className="settings-icon"><Smartphone size={18} /></span>
          <div className="companion-settings-main">
            <label>
              <span>Cloudflare Relay</span>
              <input
                type="url"
                value={companionRelayUrl}
                disabled={Boolean(companionStatus?.configuration)}
                onChange={(event) => setCompanionRelayUrl(event.target.value)}
                placeholder={defaultCompanionRelayUrl}
              />
            </label>
            {companionStatus?.configuration && (
              <p>
                Mac Device {companionStatus.configuration.macDeviceId.slice(0, 8)}
                {' · '}{companionStatus.pendingEvents} 条待同步
                {companionStatus.lastConnectedAt ? ` · 实时响应 ${formatRelativeTime(companionStatus.lastConnectedAt)}` : ''}
                {companionStatus.lastSyncedAt ? ` · 最近同步 ${formatRelativeTime(companionStatus.lastSyncedAt)}` : ''}
              </p>
            )}
            {companionPairing && (
              <div className="companion-pairing-payload">
                <div className="companion-pairing-qr" aria-label="iPhone Companion 配对二维码">
                  <QRCodeSVG
                    value={companionPairing.pairingPayload}
                    size={132}
                    marginSize={2}
                    level="M"
                  />
                </div>
                <div className="companion-pairing-copy">
                  <strong>使用 iPhone 扫描</strong>
                  <p>{formatExpiryLabel(companionPairing.expiresAt)}，也可以通过通用剪贴板复制。</p>
                  <code>{companionPairing.pairingPayload}</code>
                  <button type="button" onClick={() => void copyCompanionPairing()}><Copy size={13} /> 复制配对信息</button>
                </div>
              </div>
            )}
            {companionError && <p className="provider-settings-error">{companionError}</p>}
            {companionStatus?.lastError && !companionError && <p className="provider-settings-error">{companionStatus.lastError}</p>}
          </div>
          <div className="companion-settings-actions">
            {!companionStatus?.configuration ? (
              <button className="provider-save-button" onClick={() => void beginCompanionPairing()} disabled={Boolean(companionBusy) || !companionRelayUrl.trim()}>
                {companionBusy === 'pair' ? <LoaderCircle className="spin" size={13} /> : <Smartphone size={13} />}
                配对 iPhone
              </button>
            ) : (
              <>
                <button className="secondary-action-button" onClick={() => void syncCompanionNow()} disabled={Boolean(companionBusy)}>
                  {companionBusy === 'sync' ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
                  立即同步
                </button>
                <button className="secondary-action-button" onClick={() => void disconnectCompanion()} disabled={Boolean(companionBusy)}>
                  {companionBusy === 'disconnect' ? <LoaderCircle className="spin" size={13} /> : <X size={13} />}
                  断开
                </button>
              </>
            )}
          </div>
        </div>
        <div className="settings-subsection-heading">
          <div>
            <h3>本机 Agent 能力</h3>
            <p>Agent Run 可以使用的本机交互能力及当前状态。</p>
          </div>
        </div>
        <div className="runtime-capability-list">
          {bootstrap.capabilities.filter((item) => item.id === 'browser' || item.id === 'computer').map((capability) => (
            <article key={capability.id}>
              <div className="runtime-capability-heading">
                <span className={`capability-dot capability-${capability.status}`} />
                <strong>{capability.label}</strong>
                <small>{capability.status === 'ready' ? '可用' : capability.status === 'needs-setup' ? '需要配置' : capability.status === 'scaffolded' ? '准备中' : '不可用'}</small>
              </div>
              <p>{capability.detail}</p>
              {capability.id === 'computer' && capability.status !== 'ready' && (
                <button onClick={() => void requestComputerPermissions()} disabled={requestingComputerPermissions}>
                  {requestingComputerPermissions ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />}
                  配置系统权限
                </button>
              )}
            </article>
          ))}
        </div>
      </section>}

      {section === 'models' && <section className="provider-config-page">
        <div className="settings-group-heading">
          <h2>模型优先级</h2>
          <p>默认模型不可用时，助理会自动尝试备用配置。</p>
        </div>
        <div className="provider-config-group">
          <div className="provider-config-block">
            <div className="provider-config-heading">
              <div>
                <span>PRIMARY</span>
                <strong>默认模型</strong>
                <p>用于每日总结、分析和后续对话。</p>
              </div>
              <span className={`provider-ready-pill ${agentEndpointReady(agentPrimary) ? 'is-ready' : ''}`}>
                {agentEndpointStatus(agentPrimary)}
              </span>
            </div>
            {renderAgentEndpoint('primary', agentPrimary)}
          </div>

          <div className={`provider-config-block provider-backup-block ${agentBackupEnabled ? 'is-enabled' : ''}`}>
            <div className="provider-config-heading">
              <div>
                <span>BACKUP</span>
                <strong>备用模型</strong>
                <p>默认模型请求失败时自动重试一次。</p>
              </div>
              <label className="provider-toggle">
                <input type="checkbox" checked={agentBackupEnabled} onChange={(event) => setAgentBackupEnabled(event.target.checked)} />
                <i />
                <span>{agentBackupEnabled ? '已启用' : '未启用'}</span>
              </label>
            </div>
            {agentBackupEnabled && renderAgentEndpoint('backup', agentBackup)}
          </div>
        </div>

        {providerError && <p className="provider-settings-error">{providerError}</p>}
        <div className="provider-page-actions">
          <button className="provider-save-button" onClick={() => void saveAgentProvider()} disabled={providerBusy !== null}>
            {providerBusy === 'agent' ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}
            保存模型配置
          </button>
        </div>
        <p className="provider-security-note"><ShieldCheck size={12} /> API Key 仅保存在 macOS Keychain 中。</p>

        <div className="settings-group-heading coding-agent-settings-heading">
          <h2>Coding Agents</h2>
          <p>选择默认 Coding Agent，并为每个本机 Agent 配置运行时使用的模型。</p>
        </div>
        <div className="coding-agent-default-control">
          <div>
            <strong>默认 Coding Agent</strong>
            <p>“去处理”等未手动选择 Agent 的入口会使用这个 Agent。</p>
          </div>
          <SelectMenu
            value={codingAgents.defaultAgent}
            options={codingAgentOptions.map((option) => ({ value: option.id, label: option.label }))}
            onChange={(value) => setCodingAgents((current) => ({
              ...current,
              defaultAgent: value as CodingAgentProvider
            }))}
            ariaLabel="默认 Coding Agent"
          />
        </div>
        <div className="coding-agent-config-list">
          {codingAgentOptions.map((option) => {
            const capability = bootstrap.capabilities.find((item) => item.id === option.id)
            const installed = capability?.status === 'ready'
            const catalog = codingAgentModels?.[option.id]
            const savedModel = codingAgents[option.id].defaultModel
            const discoveredModels = catalog?.models ?? []
            const savedModelWasDiscovered = discoveredModels.some((model) => model.id === savedModel)
            const modelOptions = [
              { value: '', label: `使用 ${option.label} 默认模型` },
              ...discoveredModels.map((model) => ({
                value: model.id,
                label: `${model.label === model.id ? model.id : `${model.label} · ${model.id}`}${model.isDefault ? ' · Agent 推荐' : ''}`
              })),
              ...(savedModel && !savedModelWasDiscovered
                ? [{ value: savedModel, label: `${savedModel} · 已保存，当前未返回` }]
                : [])
            ]
            const selectedModel = discoveredModels.find((model) => model.id === savedModel)
            return (
              <article key={option.id}>
                <div className="coding-agent-config-heading">
                  <span className={`capability-dot capability-${capability?.status ?? 'needs-setup'}`} />
                  <div>
                    <strong>{option.label}</strong>
                    <p>{capability?.detail ?? '尚未检测'}</p>
                  </div>
                  <span className={`provider-ready-pill ${installed ? 'is-ready' : ''}`}>
                    {installed ? '已安装' : '未安装'}
                  </span>
                </div>
                <div className="coding-agent-config-controls">
                  <label>
                    <span>默认模型</span>
                    <SelectMenu
                      value={savedModel}
                      options={modelOptions}
                      onChange={(value) => setCodingAgents((current) => ({
                        ...current,
                        [option.id]: { defaultModel: value }
                      }))}
                      ariaLabel={`${option.label} 默认模型`}
                      disabled={codingModelsLoading && !catalog}
                      position={option.id === 'opencode' ? 'up' : 'down'}
                    />
                  </label>
                  <p className={`coding-agent-model-detail ${catalog?.error ? 'is-error' : ''}`}>
                    {codingModelsLoading && !catalog
                      ? '正在读取支持的模型…'
                      : catalog?.error
                        ? catalog.error
                        : savedModel
                          ? selectedModel?.description ?? savedModel
                          : '运行时不传 model 参数，使用 Agent 自己的默认配置。'}
                  </p>
                </div>
              </article>
            )
          })}
        </div>
        <div className="provider-page-actions">
          <button className="secondary-action-button" onClick={() => void detectCodingAgents()} disabled={providerBusy !== null}>
            {providerBusy === 'coding-detect' ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
            重新检测
          </button>
          <button className="provider-save-button" onClick={() => void saveCodingAgents()} disabled={providerBusy !== null}>
            {providerBusy === 'coding-agents' ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}
            保存 Coding Agent 配置
          </button>
        </div>
      </section>}

      {section === 'voice' && <section className="provider-config-page">
        <div className="settings-group-heading">
          <h2>语音优先级</h2>
          <p>云端语音不可用时，自动切换到备用声音继续播报。</p>
        </div>
        <div className="provider-config-group">
          <div className="provider-config-block">
            <div className="provider-config-heading">
              <div>
                <span>PRIMARY</span>
                <strong>默认语音</strong>
                <p>每日简报优先使用这里的声音。</p>
              </div>
              <span className={`provider-ready-pill ${ttsPrimary.mode === 'system' || ttsPrimary.apiKeyConfigured ? 'is-ready' : ''}`}>
                {endpointStatus(ttsPrimary.mode, ttsPrimary.apiKeyConfigured)}
              </span>
            </div>
            {renderTtsEndpoint('primary', ttsPrimary)}
          </div>

          <div className={`provider-config-block provider-backup-block ${ttsBackupEnabled ? 'is-enabled' : ''}`}>
            <div className="provider-config-heading">
              <div>
                <span>BACKUP</span>
                <strong>备用语音</strong>
                <p>默认语音生成失败时自动切换。</p>
              </div>
              <label className="provider-toggle">
                <input type="checkbox" checked={ttsBackupEnabled} onChange={(event) => setTtsBackupEnabled(event.target.checked)} />
                <i />
                <span>{ttsBackupEnabled ? '已启用' : '未启用'}</span>
              </label>
            </div>
            {ttsBackupEnabled && renderTtsEndpoint('backup', ttsBackup)}
          </div>
        </div>

        {providerError && <p className="provider-settings-error">{providerError}</p>}
        <div className="provider-page-actions">
          {ttsPrimary.mode === 'elevenlabs' && (
            <button
              className="secondary-action-button"
              onClick={() => void designElevenLabsVoice()}
              disabled={providerBusy !== null || !ttsPrimary.apiKeyConfigured}
              title="优先查找网页端创建的账户自有声音；付费账户也可通过 API 创建"
            >
              {providerBusy === 'tts-voice-design' ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />}
              查找账户女声
            </button>
          )}
          <button className="provider-save-button" onClick={() => void saveTtsProvider(false)} disabled={providerBusy !== null}>
            {providerBusy === 'tts' ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}
            保存语音配置
          </button>
          <button className="secondary-action-button" onClick={() => void saveTtsProvider(true)} disabled={providerBusy !== null || ttsPrimary.mode === 'system'}>
            {providerBusy === 'tts-test' ? <LoaderCircle className="spin" size={13} /> : <Play size={12} fill="currentColor" />}
            保存并试听
          </button>
        </div>
        <p className="provider-security-note"><ShieldCheck size={12} /> API Key 仅保存在 macOS Keychain 中。</p>
      </section>}

      {section === 'permissions' && <section className="settings-group-section">
        <div className="settings-group-heading">
          <h2>默认执行策略</h2>
          <p>Agent Runs 默认拥有本机完整访问权限，所有工具调用自动批准。</p>
        </div>
        <div className="settings-detail-list">
          <article>
            <span className="settings-icon"><ShieldCheck size={17} /></span>
            <div>
              <small>默认审批策略</small>
              <strong>Full access</strong>
              <p>文件、命令、网络、浏览器和应用操作均不经过沙箱，并自动批准。</p>
            </div>
            <span className="settings-value-pill is-ready">已启用</span>
          </article>
          <article>
            <span className="settings-icon"><CircleAlert size={17} /></span>
            <div>
              <small>Agent 审批</small>
              <strong>自动批准</strong>
              <p>所有 Agent Provider 使用相同的完全访问策略，不弹出逐次审批。</p>
            </div>
          </article>
          <article>
            <span className="settings-icon"><Settings2 size={17} /></span>
            <div>
              <small>凭证存储</small>
              <strong>{bootstrap.credentialStorage.available ? '安全存储可用' : '安全存储不可用'}</strong>
              <p>{bootstrap.credentialStorage.detail}</p>
            </div>
          </article>
          <article>
            <span className="settings-icon"><Clock3 size={17} /></span>
            <div>
              <small>审计记录</small>
              <strong>所有操作保留记录</strong>
              <p>自动批准的操作仍保留工具、目标、时间、风险等级与结果。</p>
            </div>
          </article>
        </div>
      </section>}

      {section === 'connectors' && <>
      {!projectLocked && <div className="settings-project-scope">
        <div>
          <strong>项目范围</strong>
          <small>选择一个项目可配置它的 PostgreSQL 数据连接。</small>
        </div>
        <SelectMenu
          className="project-scope-select"
          value={projectId ?? ''}
          options={[
            { value: '', label: '全部项目' },
            ...bootstrap.projects.map((project) => ({ value: project.id, label: project.name }))
          ]}
          onChange={(value) => onProjectChange(value || null)}
          ariaLabel="Connector 项目范围"
        />
      </div>}
      <section className="settings-section">
        <div className="settings-section-header">
          <div>
            <span className="settings-kicker">连接与数据</span>
            <h2>已配置的 Connectors</h2>
            <p>Connector 负责取证；变化经过指纹去重后回投决策收件箱。</p>
          </div>
          <button className="secondary-action-button" onClick={() => void runAll()} disabled={runningAll}>
            <RefreshCw size={14} className={runningAll ? 'spin' : ''} />
            {projectId ? '巡检当前项目' : '巡检全部项目'}
          </button>
        </div>

        <div className="connector-list">
          {visibleConnectors.map((connector) => {
            const project = bootstrap.projects.find((candidate) => candidate.id === connector.projectId)
            const latestRun = latestRunFor(connector.id)
            const busy = busyConnectors.has(connector.id) || connector.status === 'running'
            const isRepo = connector.kind === 'repo'
            const connectorLocation = isRepo
              ? String(connector.config.repoPath ?? '')
              : connector.config.analyticsProfile
                ? `Analytics Profile · ${String(connector.config.analyticsProfile)}`
                : connector.kind === 'postgres'
                  ? `${String(connector.config.user ?? '')}@${String(connector.config.host ?? '')}:${String(connector.config.port ?? '')}/${String(connector.config.database ?? '')}`
                  : connector.kind === 'cloudflare'
                    ? `Account ${String(connector.config.accountId ?? '')}${connector.config.zoneId ? ` · Zone ${String(connector.config.zoneId)}` : ''}`
                    : connector.kind === 'ga4'
                      ? `Property ${String(connector.config.propertyId ?? '')}`
                      : `${String(connector.config.baseUrl ?? '')}${String(connector.config.statusPath ?? '')}`
            return (
              <article className="connector-row" key={connector.id}>
                <span className="connector-kind-icon">
                  {isRepo ? <GitBranch size={17} /> : <Database size={17} />}
                </span>
                <div className="connector-main">
                  <div className="connector-title-row">
                    <strong>{connector.name}</strong>
                    <span className={`connector-status connector-status-${connector.status}`}>
                      {connectorStatusLabels[connector.status]}
                    </span>
                  </div>
                  <span className="connector-project">
                    {project?.name} · {isRepo ? 'Local Repo' : bootstrap.connectorCatalog.find((item) => item.kind === connector.kind)?.label}
                  </span>
                  <code>{connectorLocation}</code>
                  {!isRepo && typeof connector.config.metricView === 'string' && connector.config.metricView && (
                    <span className="metric-view-label">指标 View · {connector.config.metricView}</span>
                  )}
                  {latestRun && (
                    <p className={latestRun.status === 'failed' ? 'connector-error' : ''}>
                      {latestRun.summary}
                    </p>
                  )}
                  {!latestRun && <p>尚未巡检。首次运行会验证路径并读取 Git 元数据。</p>}
                  <span className="connector-footnote">
                    {connector.lastSyncAt ? `上次运行于 ${formatRelativeTime(connector.lastSyncAt)}` : '还没有运行记录'}
                    {' · '}{isRepo
                      ? '不读取源码与敏感文件'
                      : connector.config.credentialSource === 'env-file'
                        ? '只读事务 · 引用项目现有环境配置'
                        : `${connector.kind === 'postgres' ? '只读事务' : '只读 API'} · 凭证保存在 Keychain`}
                  </span>
                </div>
                <div className="connector-actions">
                  <button
                    className={`connector-toggle ${connector.enabled ? 'is-on' : ''}`}
                    role="switch"
                    aria-checked={connector.enabled}
                    aria-label={`${connector.enabled ? '停用' : '启用'} ${connector.name}`}
                    onClick={() => void toggleConnector(connector)}
                  >
                    <span />
                  </button>
                  <button
                    className="secondary-action-button"
                    onClick={() => void runConnector(connector)}
                    disabled={!connector.enabled || busy}
                  >
                    <RefreshCw size={13} className={busy ? 'spin' : ''} />
                    立即巡检
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      </section>

      {bootstrap.analyticsProfiles.some((profile) => !projectId || profile.projectId === projectId) && (
        <section className="settings-section">
          <div className="settings-section-header">
            <div>
              <span className="settings-kicker">项目分析与 Agent</span>
              <h2>Analytics Profiles</h2>
              <p>漏斗定义、固定聚合指标与项目现有 Agent 的调用方式统一版本化。</p>
            </div>
          </div>
          <div className="connector-list">
            {bootstrap.analyticsProfiles
              .filter((profile) => !projectId || profile.projectId === projectId)
              .map((profile) => (
                <article className="connector-row" key={profile.id}>
                  <span className="connector-kind-icon"><Workflow size={17} /></span>
                  <div className="connector-main">
                    <div className="connector-title-row">
                      <strong>{profile.projectName} · v{profile.version}</strong>
                      <span className="connector-status connector-status-ready">ready</span>
                    </div>
                    <span className="connector-project">{profile.id}</span>
                    <p>{profile.objective}</p>
                    <code>{profile.funnel.join(' → ')}</code>
                    <span className="connector-footnote">{profile.agentLabel} · {profile.approvalBoundary}</span>
                  </div>
                  <div className="connector-actions">
                    <button
                      className="secondary-action-button"
                      disabled={projectAgentBusy === profile.id}
                      onClick={() => void runProjectAgent(profile.id)}
                    >
                      {projectAgentBusy === profile.id ? <LoaderCircle className="spin" size={13} /> : <Play size={13} />}
                      启动项目 Agent
                    </button>
                  </div>
                </article>
              ))}
          </div>
        </section>
      )}

      <section className="settings-section planned-section">
        <div className="settings-section-header">
          <div>
            <span className="settings-kicker">能力目录</span>
            <h2>Connector Catalog</h2>
            <p>这些能力将复用相同的凭证、健康状态、运行记录和证据协议。</p>
          </div>
        </div>
        {postgresFormOpen && projectId && (
          <div className="postgres-setup-panel">
            <div className="postgres-setup-heading">
              <span className="connector-kind-icon"><Database size={17} /></span>
              <div>
                <strong>{selectedProject?.name} PostgreSQL</strong>
                <p>连接信息写入项目配置，密码单独加密保存到 macOS Keychain。</p>
              </div>
              <button className="round-icon-button" onClick={closePostgresForm} aria-label="关闭 PostgreSQL 配置">
                <X size={15} />
              </button>
            </div>
            <label>
              <span>Connection URL</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={postgresConnection}
                onChange={(event) => setPostgresConnection(event.target.value)}
                placeholder="postgresql://user:password@host:5432/database?sslmode=require"
              />
              <small>编辑已有连接时可省略密码，应用会继续使用 Keychain 中的凭证。</small>
            </label>
            <label>
              <span>Analytics Profile</span>
              <SelectMenu
                value={postgresAnalyticsProfile}
                options={[
                  { value: '', label: '通用指标 View' },
                  ...bootstrap.analyticsProfiles
                    .filter((profile) => profile.projectId === projectId)
                    .map((profile) => ({ value: profile.id, label: `${profile.projectName} · v${profile.version}` }))
                ]}
                onChange={(value) => {
                  setPostgresAnalyticsProfile(value)
                  if (value) setPostgresMetricView('')
                }}
                ariaLabel="PostgreSQL Analytics Profile"
              />
              <small>内置 Profile 使用固定的只读聚合 SQL，并且不读取用户级内容。</small>
            </label>
            <label>
              <span>指标 View（可选）</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={postgresMetricView}
                onChange={(event) => setPostgresMetricView(event.target.value)}
                disabled={Boolean(postgresAnalyticsProfile)}
                placeholder="project_agent.metrics"
              />
              <small>只接受 schema.view；View 需提供 metric_key、metric_value、status、summary、observed_at。</small>
            </label>
            {postgresError && <p className="postgres-setup-error">{postgresError}</p>}
            <div className="postgres-setup-actions">
              <button className="quiet-action" onClick={closePostgresForm}>取消</button>
              <button
                className="briefing-button"
                onClick={() => void configurePostgres()}
                disabled={!postgresConnection.trim() || savingPostgres}
              >
                {savingPostgres ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />}
                保存并测试只读连接
              </button>
            </div>
          </div>
        )}
        {connectorFormKind && projectId && (
          <div className="postgres-setup-panel">
            <div className="postgres-setup-heading">
              <span className="connector-kind-icon"><Plug size={17} /></span>
              <div>
                <strong>{bootstrap.connectorCatalog.find((item) => item.kind === connectorFormKind)?.label}</strong>
                <p>非敏感配置写入项目数据库；Token、OAuth 凭证和 API Key 单独加密保存。</p>
              </div>
              <button className="round-icon-button" onClick={() => setConnectorFormKind(null)} aria-label="关闭 Connector 配置"><X size={15} /></button>
            </div>
            {(connectorFormKind === 'cloudflare'
              ? [
                  ['accountId', 'Account ID', '32 位 Cloudflare account ID', 'text'],
                  ['zoneId', 'Zone ID（可选）', '配置后读取 Web Analytics', 'text'],
                  ['apiToken', 'API Token', '编辑时留空可沿用 Keychain 凭证', 'password']
                ]
              : connectorFormKind === 'ga4'
                ? [
                    ['propertyId', 'GA4 Property ID', '纯数字 Property ID', 'text'],
                    ['accessToken', 'OAuth Access Token', '编辑时留空可沿用现有凭证', 'password'],
                    ['refreshToken', 'Refresh Token（可选）', '用于自动续期', 'password'],
                    ['clientId', 'OAuth Client ID（可选）', '与 Refresh Token 一起使用', 'text'],
                    ['clientSecret', 'OAuth Client Secret（可选）', '与 Refresh Token 一起使用', 'password']
                  ]
                : [
                    ['agentName', 'Agent 名称', '例如 Vows Marketing Agent', 'text'],
                    ['baseUrl', 'Base URL', 'https://agent.example.com', 'text'],
                    ['statusPath', 'Status Path', '/status', 'text'],
                    ['apiKey', 'API Key（可选）', '编辑时留空可沿用现有凭证', 'password']
                  ]).map(([key, label, placeholder, type]) => (
              <label key={key}>
                <span>{label}</span>
                <input
                  type={type}
                  autoComplete="off"
                  spellCheck={false}
                  value={connectorFields[key] ?? ''}
                  onChange={(event) => setConnectorFields((current) => ({ ...current, [key]: event.target.value }))}
                  placeholder={placeholder}
                />
              </label>
            ))}
            {connectorSetupError && <p className="postgres-setup-error">{connectorSetupError}</p>}
            <div className="postgres-setup-actions">
              <button className="quiet-action" onClick={() => setConnectorFormKind(null)}>取消</button>
              <button className="briefing-button" onClick={() => void configureConnector()} disabled={savingConnector}>
                {savingConnector ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />}
                保存并测试连接
              </button>
            </div>
          </div>
        )}
        <div className="catalog-grid">
          {catalogConnectors.map((item) => (
            <article key={item.kind}>
              <span className="catalog-icon">
                {item.kind === 'postgres' ? <Database size={16} /> : item.kind === 'project-agent' ? <Workflow size={16} /> : <Plug size={16} />}
              </span>
              <div>
                <strong>{item.label}</strong>
                <p>{item.description}</p>
                <span>{item.capabilities.join(' · ')}</span>
              </div>
              {item.kind === 'postgres' ? (
                <button disabled={!projectId} onClick={openPostgresForm}>
                  {!projectId ? '先选择项目' : selectedPostgres ? '编辑连接' : '配置'}
                </button>
              ) : item.availability === 'built-in' ? (
                <button disabled={!projectId} onClick={() => openConnectorForm(item.kind as Exclude<ConnectorKind, 'repo' | 'postgres'>)}>
                  {!projectId ? '先选择项目' : bootstrap.connectors.some((connector) => connector.projectId === projectId && connector.kind === item.kind) ? '编辑连接' : '配置'}
                </button>
              ) : <button disabled>即将支持</button>}
            </article>
          ))}
        </div>
      </section>
      </>}
    </div>
  )
}

export default function App(): React.JSX.Element {
  const [bootstrap, setBootstrap] = useState<AppBootstrap | null>(null)
  const [navigation, setNavigation] = useState<Navigation>('briefing')
  const [sidebarSelection, setSidebarSelection] = useState<SidebarSelection>('briefing')
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [projectSection, setProjectSection] = useState<ProjectSection>('inbox')
  const [decisionStatus, setDecisionStatus] = useState<DecisionStatus>('inbox')
  const [composerProjectId, setComposerProjectId] = useState<string | null>(null)
  const [composerText, setComposerText] = useState('')
  const [composerAttachments, setComposerAttachments] = useState<WorkAssistantImageAttachment[]>([])
  const [composerAttachmentError, setComposerAttachmentError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth)
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const sidebarResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [settingsSearch, setSettingsSearch] = useState('')
  const [settingsReturnNavigation, setSettingsReturnNavigation] = useState<Exclude<Navigation, 'settings'>>('briefing')
  const [checkingGoalId, setCheckingGoalId] = useState<string | null>(null)
  const startingMilestoneIdsRef = useRef<Set<string>>(new Set())
  const [selectedAgentRunId, setSelectedAgentRunId] = useState<string | null>(null)
  const [creatingAgentRun, setCreatingAgentRun] = useState(false)
  const [agentRunPrefill, setAgentRunPrefill] = useState<{ runId: string; prompt: string; requestId: string } | null>(null)
  const [handlingDecisionId, setHandlingDecisionId] = useState<string | null>(null)
  useAutoDismissMessage(notice, () => setNotice(null))
  useAutoDismissMessage(composerAttachmentError, () => setComposerAttachmentError(null))

  useEffect(() => {
    window.localStorage.setItem(sidebarWidthStorageKey, String(sidebarWidth))
  }, [sidebarWidth])

  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    sidebarResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebarWidth
    }
    setResizingSidebar(true)
  }

  function moveSidebarResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const resize = sidebarResizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    setSidebarWidth(clampSidebarWidth(resize.startWidth + event.clientX - resize.startX))
  }

  function finishSidebarResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (sidebarResizeRef.current?.pointerId !== event.pointerId) return
    sidebarResizeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setResizingSidebar(false)
  }

  useEffect(() => {
    let active = true
    let retryTimer: number | null = null
    let consecutiveFailures = 0
    const refreshFromMain = (): void => {
      void window.projectAgent.getBootstrap()
        .then((nextBootstrap) => {
          if (!active) return
          consecutiveFailures = 0
          setBootstrap(nextBootstrap)
        })
        .catch((error: unknown) => {
          if (!active) return
          consecutiveFailures += 1
          if (consecutiveFailures <= 5) {
            retryTimer = window.setTimeout(refreshFromMain, 400)
            return
          }
          setNotice(error instanceof Error ? error.message : '无法读取应用数据，请重新启动。')
        })
    }
    refreshFromMain()
    const stopBriefings = window.projectAgent.onMorningBriefingReady(refreshFromMain)
    const stopAutomations = window.projectAgent.onAutomationsChanged(refreshFromMain)
    const stopCompanionData = window.projectAgent.onCompanionDataChanged(refreshFromMain)
    return () => {
      active = false
      if (retryTimer !== null) window.clearTimeout(retryTimer)
      stopBriefings()
      stopAutomations()
      stopCompanionData()
    }
  }, [])

  const projectViewId = sidebarSelection.startsWith('project:')
    ? sidebarSelection.slice('project:'.length)
    : null

  const filteredDecisions = useMemo(() => {
    if (!bootstrap || projectSection !== 'inbox') return []
    return bootstrap.decisions.filter(
      (item) =>
        item.status === decisionStatus && (!projectViewId || item.projectId === projectViewId)
    )
  }, [bootstrap, projectViewId, projectSection, decisionStatus])

  const filteredGoals = useMemo(() => {
    if (!bootstrap) return []
    return bootstrap.goals.filter((goal) => !projectViewId || goal.projectId === projectViewId)
  }, [bootstrap, projectViewId])

  async function refresh(): Promise<void> {
    setBootstrap(await window.projectAgent.getBootstrap())
  }

  async function updateStatus(id: string, status: DecisionStatus): Promise<void> {
    const updated = await window.projectAgent.updateDecisionStatus(id, status)
    setBootstrap((current) =>
      current
        ? {
            ...current,
            decisions: current.decisions.map((item) => (item.id === id ? updated : item))
          }
        : current
    )
  }

  async function updateGoalPriority(id: string, priority: GoalPriority): Promise<void> {
    const updated = await window.projectAgent.updateGoalPriority(id, priority)
    setBootstrap((current) => current ? {
      ...current,
      goals: current.goals.map((goal) => goal.id === id ? updated : goal)
    } : current)
  }

  async function completeMilestone(goalId: string, milestoneId: string): Promise<void> {
    try {
      const updated = await window.projectAgent.completeGoalMilestone(goalId, milestoneId)
      setBootstrap((current) => current ? {
        ...current,
        goals: current.goals.map((goal) => goal.id === goalId ? updated : goal)
      } : current)
      setNotice('里程碑已标记完成。')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法标记里程碑完成。')
    }
  }

  async function deleteMilestone(goalId: string, milestoneId: string): Promise<void> {
    try {
      const updated = await window.projectAgent.deleteGoalMilestone(goalId, milestoneId)
      setBootstrap((current) => current ? {
        ...current,
        goals: current.goals.map((goal) => goal.id === goalId ? updated : goal)
      } : current)
      setNotice('里程碑已删除。')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法删除里程碑。')
    }
  }

  async function checkGoal(id: string): Promise<void> {
    if (checkingGoalId) return
    setCheckingGoalId(id)
    setNotice(null)
    try {
      const result = await window.projectAgent.checkGoal(id)
      setNotice(result.message)
      await refresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '目标检查失败。')
    } finally {
      setCheckingGoalId(null)
    }
  }

  async function startMilestoneTask(goal: ProjectGoal, milestone: GoalMilestone): Promise<void> {
    if (startingMilestoneIdsRef.current.has(milestone.id)) return
    const project = bootstrap?.projects.find((item) => item.id === goal.projectId)
    if (!project) {
      setNotice('没有找到这个任务所属的项目。')
      return
    }
    startingMilestoneIdsRef.current.add(milestone.id)
    setNotice(null)
    try {
      const existing = bootstrap?.runs.find((run) =>
        run.projectId === project.id && run.goalId === goal.id && run.milestoneId === milestone.id
        && run.status !== 'completed' && run.status !== 'cancelled'
      )
      const detail = existing
        ? await window.projectAgent.getAgentRun(existing.id)
        : await window.projectAgent.createAgentRunDraft({
            projectId: project.id,
            goalId: goal.id,
            milestoneId: milestone.id,
            title: milestone.title,
            draftPrompt: buildMilestoneDraftPrompt(project, goal, milestone)
          })
      await refresh()
      setNavigation('runs')
      setSidebarSelection('runs')
      setSelectedProject(null)
      setComposerProjectId(null)
      setSelectedAgentRunId(detail.run.id)
      setCreatingAgentRun(false)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Agent Run 创建失败。')
    } finally {
      startingMilestoneIdsRef.current.delete(milestone.id)
    }
  }

  async function handleDecision(item: DecisionItem): Promise<void> {
    if (handlingDecisionId) return
    setHandlingDecisionId(item.id)
    setNotice(null)
    try {
      const existing = bootstrap?.runs.find((run) =>
        run.decisionId === item.id && run.status !== 'completed' && run.status !== 'cancelled'
      )
      const detail = existing
        ? await window.projectAgent.getAgentRun(existing.id)
        : await window.projectAgent.createAgentRunDraft({
            projectId: item.projectId,
            decisionId: item.id,
            provider: bootstrap?.providerSettings.codingAgents.defaultAgent ?? 'codex',
            title: `处理 · ${item.title}`,
            draftPrompt: item.summary
          })
      await updateStatus(item.id, 'in_progress')
      await refresh()
      setNavigation('runs')
      setSidebarSelection('runs')
      setSelectedProject(null)
      setComposerProjectId(null)
      setSelectedAgentRunId(detail.run.id)
      setCreatingAgentRun(false)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Agent Session 创建失败。')
    } finally {
      setHandlingDecisionId(null)
    }
  }

  async function submitComposer(): Promise<void> {
    const prompt = composerText.trim()
    if ((!prompt && composerAttachments.length === 0) || submitting) return
    const submittedPrompt = prompt || '请分析附件并整理需要关注的事项。'

    setSubmitting(true)
    setNotice(null)

    try {
      if (!composerProjectId) {
        setNotice('请先选择这个目标所属的项目。')
        return
      }
      const goal = await window.projectAgent.createGoal({
        projectId: composerProjectId,
        prompt: submittedPrompt,
        attachments: composerAttachments
      })
      setNotice(`目标“${goal.title}”已建立，Agent 会按 Check-in 节奏持续追踪。`)
      setProjectSection('goals')
      setComposerText('')
      setComposerAttachments([])
      setComposerAttachmentError(null)
      await refresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '操作失败，请稍后再试。')
    } finally {
      setSubmitting(false)
    }
  }

  async function addComposerAttachments(files: File[]): Promise<void> {
    const result = await prepareChatImages(files, composerAttachments.length)
    setComposerAttachments((current) => [...current, ...result.attachments].slice(0, maxChatImages))
    setComposerAttachmentError(result.error)
  }

  async function generateMorningBriefing(): Promise<void> {
    setSubmitting(true)
    setNotice(null)
    try {
      const result = await window.projectAgent.generateMorningBriefing()
      setNotice(result.briefing.status === 'completed'
        ? `已生成 ${result.briefing.reportDate} 跨项目简报，新增 ${result.createdSignals.length} 条决策信号。`
        : `简报暂未生成：${result.briefing.error ?? '数据聚合失败'}`)
      await refresh()
    } finally {
      setSubmitting(false)
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
    await refresh()
  }

  async function executeWorkAssistantAction(messageId: string, proposalId: string, optionId: string): Promise<void> {
    try {
      const result = await window.projectAgent.executeWorkAssistantAction({ messageId, proposalId, optionId })
      setNotice(result.notice)
      if (result.navigation?.kind === 'agent-run') {
        setNavigation('runs')
        setSidebarSelection('runs')
        setSelectedProject(null)
        setComposerProjectId(null)
        setCreatingAgentRun(false)
        setSelectedAgentRunId(result.navigation.id)
        setAgentRunPrefill(result.navigation.draftPrompt ? {
          runId: result.navigation.id,
          prompt: result.navigation.draftPrompt,
          requestId: crypto.randomUUID()
        } : null)
      } else if (result.navigation?.kind === 'project') {
        setSelectedProject(result.navigation.id)
        setComposerProjectId(result.navigation.id)
        setSidebarSelection(`project:${result.navigation.id}`)
        setProjectSection('settings')
        setNavigation('inbox')
      }
      await refresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Action 执行失败。')
    }
  }

  if (!bootstrap) {
    return (
      <main className="loading-screen">
        <img className="loading-wordmark" src={fuddyWordmark} alt="Fuddy" />
        <LoaderCircle className="spin" size={20} />
      </main>
    )
  }

  const selectedProjectRecord = bootstrap.projects.find((project) => project.id === projectViewId)
  const inboxCount = bootstrap.decisions.filter((item) => item.status === 'inbox').length
  const filteredSettingsNavigation = settingsNavigationItems.filter((item) =>
    `${item.label} ${item.keywords}`.toLocaleLowerCase().includes(settingsSearch.trim().toLocaleLowerCase())
  )
  return (
    <div
      className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'} ${resizingSidebar ? 'is-resizing-sidebar' : ''}`}
      style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
    >
      <aside className="sidebar">
        <div className="window-drag-region" />
        {navigation === 'settings' ? (
          <>
            <div className="settings-sidebar-header">
              <button
                className="settings-back-button"
                onClick={() => setNavigation(settingsReturnNavigation)}
                aria-label="返回主导航"
              >
                <ArrowLeft size={17} />
                <span>返回应用</span>
              </button>
              <button className="sidebar-icon-button" onClick={() => setSidebarOpen(false)} aria-label="收起侧边栏">
                <PanelLeft size={17} />
              </button>
            </div>
            <div className="settings-sidebar-title">
              <Settings2 size={16} />
              <strong>所有设置</strong>
              <ChevronDown size={14} />
            </div>
            <label className="settings-search-field">
              <Search size={15} />
              <input
                value={settingsSearch}
                onChange={(event) => setSettingsSearch(event.target.value)}
                placeholder="搜索设置…"
              />
              {settingsSearch && (
                <button onClick={() => setSettingsSearch('')} aria-label="清除搜索"><X size={13} /></button>
              )}
            </label>
            <span className="settings-nav-group-label">个人</span>
            <nav className="settings-secondary-nav" aria-label="设置导航">
              {filteredSettingsNavigation.map((item) => {
                const NavigationIcon = item.icon
                return (
                  <button className={settingsSection === item.id ? 'is-active' : ''} onClick={() => setSettingsSection(item.id)} key={item.id}>
                    <NavigationIcon size={16} /> {item.label}
                  </button>
                )
              })}
              {filteredSettingsNavigation.length === 0 && <p className="settings-search-empty">没有匹配的设置</p>}
            </nav>
          </>
        ) : navigation === 'runs' && (selectedAgentRunId || creatingAgentRun) ? (
          <AgentRunsSidebar
            runs={bootstrap.runs}
            projects={bootstrap.projects}
            selectedRunId={selectedAgentRunId}
            onSelectRun={(runId) => {
              setCreatingAgentRun(false)
              setSelectedAgentRunId(runId)
            }}
            onNewRun={() => {
              setSelectedAgentRunId(null)
              setCreatingAgentRun(true)
            }}
            onBack={() => {
              setSelectedAgentRunId(null)
              setCreatingAgentRun(false)
            }}
            onCollapse={() => setSidebarOpen(false)}
          />
        ) : (
        <>
        <div className="brand-row">
          <img className="brand-wordmark" src={fuddyWordmark} alt="Fuddy" />
          <button className="sidebar-icon-button" onClick={() => setSidebarOpen(false)} aria-label="收起侧边栏">
            <PanelLeft size={17} />
          </button>
        </div>

        <nav className="primary-nav" aria-label="主导航">
          <button
            className={sidebarSelection === 'briefing' ? 'is-active' : ''}
            onClick={() => {
              setNavigation('briefing')
              setSidebarSelection('briefing')
              setSelectedProject(null)
              setComposerProjectId(null)
            }}
          >
            <Bot size={17} />
            工作助理
          </button>
          <button
            className={sidebarSelection === 'inbox' ? 'is-active' : ''}
            onClick={() => {
              setNavigation('inbox')
              setSidebarSelection('inbox')
              setSelectedProject(null)
              setComposerProjectId(null)
              setProjectSection('inbox')
              setDecisionStatus('inbox')
            }}
          >
            <Inbox size={17} />
            决策收件箱
            <span className="nav-count">{inboxCount}</span>
          </button>
          <button className={sidebarSelection === 'files' ? 'is-active' : ''} onClick={() => {
            setNavigation('files')
            setSidebarSelection('files')
            setSelectedProject(null)
            setComposerProjectId(null)
          }}>
            <Folder size={17} />
            文件
          </button>
          <button className={sidebarSelection === 'runs' ? 'is-active' : ''} onClick={() => {
            setNavigation('runs')
            setSidebarSelection('runs')
            setSelectedProject(null)
            setComposerProjectId(null)
            setSelectedAgentRunId(null)
            setCreatingAgentRun(false)
          }}>
            <Workflow size={17} />
            Agent Runs
          </button>
          <button className={sidebarSelection === 'automations' ? 'is-active' : ''} onClick={() => {
            setNavigation('automations')
            setSidebarSelection('automations')
            setSelectedProject(null)
            setComposerProjectId(null)
          }}>
            <Clock3 size={17} />
            自动化
          </button>
        </nav>

        <div className="sidebar-section-title">
          <span>项目</span>
        </div>
        <div className="project-nav">
          <button
            className={sidebarSelection === 'all-projects' ? 'is-selected' : ''}
            onClick={() => {
              setSelectedProject(null)
              setComposerProjectId(null)
              setSidebarSelection('all-projects')
              setProjectSection('inbox')
              setDecisionStatus('inbox')
              setNavigation('inbox')
            }}
          >
            <span className="project-dot all-projects-dot" />
            全部项目
          </button>
          {bootstrap.projects.map((project) => (
            <button
              key={project.id}
              className={sidebarSelection === `project:${project.id}` ? 'is-selected' : ''}
              onClick={() => {
                setSelectedProject(project.id)
                setComposerProjectId(project.id)
                setSidebarSelection(`project:${project.id}`)
                setProjectSection('inbox')
                setDecisionStatus('inbox')
                setNavigation('inbox')
              }}
            >
              <span className="project-dot" style={{ background: project.accent }} />
              {project.name}
            </button>
          ))}
        </div>

        <div className="sidebar-footer">
          <button
            className="settings-button"
            onClick={() => {
              setSettingsReturnNavigation(navigation)
              setSettingsSection('general')
              setSettingsSearch('')
              setNavigation('settings')
            }}
          >
            <Settings2 size={16} />
            设置
          </button>
        </div>
        </>
        )}
        <div
          className="sidebar-resize-handle"
          role="separator"
          aria-label="调整侧边栏宽度"
          aria-orientation="vertical"
          aria-valuemin={minimumSidebarWidth}
          aria-valuemax={maximumSidebarWidth}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={startSidebarResize}
          onPointerMove={moveSidebarResize}
          onPointerUp={finishSidebarResize}
          onPointerCancel={finishSidebarResize}
          onLostPointerCapture={() => {
            sidebarResizeRef.current = null
            setResizingSidebar(false)
          }}
          onDoubleClick={() => setSidebarWidth(defaultSidebarWidth)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return
            event.preventDefault()
            setSidebarWidth((current) => event.key === 'Home'
              ? defaultSidebarWidth
              : clampSidebarWidth(current + (event.key === 'ArrowRight' ? 12 : -12)))
          }}
        />
      </aside>

      <main className="content-shell">
        {navigation !== 'runs' && <div className="window-drag-region content-drag-region" />}
        {!sidebarOpen && (
          <button className="floating-sidebar-button" onClick={() => setSidebarOpen(true)} aria-label="展开侧边栏">
            <PanelLeft size={18} />
          </button>
        )}

        <div className={`content-column ${navigation === 'briefing' ? 'is-briefing' : ''} ${navigation === 'files' ? 'is-files' : ''} ${navigation === 'runs' ? 'is-runs' : ''} ${navigation === 'automations' ? 'is-automations' : ''} ${navigation === 'settings' ? 'is-settings' : ''} ${navigation === 'inbox' && projectSection === 'inbox' ? 'is-inbox-list' : ''} ${navigation === 'inbox' && projectSection === 'settings' ? 'is-project-settings' : ''} ${navigation === 'inbox' && projectSection === 'status' ? 'is-project-status' : ''}`}>
          {navigation === 'briefing' ? (
            <header className="briefing-page-header">
              <div>
                <strong>工作助理</strong>
                <small>讨论和推进所有项目 · 每天 09:00 发送简报</small>
              </div>
              <span className="briefing-header-status"><i /> 在线</span>
            </header>
          ) : navigation === 'runs' ? null : (
            <header className="page-header">
              <div>
                <span className="eyebrow">
                  {navigation === 'settings'
                    ? '设置'
                    : selectedProjectRecord?.name ?? '全部项目'}
                </span>
                <h1>
                  {navigation === 'inbox'
                    ? projectSection === 'settings'
                      ? '项目设置'
                      : projectSection === 'status'
                        ? '项目状态'
                      : projectSection === 'goals'
                        ? '目标'
                        : '决策收件箱'
                    : navigation === 'files'
                      ? '文件'
                      : navigation === 'automations'
                        ? '自动化'
                        : settingsSectionMeta[settingsSection].title}
                </h1>
                <p>
                  {navigation === 'inbox'
                    ? projectSection === 'settings'
                      ? '管理项目身份、入口、数据源与 Connector。'
                      : projectSection === 'status'
                        ? '统一维护项目使命、愿景、当前现状和已确认事实。'
                      : projectSection === 'goals'
                        ? '把结果、指标、里程碑和证据放在同一条持续追踪的链路里。'
                        : '项目与 Agent 把真正需要关注的变化投递到这里。'
                    : navigation === 'files'
                      ? '集中保存运营、Marketing、分析与 Agent 生成的项目产物。'
                      : navigation === 'automations'
                        ? '按计划运行 Agent、Connector、目标检查和简报，并保留完整历史。'
                        : settingsSectionMeta[settingsSection].description}
                </p>
              </div>
              <div className="header-actions">
                {navigation !== 'settings' && <button className="round-icon-button" aria-label="搜索"><Search size={17} /></button>}
              </div>
            </header>
          )}

          {navigation === 'briefing' && (
            <WorkAssistantView
              briefings={bootstrap.morningBriefings}
              messages={bootstrap.briefingMessages}
              ttsMode={bootstrap.providerSettings.tts.primary.mode}
              generating={submitting}
              runs={bootstrap.runs}
              onOpenRun={(runId) => {
                setNavigation('runs')
                setSidebarSelection('runs')
                setSelectedProject(null)
                setComposerProjectId(null)
                setSelectedAgentRunId(runId)
                setCreatingAgentRun(false)
              }}
              onExecuteAction={executeWorkAssistantAction}
              onGenerate={generateMorningBriefing}
              onAsk={askMorningBriefing}
            />
          )}

          {navigation === 'inbox' && (
            <>
              <div className="project-primary-toolbar">
                <div className="project-primary-tabs">
                  <button className={projectSection === 'inbox' ? 'is-active' : ''} onClick={() => {
                    setProjectSection('inbox')
                  }}>
                    <Inbox size={14} /> 收件箱
                  </button>
                  {selectedProjectRecord && <button className={projectSection === 'status' ? 'is-active' : ''} onClick={() => setProjectSection('status')}>
                    <CircleCheck size={14} /> 状态
                  </button>}
                  <button className={projectSection === 'goals' ? 'is-active' : ''} onClick={() => {
                    setProjectSection('goals')
                  }}>
                    <Target size={14} /> 目标
                  </button>
                  {selectedProjectRecord && <button className={projectSection === 'settings' ? 'is-active' : ''} onClick={() => setProjectSection('settings')}>
                    <Settings2 size={14} /> 设置
                  </button>}
                </div>
              </div>

              {projectSection === 'inbox' && <div className="inbox-toolbar inbox-status-toolbar">
                <div className="filter-tabs">
                  {(['inbox', 'in_progress', 'waiting', 'resolved', 'ignored'] as DecisionStatus[]).map((status) => (
                    <button key={status} className={decisionStatus === status ? 'is-active' : ''} onClick={() => setDecisionStatus(status)}>
                      {status === 'inbox' ? '待处理' : status === 'in_progress' ? '进行中' : status === 'waiting' ? '等待中' : status === 'resolved' ? '已完成' : '已忽略'}
                    </button>
                  ))}
                </div>
              </div>}

              {projectSection === 'settings' && selectedProjectRecord ? (
                <div className="project-settings-content">
                  <ProjectSettingsView
                    project={selectedProjectRecord}
                    onSaved={refresh}
                    onNotice={setNotice}
                  />
                  <div className="project-connectors-settings">
                    <SettingsView
                      bootstrap={bootstrap}
                      section="connectors"
                      projectId={selectedProjectRecord.id}
                      projectLocked
                      onProjectChange={() => undefined}
                      onRefresh={refresh}
                      onNotice={setNotice}
                    />
                  </div>
                </div>
              ) : projectSection === 'status' && selectedProjectRecord ? (
                <ProjectStatusView
                  project={selectedProjectRecord}
                  onSaved={refresh}
                  onNotice={setNotice}
                />
              ) : projectSection === 'goals' ? (
                <GoalsView
                  goals={filteredGoals}
                  checkingGoalId={checkingGoalId}
                  onCheck={checkGoal}
                  onPriority={updateGoalPriority}
                  onStartTask={startMilestoneTask}
                  onCompleteMilestone={completeMilestone}
                  onDeleteMilestone={deleteMilestone}
                />
              ) : (
                <section className="decision-list">
                  {filteredDecisions.length > 0 ? (
                    filteredDecisions.map((item) => (
                      <DecisionRow
                        key={item.id}
                        item={item}
                        project={bootstrap.projects.find((project) => project.id === item.projectId)}
                        onStatus={updateStatus}
                        onHandle={handleDecision}
                        handling={handlingDecisionId === item.id}
                      />
                    ))
                  ) : (
                    <EmptyState
                      title={decisionStatus === 'inbox' ? '没有待处理事项' : decisionStatus === 'in_progress' ? '没有进行中的事项' : decisionStatus === 'waiting' ? '没有等待中的事项' : decisionStatus === 'resolved' ? '还没有已完成事项' : '没有已忽略事项'}
                      detail={decisionStatus === 'inbox' ? '新的项目变化会继续投递到决策收件箱。' : '事项状态发生变化后会显示在这里。'}
                    />
                  )}
                </section>
              )}
            </>
          )}
          {navigation === 'files' && (
            <WorkspaceFilesView
              projects={bootstrap.projects}
              initialProjectId={selectedProject}
              onNotice={setNotice}
            />
          )}
          {navigation === 'runs' && (
            <AgentRunsView
              runs={bootstrap.runs}
              projects={bootstrap.projects}
              goals={bootstrap.goals}
              selectedRunId={selectedAgentRunId}
              creating={creatingAgentRun}
              prefill={agentRunPrefill}
              onPrefillConsumed={() => setAgentRunPrefill(null)}
              onSelectRun={(runId) => {
                setCreatingAgentRun(false)
                setSelectedAgentRunId(runId)
              }}
              onCreatingChange={(creating) => {
                setCreatingAgentRun(creating)
                if (creating) setSelectedAgentRunId(null)
              }}
              onRefresh={refresh}
              onNotice={setNotice}
            />
          )}
          {navigation === 'automations' && (
            <AutomationsView
              automations={bootstrap.automations}
              runs={bootstrap.automationRuns}
              projects={bootstrap.projects}
              onRefresh={refresh}
              onNotice={setNotice}
            />
          )}
          {navigation === 'settings' && (
            <SettingsView
              bootstrap={bootstrap}
              section={settingsSection}
              projectId={selectedProject}
              onProjectChange={(projectId) => {
                setSelectedProject(projectId)
                if (!projectId && (projectSection === 'status' || projectSection === 'settings')) setProjectSection('inbox')
              }}
              onRefresh={refresh}
              onNotice={setNotice}
            />
          )}
        </div>

        {(navigation === 'settings' || (navigation === 'inbox' && projectSection === 'goals')) && (
          <div className={`composer-area ${navigation === 'settings' ? 'is-settings' : ''}`}>
            {notice && (
              <div className="notice-toast">
                <Sparkles size={15} />
                <span>{notice}</span>
                <button onClick={() => setNotice(null)} aria-label="关闭提示"><X size={14} /></button>
              </div>
            )}
            {navigation !== 'settings' && (
              <ChatComposer
                value={composerText}
                onChange={setComposerText}
                onSubmit={submitComposer}
                placeholder="描述想达成的结果，Agent 会整理目标、指标和里程碑…"
                busy={submitting}
                attachments={composerAttachments}
                attachmentError={composerAttachmentError}
                onAttachmentsSelected={addComposerAttachments}
                onRemoveAttachment={(id) => {
                  setComposerAttachments((current) => current.filter((attachment) => attachment.id !== id))
                  setComposerAttachmentError(null)
                }}
                leftControls={(
                  <>
                    <SelectMenu
                      className="composer-select-menu composer-project-select"
                      value={composerProjectId ?? ''}
                      options={[
                        { value: '', label: '全部项目', icon: <span className="project-dot all-projects-dot" /> },
                        ...bootstrap.projects.map((project) => ({
                          value: project.id,
                          label: project.name,
                          icon: <span className="project-dot" style={{ background: project.accent }} />
                        }))
                      ]}
                      onChange={(value) => {
                        setComposerProjectId(value || null)
                      }}
                      ariaLabel="任务所属项目"
                      position="up"
                    />
                  </>
                )}
              />
            )}
          </div>
        )}
        {notice && navigation !== 'settings' && !(navigation === 'inbox' && projectSection === 'goals') && (
          <div className="notice-toast global-notice-toast">
            <Sparkles size={15} />
            <span>{notice}</span>
            <button onClick={() => setNotice(null)} aria-label="关闭提示"><X size={14} /></button>
          </div>
        )}
      </main>
    </div>
  )
}
