import { ArrowLeft, CircleCheck, Inbox, PanelLeft, Settings2, Target } from 'lucide-react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { AppBootstrap, AppBootstrapDataKey, DecisionStatus } from '../../../../shared/contracts'
import { buildAgentModelLabels } from '../../../../shared/model-display'
import { AgentRunsView } from '../../components/AgentRunsView'
import { AutomationsView } from '../../components/AutomationsView'
import { ChatComposer } from '../../components/ChatComposer'
import { NoticeToast } from '../../components/NoticeToast'
import { ProjectIcon } from '../../components/ProjectIcon'
import { SelectMenu } from '../../components/SelectMenu'
import { WorkspaceFilesView } from '../../components/WorkspaceFilesView'
import { DecisionRow, EmptyState, GoalsView } from '../../views/InboxGoalsView'
import { ProjectsView } from '../../views/ProjectsView'
import { ProjectSettingsView, ProjectStatusView } from '../../views/ProjectViews'
import { SettingsView } from '../../views/SettingsView'
import { WorkAssistantView } from '../../views/WorkAssistantView'
import { settingsSectionTitles, useAutoDismissMessage } from '../../views/shared'
import { mutableBootstrapKeys } from './app-bootstrap-state'
import type { AppDataStore } from './app-data-store'
import type { AppNavigationController } from './app-route'
import { useGoalComposer } from './useGoalComposer'
import { useProjectWorkflows } from './useProjectWorkflows'

interface AppRouteOutletProps {
  store: AppDataStore
  setBootstrap: React.Dispatch<React.SetStateAction<AppBootstrap | null>>
  refresh: () => Promise<void>
  refreshDomains: (keys: readonly AppBootstrapDataKey[]) => Promise<void>
  navigation: AppNavigationController
  sidebarOpen: boolean
  onExpandSidebar: () => void
  notice: string | null
  onNotice: (notice: string | null) => void
}

export function AppRouteOutlet(props: AppRouteOutletProps): React.JSX.Element {
  const nav = props.navigation
  const bootstrap = useSyncExternalStore(
    props.store.subscribe,
    props.store.getSnapshot,
    props.store.getSnapshot
  ) as AppBootstrap
  const [decisionStatus, setDecisionStatus] = useState<DecisionStatus>('inbox')
  const [agentRunPrefill, setAgentRunPrefill] = useState<{ runId: string; prompt: string; requestId: string } | null>(null)
  const workflows = useProjectWorkflows({
    bootstrap,
    setBootstrap: props.setBootstrap,
    refreshDomains: props.refreshDomains,
    onNotice: props.onNotice,
    onOpenRun: nav.openRun,
    onOpenProject: nav.openProject,
    onAgentRunPrefill: setAgentRunPrefill
  })
  const composer = useGoalComposer({
    selectedProjectId: nav.selectedProject,
    refreshDomains: props.refreshDomains,
    onCreated: () => nav.setProjectSection('goals'),
    onNotice: props.onNotice
  })
  useEffect(() => {
    if (nav.navigation === 'inbox') setDecisionStatus('inbox')
  }, [nav.navigation, nav.selectedProject])
  useAutoDismissMessage(composer.attachmentError, composer.dismissAttachmentError)

  const selectedProject = bootstrap.projects.find((project) => project.id === nav.selectedProject)
  const filteredDecisions = useMemo(() => nav.projectSection === 'inbox'
    ? bootstrap.decisions.filter(
        (item) => item.status === decisionStatus && (!nav.selectedProject || item.projectId === nav.selectedProject)
      )
    : [], [bootstrap.decisions, decisionStatus, nav.projectSection, nav.selectedProject])
  const filteredGoals = useMemo(() => bootstrap.goals.filter(
    (goal) => !nav.selectedProject || goal.projectId === nav.selectedProject
  ), [bootstrap.goals, nav.selectedProject])
  const pageTitle = pageTitleForNavigation(nav, selectedProject?.name ?? null)

  return (
    <main className="content-shell">
      {nav.navigation !== 'runs' && <div className="window-drag-region content-drag-region" />}
      {!props.sidebarOpen && (
        <button className="floating-sidebar-button" onClick={props.onExpandSidebar} aria-label="展开侧边栏">
          <PanelLeft size={18} />
        </button>
      )}

      {nav.navigation !== 'briefing' && nav.navigation !== 'runs' && nav.navigation !== 'settings' && (
        <header className="app-page-header main-area-header">
          <div className="main-area-header-title">
            {nav.navigation === 'inbox' && selectedProject && (
              <button type="button" className="main-area-header-back" onClick={nav.openProjects} aria-label="返回项目列表">
                <ArrowLeft size={18} />
              </button>
            )}
            {nav.navigation === 'inbox' && selectedProject && <ProjectIcon project={selectedProject} className="is-page-header" />}
            <div>
              <h1 className="app-page-header-title">{pageTitle}</h1>
              {nav.navigation === 'inbox' && selectedProject && <span>{selectedProject.name}</span>}
            </div>
          </div>
        </header>
      )}

      <div className={contentColumnClassName(nav)}>
        {nav.navigation === 'briefing' && (
          <header className="app-page-header briefing-page-header">
            <strong className="app-page-header-title">工作助理</strong>
            <span className="briefing-header-status"><i /> 在线</span>
          </header>
        )}

        {nav.navigation === 'briefing' && (
          <WorkAssistantView
            briefings={bootstrap.morningBriefings}
            messages={bootstrap.briefingMessages}
            ttsMode={bootstrap.providerSettings.tts.primary.mode}
            generating={workflows.briefingGenerating}
            runs={bootstrap.runs}
            onOpenRun={nav.openRun}
            onExecuteAction={workflows.executeWorkAssistantAction}
            onGenerate={workflows.generateMorningBriefing}
            onAsk={workflows.askMorningBriefing}
          />
        )}

        {nav.navigation === 'inbox' && (
          <>
            {selectedProject && <ProjectTabs section={nav.projectSection} onSelect={nav.setProjectSection} />}
            {nav.projectSection === 'inbox' && (
              <DecisionFilters selected={decisionStatus} onSelect={setDecisionStatus} />
            )}
            {nav.projectSection === 'settings' && selectedProject ? (
              <div className="project-settings-content">
                <ProjectSettingsView
                  project={selectedProject}
                  onSaved={() => props.refreshDomains(['projects'])}
                  onNotice={props.onNotice}
                />
                <div className="project-connectors-settings">
                  <SettingsView
                    bootstrap={bootstrap}
                    section="connectors"
                    projectId={selectedProject.id}
                    projectLocked
                    onProjectChange={() => undefined}
                    onRefresh={props.refresh}
                    onNotice={props.onNotice}
                  />
                </div>
              </div>
            ) : nav.projectSection === 'status' && selectedProject ? (
              <ProjectStatusView
                project={selectedProject}
                onSaved={() => props.refreshDomains(['projects'])}
                onNotice={props.onNotice}
              />
            ) : nav.projectSection === 'goals' ? (
              <GoalsView
                goals={filteredGoals}
                checkingGoalId={workflows.checkingGoalId}
                onCheck={workflows.checkGoal}
                onPriority={workflows.updateGoalPriority}
                onStartTask={workflows.startMilestoneTask}
                onCompleteMilestone={workflows.completeMilestone}
                onDeleteMilestone={workflows.deleteMilestone}
              />
            ) : (
              <DecisionList
                decisions={filteredDecisions}
                projects={bootstrap.projects}
                status={decisionStatus}
                handlingDecisionId={workflows.handlingDecisionId}
                onStatus={workflows.updateDecisionStatus}
                onHandle={workflows.handleDecision}
              />
            )}
          </>
        )}

        {nav.navigation === 'projects' && (
          <ProjectsView projects={bootstrap.projects} onOpen={(projectId) => {
            nav.openProject(projectId)
            setDecisionStatus('inbox')
          }} />
        )}
        {nav.navigation === 'files' && (
          <WorkspaceFilesView projects={bootstrap.projects} initialProjectId={nav.selectedProject} onNotice={props.onNotice} />
        )}
        {nav.navigation === 'runs' && (
          <AgentRunsView
            runs={bootstrap.runs}
            projects={bootstrap.projects}
            goals={bootstrap.goals}
            modelLabels={buildAgentModelLabels(bootstrap.providerSettings)}
            codingAgentSettings={bootstrap.providerSettings.codingAgents}
            selectedRunId={nav.selectedAgentRunId}
            creating={nav.creatingAgentRun}
            initialProjectId={nav.creatingAgentRunProjectId}
            prefill={agentRunPrefill}
            onPrefillConsumed={() => setAgentRunPrefill(null)}
            onSelectRun={(runId) => nav.setRunSelection(runId, false)}
            onCreatingChange={(creating) => nav.setRunSelection(null, creating)}
            onRefresh={() => props.refreshDomains(['runs'])}
            onNotice={props.onNotice}
          />
        )}
        {nav.navigation === 'automations' && (
          <AutomationsView
            automations={bootstrap.automations}
            runs={bootstrap.automationRuns}
            projects={bootstrap.projects}
            onRefresh={() => props.refreshDomains(mutableBootstrapKeys)}
            onNotice={props.onNotice}
          />
        )}
        {nav.navigation === 'settings' && (
          <SettingsView
            bootstrap={bootstrap}
            section={nav.settingsSection}
            projectId={nav.selectedProject}
            onProjectChange={nav.setSettingsProject}
            onRefresh={props.refresh}
            onNotice={props.onNotice}
          />
        )}
      </div>

      {(nav.navigation === 'settings' || (nav.navigation === 'inbox' && nav.projectSection === 'goals')) && (
        <div className={`composer-area ${nav.navigation === 'settings' ? 'is-settings' : ''}`}>
          {props.notice && <NoticeToast notice={props.notice} onClose={() => props.onNotice(null)} />}
          {nav.navigation !== 'settings' && (
            <ChatComposer
              value={composer.text}
              onChange={composer.setText}
              onSubmit={composer.submit}
              placeholder="描述想达成的结果，Agent 会整理目标、指标和里程碑…"
              busy={composer.submitting}
              attachments={composer.attachments}
              attachmentError={composer.attachmentError}
              onAttachmentsSelected={composer.addAttachments}
              onRemoveAttachment={composer.removeAttachment}
              leftControls={
                <SelectMenu
                  className="composer-select-menu composer-project-select"
                  value={composer.projectId ?? ''}
                  options={[
                    { value: '', label: '全部项目', icon: <span className="project-dot all-projects-dot" /> },
                    ...composer.projectOptions(bootstrap.projects).map((project) => ({
                      value: project.value,
                      label: project.label,
                      icon: <span className="project-dot" style={{ background: project.accent }} />
                    }))
                  ]}
                  onChange={(value) => composer.setProjectId(value || null)}
                  ariaLabel="任务所属项目"
                  position="up"
                />
              }
            />
          )}
        </div>
      )}
      {props.notice && nav.navigation !== 'settings' && !(nav.navigation === 'inbox' && nav.projectSection === 'goals') && (
        <NoticeToast className="notice-toast global-notice-toast" notice={props.notice} onClose={() => props.onNotice(null)} />
      )}
    </main>
  )
}

function pageTitleForNavigation(nav: AppNavigationController, projectName: string | null): string {
  if (nav.navigation === 'inbox') {
    if (nav.projectSection === 'settings') return '项目设置'
    if (nav.projectSection === 'status') return '项目状态'
    if (nav.projectSection === 'goals') return '目标'
    return projectName ? '项目收件箱' : '收件箱'
  }
  if (nav.navigation === 'projects') return '项目'
  if (nav.navigation === 'files') return '文件'
  if (nav.navigation === 'automations') return '自动化'
  if (nav.navigation === 'settings') return settingsSectionTitles[nav.settingsSection]
  return ''
}

function contentColumnClassName(nav: AppNavigationController): string {
  return `content-column ${nav.navigation === 'briefing' ? 'is-briefing' : ''} ${nav.navigation === 'projects' ? 'is-projects' : ''} ${nav.navigation === 'files' ? 'is-files' : ''} ${nav.navigation === 'runs' ? 'is-runs' : ''} ${nav.navigation === 'automations' ? 'is-automations' : ''} ${nav.navigation === 'settings' ? 'is-settings' : ''} ${nav.navigation === 'inbox' && nav.projectSection === 'inbox' ? 'is-inbox-list' : ''} ${nav.navigation === 'inbox' && nav.projectSection === 'settings' ? 'is-project-settings' : ''} ${nav.navigation === 'inbox' && nav.projectSection === 'status' ? 'is-project-status' : ''}`
}

function ProjectTabs(props: {
  section: AppNavigationController['projectSection']
  onSelect: AppNavigationController['setProjectSection']
}): React.JSX.Element {
  return (
    <div className="project-primary-toolbar"><div className="project-primary-tabs">
      <button className={props.section === 'inbox' ? 'is-active' : ''} onClick={() => props.onSelect('inbox')}><Inbox size={14} /> 收件箱</button>
      <button className={props.section === 'status' ? 'is-active' : ''} onClick={() => props.onSelect('status')}><CircleCheck size={14} /> 状态</button>
      <button className={props.section === 'goals' ? 'is-active' : ''} onClick={() => props.onSelect('goals')}><Target size={14} /> 目标</button>
      <button className={props.section === 'settings' ? 'is-active' : ''} onClick={() => props.onSelect('settings')}><Settings2 size={14} /> 设置</button>
    </div></div>
  )
}

const decisionStatuses: DecisionStatus[] = ['inbox', 'in_progress', 'waiting', 'resolved', 'ignored']
const decisionStatusLabels: Record<DecisionStatus, string> = {
  inbox: '待处理', in_progress: '进行中', waiting: '等待中', resolved: '已完成', ignored: '已忽略'
}

function DecisionFilters(props: { selected: DecisionStatus; onSelect: (status: DecisionStatus) => void }): React.JSX.Element {
  return (
    <div className="inbox-toolbar inbox-status-toolbar"><div className="filter-tabs">
      {decisionStatuses.map((status) => (
        <button key={status} className={props.selected === status ? 'is-active' : ''} onClick={() => props.onSelect(status)}>
          {decisionStatusLabels[status]}
        </button>
      ))}
    </div></div>
  )
}

function DecisionList(props: {
  decisions: AppBootstrap['decisions']
  projects: AppBootstrap['projects']
  status: DecisionStatus
  handlingDecisionId: string | null
  onStatus: (id: string, status: DecisionStatus) => Promise<void>
  onHandle: (item: AppBootstrap['decisions'][number]) => Promise<void>
}): React.JSX.Element {
  return (
    <section className="decision-list">
      {props.decisions.length > 0 ? <>
        {props.status !== 'resolved' && <div className="decision-list-header" aria-hidden="true">
          <span>项目</span><span>类型</span><span>标题</span><span>摘要与证据</span><span>操作</span>
        </div>}
        {props.decisions.map((item) => <DecisionRow
          key={item.id}
          item={item}
          project={props.projects.find((project) => project.id === item.projectId)}
          onStatus={props.onStatus}
          onHandle={props.onHandle}
          handling={props.handlingDecisionId === item.id}
        />)}
      </> : <EmptyState
        title={props.status === 'inbox' ? '没有待处理事项' : props.status === 'in_progress' ? '没有进行中的事项' : props.status === 'waiting' ? '没有等待中的事项' : props.status === 'resolved' ? '还没有已完成事项' : '没有已忽略事项'}
        detail={props.status === 'inbox' ? '新的项目变化会继续投递到决策收件箱。' : '事项状态发生变化后会显示在这里。'}
      />}
    </section>
  )
}
