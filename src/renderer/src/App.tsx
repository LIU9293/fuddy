import {
  ArchiveX,
  ArrowDown,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Copy,
  Clock3,
  Database,
  Folder,
  GitBranch,
  Inbox,
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
import { AgentRunsView } from './components/AgentRunsView'
import { ConversationMessageActions } from './components/ConversationMessageActions'
import { isProjectImageIcon, ProjectIcon } from './components/ProjectIcon'
import { ActionMenu, SelectMenu, SuggestionInput } from './components/SelectMenu'
import { WorkspaceFilesView } from './components/WorkspaceFilesView'
import { AutomationsView } from './components/AutomationsView'
import { normalizeChatMarkdown } from './markdown'
import { maxChatImages, prepareChatImages } from './chat-attachments'
import { workAssistantRunIds } from './work-assistant-links'
import { chatIsAtLatest } from './chat-scroll'
import { microphoneAccessError } from './voice-input'
import fuddyWordmark from './assets/fuddy-wordmark.png'
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
  CodingAgentSettings,
  ConnectorKind,
  ConnectorRun,
  BriefingMessage,
  DecisionItem,
  DecisionStatus,
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
import { buildAgentModelLabels } from '../../shared/model-display'
import { useAppBootstrap } from './features/app-shell/useAppBootstrap'
import { buildMilestoneDraftPrompt, DecisionRow, EmptyState, GoalsView } from './views/InboxGoalsView'
import { ProjectSettingsView, ProjectStatusView } from './views/ProjectViews'
import { WorkAssistantView } from './views/WorkAssistantView'
import { SettingsView } from './views/SettingsView'
import { ProjectsView } from './views/ProjectsView'
import {
  settingsNavigationItems,
  settingsSectionTitles,
  useAutoDismissMessage,
  type Navigation,
  type ProjectSection,
  type SettingsSection,
  type SidebarSelection
} from './views/shared'

const defaultSidebarWidth = 258
const minimumSidebarWidth = 220
const maximumSidebarWidth = 420
const sidebarWidthStorageKey = 'project-agent.sidebar-width'
function clampSidebarWidth(value: number): number {
  return Math.round(Math.min(maximumSidebarWidth, Math.max(minimumSidebarWidth, value)))
}

function initialSidebarWidth(): number {
  const stored = Number.parseFloat(window.localStorage.getItem(sidebarWidthStorageKey) ?? '')
  return Number.isFinite(stored) ? clampSidebarWidth(stored) : defaultSidebarWidth
}

export default function App(): React.JSX.Element {
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
  const [settingsReturnNavigation, setSettingsReturnNavigation] = useState<Exclude<Navigation, 'settings'>>('briefing')
  const [checkingGoalId, setCheckingGoalId] = useState<string | null>(null)
  const startingMilestoneIdsRef = useRef<Set<string>>(new Set())
  const [selectedAgentRunId, setSelectedAgentRunId] = useState<string | null>(null)
  const [creatingAgentRun, setCreatingAgentRun] = useState(false)
  const [sidebarRunRenameTarget, setSidebarRunRenameTarget] = useState<AgentRun | null>(null)
  const [sidebarRunRenameTitle, setSidebarRunRenameTitle] = useState('')
  const [sidebarRunActionBusy, setSidebarRunActionBusy] = useState(false)
  const [agentRunPrefill, setAgentRunPrefill] = useState<{ runId: string; prompt: string; requestId: string } | null>(
    null
  )
  const [handlingDecisionId, setHandlingDecisionId] = useState<string | null>(null)
  const { bootstrap, setBootstrap, refresh } = useAppBootstrap({
    onError: setNotice,
    onOpenAgentRun: (runId) => {
      setNavigation('runs')
      setSidebarSelection('runs')
      setSelectedProject(null)
      setComposerProjectId(null)
      setCreatingAgentRun(false)
      setSelectedAgentRunId(runId)
    }
  })
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

  const projectViewId = selectedProject

  const filteredDecisions = useMemo(() => {
    if (!bootstrap || projectSection !== 'inbox') return []
    return bootstrap.decisions.filter(
      (item) => item.status === decisionStatus && (!projectViewId || item.projectId === projectViewId)
    )
  }, [bootstrap, projectViewId, projectSection, decisionStatus])

  const filteredGoals = useMemo(() => {
    if (!bootstrap) return []
    return bootstrap.goals.filter((goal) => !projectViewId || goal.projectId === projectViewId)
  }, [bootstrap, projectViewId])

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
    setBootstrap((current) =>
      current
        ? {
            ...current,
            goals: current.goals.map((goal) => (goal.id === id ? updated : goal))
          }
        : current
    )
  }

  async function completeMilestone(goalId: string, milestoneId: string): Promise<void> {
    try {
      const updated = await window.projectAgent.completeGoalMilestone(goalId, milestoneId)
      setBootstrap((current) =>
        current
          ? {
              ...current,
              goals: current.goals.map((goal) => (goal.id === goalId ? updated : goal))
            }
          : current
      )
      setNotice('里程碑已标记完成。')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法标记里程碑完成。')
    }
  }

  async function deleteMilestone(goalId: string, milestoneId: string): Promise<void> {
    try {
      const updated = await window.projectAgent.deleteGoalMilestone(goalId, milestoneId)
      setBootstrap((current) =>
        current
          ? {
              ...current,
              goals: current.goals.map((goal) => (goal.id === goalId ? updated : goal))
            }
          : current
      )
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
      const existing = bootstrap?.runs.find(
        (run) =>
          run.projectId === project.id &&
          run.goalId === goal.id &&
          run.milestoneId === milestone.id &&
          run.status !== 'completed' &&
          run.status !== 'cancelled'
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
      const existing = bootstrap?.runs.find(
        (run) => run.decisionId === item.id && run.status !== 'completed' && run.status !== 'cancelled'
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
      setNotice(
        result.briefing.status === 'completed'
          ? `已生成 ${result.briefing.reportDate} 跨项目简报，新增 ${result.createdSignals.length} 条决策信号。`
          : `简报暂未生成：${result.briefing.error ?? '数据聚合失败'}`
      )
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
    await window.projectAgent.askMorningBriefing(
      {
        requestId: crypto.randomUUID(),
        briefingId,
        question,
        attachments,
        taskContext
      },
      onUpdate
    )
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
        setAgentRunPrefill(
          result.navigation.draftPrompt
            ? {
                runId: result.navigation.id,
                prompt: result.navigation.draftPrompt,
                requestId: crypto.randomUUID()
              }
            : null
        )
      } else if (result.navigation?.kind === 'project') {
        setSelectedProject(result.navigation.id)
        setComposerProjectId(result.navigation.id)
        setSidebarSelection('projects')
        setProjectSection('settings')
        setNavigation('inbox')
      }
      await refresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Action 执行失败。')
    }
  }

  async function renameSidebarRun(): Promise<void> {
    if (!sidebarRunRenameTarget || !sidebarRunRenameTitle.trim() || sidebarRunActionBusy) return
    setSidebarRunActionBusy(true)
    try {
      await window.projectAgent.renameAgentRun(sidebarRunRenameTarget.id, sidebarRunRenameTitle.trim())
      setSidebarRunRenameTarget(null)
      setSidebarRunRenameTitle('')
      await refresh()
      setNotice('Session 已重命名。')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Session 重命名失败。')
    } finally {
      setSidebarRunActionBusy(false)
    }
  }

  async function archiveSidebarRun(run: AgentRun): Promise<void> {
    if (sidebarRunActionBusy || run.status === 'running' || run.status === 'queued') return
    setSidebarRunActionBusy(true)
    try {
      await window.projectAgent.archiveAgentRun(run.id)
      if (selectedAgentRunId === run.id) {
        setSelectedAgentRunId(null)
        setCreatingAgentRun(false)
      }
      await refresh()
      setNotice('Session 已归档。')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Session 归档失败。')
    } finally {
      setSidebarRunActionBusy(false)
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
  const pageTitle =
    navigation === 'inbox'
      ? projectSection === 'settings'
        ? '项目设置'
        : projectSection === 'status'
          ? '项目状态'
          : projectSection === 'goals'
            ? '目标'
            : selectedProjectRecord
              ? '项目收件箱'
              : '收件箱'
      : navigation === 'projects'
        ? '项目'
        : navigation === 'files'
          ? '文件'
          : navigation === 'automations'
            ? '自动化'
            : navigation === 'settings'
              ? settingsSectionTitles[settingsSection]
              : ''
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
            <nav className="settings-secondary-nav" aria-label="设置导航">
              {settingsNavigationItems.map((item) => {
                const NavigationIcon = item.icon
                return (
                  <button
                    className={settingsSection === item.id ? 'is-active' : ''}
                    onClick={() => setSettingsSection(item.id)}
                    key={item.id}
                  >
                    <NavigationIcon size={16} /> {item.label}
                  </button>
                )
              })}
            </nav>
          </>
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
                {inboxCount > 0 && <span className="nav-count">{inboxCount}</span>}
              </button>
              <button
                className={sidebarSelection === 'files' ? 'is-active' : ''}
                onClick={() => {
                  setNavigation('files')
                  setSidebarSelection('files')
                  setSelectedProject(null)
                  setComposerProjectId(null)
                }}
              >
                <Folder size={17} />
                文件
              </button>
              <button
                className={sidebarSelection === 'projects' ? 'is-active' : ''}
                onClick={() => {
                  setNavigation('projects')
                  setSidebarSelection('projects')
                  setSelectedProject(null)
                  setComposerProjectId(null)
                  setSelectedAgentRunId(null)
                  setCreatingAgentRun(false)
                }}
              >
                <LayoutGrid size={17} />
                项目
              </button>
              <button
                className={sidebarSelection === 'automations' ? 'is-active' : ''}
                onClick={() => {
                  setNavigation('automations')
                  setSidebarSelection('automations')
                  setSelectedProject(null)
                  setComposerProjectId(null)
                }}
              >
                <Clock3 size={17} />
                自动化
              </button>
            </nav>

            <section className="sidebar-runs-section" aria-label="Agent Runs">
              <div className="sidebar-runs-heading">
                <span>Agent Runs</span>
                <small>{bootstrap.runs.length}</small>
                <button
                  type="button"
                  onClick={() => {
                    setNavigation('runs')
                    setSidebarSelection('runs')
                    setSelectedProject(null)
                    setComposerProjectId(null)
                    setSelectedAgentRunId(null)
                    setCreatingAgentRun(true)
                  }}
                  aria-label="新建 Agent Run"
                >
                  <Plus size={14} />
                </button>
              </div>
              <nav className="sidebar-run-list" aria-label="Agent Run 列表">
                {bootstrap.runs.map((run) => {
                  const project = bootstrap.projects.find((item) => item.id === run.projectId)
                  const active = run.status === 'running' || run.status === 'queued'
                  return (
                    <div
                      className={`sidebar-run-row ${selectedAgentRunId === run.id && navigation === 'runs' ? 'is-active' : ''}`}
                      key={run.id}
                    >
                      <button
                        type="button"
                        className="sidebar-run-open"
                        onClick={() => {
                          setNavigation('runs')
                          setSidebarSelection('runs')
                          setSelectedProject(null)
                          setComposerProjectId(null)
                          setCreatingAgentRun(false)
                          setSelectedAgentRunId(run.id)
                        }}
                      >
                        <span>
                          <strong>{run.title}</strong>
                          <small>
                            {project?.name ?? '共享'} · {run.provider}
                          </small>
                        </span>
                        {active && <LoaderCircle size={14} className="spin" />}
                      </button>
                      <ActionMenu
                        className="sidebar-run-actions"
                        ariaLabel={`${run.title} 操作`}
                        trigger={<MoreHorizontal size={14} />}
                        options={[
                          { value: 'rename', label: '重命名', icon: <Pencil size={13} /> },
                          ...(!active
                            ? [{ value: 'archive' as const, label: '归档', icon: <ArchiveX size={13} />, danger: true }]
                            : [])
                        ]}
                        onSelect={(action) => {
                          if (action === 'rename') {
                            setSidebarRunRenameTarget(run)
                            setSidebarRunRenameTitle(run.title)
                          } else {
                            void archiveSidebarRun(run)
                          }
                        }}
                      />
                    </div>
                  )
                })}
                {bootstrap.runs.length === 0 && <p>还没有 Agent Run</p>}
              </nav>
            </section>

            <div className="sidebar-footer">
              <button
                className="settings-button"
                onClick={() => {
                  setSettingsReturnNavigation(navigation)
                  setSettingsSection('general')
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
            setSidebarWidth((current) =>
              event.key === 'Home'
                ? defaultSidebarWidth
                : clampSidebarWidth(current + (event.key === 'ArrowRight' ? 12 : -12))
            )
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

        {navigation !== 'briefing' && navigation !== 'runs' && navigation !== 'settings' && (
          <header className="app-page-header main-area-header">
            <div className="main-area-header-title">
              {navigation === 'inbox' && selectedProjectRecord && (
                <button
                  type="button"
                  className="main-area-header-back"
                  onClick={() => {
                    setNavigation('projects')
                    setSidebarSelection('projects')
                    setSelectedProject(null)
                    setComposerProjectId(null)
                  }}
                  aria-label="返回项目列表"
                >
                  <ArrowLeft size={18} />
                </button>
              )}
              {navigation === 'inbox' && selectedProjectRecord && (
                <ProjectIcon project={selectedProjectRecord} className="is-page-header" />
              )}
              <div>
                <h1 className="app-page-header-title">{pageTitle}</h1>
                {navigation === 'inbox' && selectedProjectRecord && <span>{selectedProjectRecord.name}</span>}
              </div>
            </div>
          </header>
        )}

        <div
          className={`content-column ${navigation === 'briefing' ? 'is-briefing' : ''} ${navigation === 'projects' ? 'is-projects' : ''} ${navigation === 'files' ? 'is-files' : ''} ${navigation === 'runs' ? 'is-runs' : ''} ${navigation === 'automations' ? 'is-automations' : ''} ${navigation === 'settings' ? 'is-settings' : ''} ${navigation === 'inbox' && projectSection === 'inbox' ? 'is-inbox-list' : ''} ${navigation === 'inbox' && projectSection === 'settings' ? 'is-project-settings' : ''} ${navigation === 'inbox' && projectSection === 'status' ? 'is-project-status' : ''}`}
        >
          {navigation === 'briefing' ? (
            <header className="app-page-header briefing-page-header">
              <strong className="app-page-header-title">工作助理</strong>
              <span className="briefing-header-status">
                <i /> 在线
              </span>
            </header>
          ) : null}

          {navigation === 'briefing' && (
            <WorkAssistantView
              briefings={bootstrap.morningBriefings}
              messages={bootstrap.briefingMessages}
              modelLabel={buildAgentModelLabels(bootstrap.providerSettings).workAssistant}
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
              {selectedProjectRecord && (
                <div className="project-primary-toolbar">
                  <div className="project-primary-tabs">
                    <button
                      className={projectSection === 'inbox' ? 'is-active' : ''}
                      onClick={() => {
                        setProjectSection('inbox')
                      }}
                    >
                      <Inbox size={14} /> 收件箱
                    </button>
                    {selectedProjectRecord && (
                      <button
                        className={projectSection === 'status' ? 'is-active' : ''}
                        onClick={() => setProjectSection('status')}
                      >
                        <CircleCheck size={14} /> 状态
                      </button>
                    )}
                    <button
                      className={projectSection === 'goals' ? 'is-active' : ''}
                      onClick={() => {
                        setProjectSection('goals')
                      }}
                    >
                      <Target size={14} /> 目标
                    </button>
                    {selectedProjectRecord && (
                      <button
                        className={projectSection === 'settings' ? 'is-active' : ''}
                        onClick={() => setProjectSection('settings')}
                      >
                        <Settings2 size={14} /> 设置
                      </button>
                    )}
                  </div>
                </div>
              )}

              {projectSection === 'inbox' && (
                <div className="inbox-toolbar inbox-status-toolbar">
                  <div className="filter-tabs">
                    {(['inbox', 'in_progress', 'waiting', 'resolved', 'ignored'] as DecisionStatus[]).map((status) => (
                      <button
                        key={status}
                        className={decisionStatus === status ? 'is-active' : ''}
                        onClick={() => setDecisionStatus(status)}
                      >
                        {status === 'inbox'
                          ? '待处理'
                          : status === 'in_progress'
                            ? '进行中'
                            : status === 'waiting'
                              ? '等待中'
                              : status === 'resolved'
                                ? '已完成'
                                : '已忽略'}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {projectSection === 'settings' && selectedProjectRecord ? (
                <div className="project-settings-content">
                  <ProjectSettingsView project={selectedProjectRecord} onSaved={refresh} onNotice={setNotice} />
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
                <ProjectStatusView project={selectedProjectRecord} onSaved={refresh} onNotice={setNotice} />
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
                    <>
                      {decisionStatus !== 'resolved' && (
                        <div className="decision-list-header" aria-hidden="true">
                          <span>项目</span>
                          <span>类型</span>
                          <span>标题</span>
                          <span>摘要与证据</span>
                          <span>操作</span>
                        </div>
                      )}
                      {filteredDecisions.map((item) => (
                        <DecisionRow
                          key={item.id}
                          item={item}
                          project={bootstrap.projects.find((project) => project.id === item.projectId)}
                          onStatus={updateStatus}
                          onHandle={handleDecision}
                          handling={handlingDecisionId === item.id}
                        />
                      ))}
                    </>
                  ) : (
                    <EmptyState
                      title={
                        decisionStatus === 'inbox'
                          ? '没有待处理事项'
                          : decisionStatus === 'in_progress'
                            ? '没有进行中的事项'
                            : decisionStatus === 'waiting'
                              ? '没有等待中的事项'
                              : decisionStatus === 'resolved'
                                ? '还没有已完成事项'
                                : '没有已忽略事项'
                      }
                      detail={
                        decisionStatus === 'inbox'
                          ? '新的项目变化会继续投递到决策收件箱。'
                          : '事项状态发生变化后会显示在这里。'
                      }
                    />
                  )}
                </section>
              )}
            </>
          )}
          {navigation === 'projects' && (
            <ProjectsView
              projects={bootstrap.projects}
              onOpen={(projectId) => {
                setSelectedProject(projectId)
                setComposerProjectId(projectId)
                setSidebarSelection('projects')
                setProjectSection('inbox')
                setDecisionStatus('inbox')
                setNavigation('inbox')
              }}
            />
          )}
          {navigation === 'files' && (
            <WorkspaceFilesView projects={bootstrap.projects} initialProjectId={selectedProject} onNotice={setNotice} />
          )}
          {navigation === 'runs' && (
            <AgentRunsView
              runs={bootstrap.runs}
              projects={bootstrap.projects}
              goals={bootstrap.goals}
              modelLabels={buildAgentModelLabels(bootstrap.providerSettings)}
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
                if (!projectId && (projectSection === 'status' || projectSection === 'settings'))
                  setProjectSection('inbox')
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
                <button onClick={() => setNotice(null)} aria-label="关闭提示">
                  <X size={14} />
                </button>
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
                leftControls={
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
                }
              />
            )}
          </div>
        )}
        {notice && navigation !== 'settings' && !(navigation === 'inbox' && projectSection === 'goals') && (
          <div className="notice-toast global-notice-toast">
            <Sparkles size={15} />
            <span>{notice}</span>
            <button onClick={() => setNotice(null)} aria-label="关闭提示">
              <X size={14} />
            </button>
          </div>
        )}
      </main>
      {sidebarRunRenameTarget && (
        <div
          className="agent-session-rename-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target && !sidebarRunActionBusy) setSidebarRunRenameTarget(null)
          }}
        >
          <form
            className="agent-session-rename-dialog"
            onSubmit={(event) => {
              event.preventDefault()
              void renameSidebarRun()
            }}
          >
            <strong>重命名 Session</strong>
            <input
              autoFocus
              value={sidebarRunRenameTitle}
              maxLength={200}
              onChange={(event) => setSidebarRunRenameTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !sidebarRunActionBusy) setSidebarRunRenameTarget(null)
              }}
              aria-label="Session 新标题"
            />
            <div>
              <button type="button" disabled={sidebarRunActionBusy} onClick={() => setSidebarRunRenameTarget(null)}>
                取消
              </button>
              <button type="submit" disabled={!sidebarRunRenameTitle.trim() || sidebarRunActionBusy}>
                保存
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
