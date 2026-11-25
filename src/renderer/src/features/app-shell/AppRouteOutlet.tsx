import { ArrowLeft, CircleCheck, PanelLeft, Settings2, Target } from 'lucide-react'
import { useMemo, useState, useSyncExternalStore } from 'react'
import type { AppBootstrap, AppBootstrapDataKey } from '../../../../shared/contracts'
import { buildAgentModelLabels } from '../../../../shared/model-display'
import { AgentRunsView } from '../../components/AgentRunsView'
import { AutomationsView } from '../../components/AutomationsView'
import { ChatComposer } from '../../components/ChatComposer'
import { NoticeToast } from '../../components/NoticeToast'
import { ProjectIcon } from '../../components/ProjectIcon'
import { WorkspaceFilesView } from '../../components/WorkspaceFilesView'
import { GoalsView } from '../../views/GoalsView'
import { ProjectsView } from '../../views/ProjectsView'
import { ProjectSettingsView, ProjectStatusView } from '../../views/ProjectViews'
import { ProjectSharingSettingsView } from '../../views/ProjectSharingSettingsView'
import { SharedProjectsView } from '../../views/SharedProjectsView'
import { SettingsView } from '../../views/SettingsView'
import { WorkAssistantView } from '../../views/WorkAssistantView'
import { settingsSectionTitles, useAutoDismissMessage } from '../../views/shared'
import { mutableBootstrapKeys } from './app-bootstrap-state'
import type { AppDataStore } from './app-data-store'
import type { AppNavigationController } from './app-route'
import { useGoalComposer } from './useGoalComposer'
import { useProjectWorkflows } from './useProjectWorkflows'

interface AppRouteOutletProps {
  currentUserId: string | null
  currentUserDisplayName: string | null
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
  useAutoDismissMessage(composer.attachmentError, composer.dismissAttachmentError)

  const selectedProject = bootstrap.projects.find((project) => project.id === nav.selectedProject)
  const filteredGoals = useMemo(() => bootstrap.goals.filter(
    (goal) => !nav.selectedProject || goal.projectId === nav.selectedProject
  ), [bootstrap.goals, nav.selectedProject])
  const pageTitle = pageTitleForNavigation(nav)
  const showingProjectGoals = nav.navigation === 'project' && nav.projectSection === 'goals' && Boolean(selectedProject)

  return (
    <main className="content-shell">
      {nav.navigation === 'settings' && <div className="window-drag-region content-drag-region" />}
      {!props.sidebarOpen && (
        <button className="floating-sidebar-button" onClick={props.onExpandSidebar} aria-label="展开侧边栏">
          <PanelLeft size={18} />
        </button>
      )}

      {nav.navigation !== 'briefing' && nav.navigation !== 'runs' && nav.navigation !== 'settings' && (
        <header className="app-page-header main-area-header">
          <div className="main-area-header-title">
            {nav.navigation === 'project' && selectedProject && (
              <button type="button" className="main-area-header-back" onClick={nav.openProjects} aria-label="返回项目列表">
                <ArrowLeft size={18} />
              </button>
            )}
            {nav.navigation === 'project' && selectedProject && <ProjectIcon project={selectedProject} className="is-page-header" />}
            <div>
              <h1 className="app-page-header-title">{pageTitle}</h1>
              {nav.navigation === 'project' && selectedProject && <span>{selectedProject.name}</span>}
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

        {nav.navigation === 'project' && selectedProject && (
          <>
            <ProjectTabs section={nav.projectSection} onSelect={nav.setProjectSection} />
            {nav.projectSection === 'settings' ? (
              <div className="project-settings-content">
                <ProjectSettingsView
                  project={selectedProject}
                  onSaved={() => props.refreshDomains(['projects'])}
                  onNotice={props.onNotice}
                />
                <ProjectSharingSettingsView project={selectedProject} runs={bootstrap.runs} />
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
            ) : nav.projectSection === 'status' ? (
              <ProjectStatusView
                project={selectedProject}
                onSaved={() => props.refreshDomains(['projects'])}
                onNotice={props.onNotice}
              />
            ) : (
              <GoalsView
                goals={filteredGoals}
                checkingGoalId={workflows.checkingGoalId}
                onCheck={workflows.checkGoal}
                onPriority={workflows.updateGoalPriority}
                onStartTask={workflows.startMilestoneTask}
                onCompleteMilestone={workflows.completeMilestone}
                onDeleteMilestone={workflows.deleteMilestone}
              />
            )}
          </>
        )}

        {nav.navigation === 'projects' && (
          <ProjectsView projects={bootstrap.projects} onOpen={nav.openProject} />
        )}
        {nav.navigation === 'shared-projects' && <SharedProjectsView currentUserId={props.currentUserId} currentUserDisplayName={props.currentUserDisplayName} />}
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
            currentUserId={props.currentUserId}
            currentUserDisplayName={props.currentUserDisplayName}
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

      {(nav.navigation === 'settings' || showingProjectGoals) && (
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
            />
          )}
        </div>
      )}
      {props.notice && nav.navigation !== 'settings' && !showingProjectGoals && (
        <NoticeToast className="notice-toast global-notice-toast" notice={props.notice} onClose={() => props.onNotice(null)} />
      )}
    </main>
  )
}

function pageTitleForNavigation(nav: AppNavigationController): string {
  if (nav.navigation === 'project') {
    if (nav.projectSection === 'settings') return '项目设置'
    if (nav.projectSection === 'status') return '项目状态'
    if (nav.projectSection === 'goals') return '目标'
  }
  if (nav.navigation === 'projects') return '项目'
  if (nav.navigation === 'shared-projects') return '与我共享'
  if (nav.navigation === 'files') return '文件'
  if (nav.navigation === 'automations') return '自动化'
  if (nav.navigation === 'settings') return settingsSectionTitles[nav.settingsSection]
  return ''
}

function contentColumnClassName(nav: AppNavigationController): string {
  const section = nav.navigation === 'project' ? `project-${nav.projectSection}` : nav.navigation
  return `content-column is-${section}`
}

function ProjectTabs(props: {
  section: AppNavigationController['projectSection']
  onSelect: AppNavigationController['setProjectSection']
}): React.JSX.Element {
  return (
    <div className="project-primary-toolbar"><div className="project-primary-tabs">
      <button className={props.section === 'status' ? 'is-active' : ''} onClick={() => props.onSelect('status')}><CircleCheck size={14} /> 状态</button>
      <button className={props.section === 'goals' ? 'is-active' : ''} onClick={() => props.onSelect('goals')}><Target size={14} /> 目标</button>
      <button className={props.section === 'settings' ? 'is-active' : ''} onClick={() => props.onSelect('settings')}><Settings2 size={14} /> 设置</button>
    </div></div>
  )
}
