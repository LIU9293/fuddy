import {
  ArchiveX,
  Bot,
  Clock3,
  Folder,
  Inbox,
  LayoutGrid,
  LoaderCircle,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Settings2,
  ArrowLeft
} from 'lucide-react'
import type { AgentRun, Project } from '../../../../shared/contracts'
import { formatAgentProviderName } from '../../../../shared/model-display'
import fuddyWordmark from '../../assets/fuddy-wordmark.png'
import { ActionMenu } from '../../components/SelectMenu'
import { settingsNavigationItems, type Navigation, type SettingsSection, type SidebarSelection } from '../../views/shared'
import {
  maximumSidebarWidth,
  minimumSidebarWidth,
  type SidebarLayoutController
} from './useSidebarLayout'
import { useAppDataDomain, type AppDataStore } from './app-data-store'

export interface AppSidebarProps {
  navigation: Navigation
  sidebarSelection: SidebarSelection
  settingsSection: SettingsSection
  inboxCount: number
  runs: AgentRun[]
  projects: Project[]
  selectedRunId: string | null
  layout: SidebarLayoutController
  onCloseSettings: () => void
  onSettingsSection: (section: SettingsSection) => void
  onBriefing: () => void
  onInbox: () => void
  onFiles: () => void
  onProjects: () => void
  onAutomations: () => void
  onCreateRun: (projectId?: string | null) => void
  onOpenRun: (runId: string) => void
  onRenameRun: (run: AgentRun) => void
  onArchiveRun: (run: AgentRun) => void
  onOpenSettings: () => void
}

export type AppSidebarDataProps = Omit<AppSidebarProps, 'inboxCount' | 'runs' | 'projects'> & {
  store: AppDataStore
}

export function AppSidebarData(props: AppSidebarDataProps): React.JSX.Element {
  const { store, ...sidebarProps } = props
  const runs = useAppDataDomain(store, 'runs') ?? []
  const projects = useAppDataDomain(store, 'projects') ?? []
  const decisions = useAppDataDomain(store, 'decisions') ?? []
  return (
    <AppSidebar
      {...sidebarProps}
      inboxCount={decisions.filter((item) => item.status === 'inbox').length}
      runs={runs}
      projects={projects}
    />
  )
}

export interface SidebarRunGroup {
  id: string
  title: string
  projectId: string | null
  runs: AgentRun[]
}

export function groupSidebarRuns(runs: AgentRun[], projects: Project[]): SidebarRunGroup[] {
  const knownProjectIds = new Set(projects.map((project) => project.id))
  const groups: SidebarRunGroup[] = projects.flatMap((project) => {
    const projectRuns = runs.filter((run) => run.projectId === project.id)
    return projectRuns.length > 0
      ? [{ id: project.id, title: project.name, projectId: project.id, runs: projectRuns }]
      : []
  })
  const sharedRuns = runs.filter((run) => !run.projectId || !knownProjectIds.has(run.projectId))
  if (sharedRuns.length > 0) groups.push({ id: 'shared', title: '共享任务', projectId: null, runs: sharedRuns })
  return groups
}

export function AppSidebar(props: AppSidebarProps): React.JSX.Element {
  const runGroups = groupSidebarRuns(props.runs, props.projects)
  return (
    <aside className="sidebar">
      <div className="window-drag-region" />
      {props.navigation === 'settings' ? (
        <>
          <div className="settings-sidebar-header">
            <button className="settings-back-button" onClick={props.onCloseSettings} aria-label="返回主导航">
              <ArrowLeft size={17} />
              <span>返回应用</span>
            </button>
            <button className="sidebar-icon-button" onClick={props.layout.collapse} aria-label="收起侧边栏">
              <PanelLeft size={17} />
            </button>
          </div>
          <nav className="settings-secondary-nav" aria-label="设置导航">
            {settingsNavigationItems.map((item) => {
              const NavigationIcon = item.icon
              return (
                <button
                  className={props.settingsSection === item.id ? 'is-active' : ''}
                  onClick={() => props.onSettingsSection(item.id)}
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
            <button className="sidebar-icon-button" onClick={props.layout.collapse} aria-label="收起侧边栏">
              <PanelLeft size={17} />
            </button>
          </div>

          <nav className="primary-nav" aria-label="主导航">
            <NavigationButton active={props.sidebarSelection === 'briefing'} onClick={props.onBriefing} icon={<Bot size={17} />}>
              工作助理
            </NavigationButton>
            <NavigationButton active={props.sidebarSelection === 'inbox'} onClick={props.onInbox} icon={<Inbox size={17} />}>
              决策收件箱
              {props.inboxCount > 0 && <span className="nav-count">{props.inboxCount}</span>}
            </NavigationButton>
            <NavigationButton active={props.sidebarSelection === 'files'} onClick={props.onFiles} icon={<Folder size={17} />}>
              文件
            </NavigationButton>
            <NavigationButton active={props.sidebarSelection === 'projects'} onClick={props.onProjects} icon={<LayoutGrid size={17} />}>
              项目
            </NavigationButton>
            <NavigationButton active={props.sidebarSelection === 'automations'} onClick={props.onAutomations} icon={<Clock3 size={17} />}>
              自动化
            </NavigationButton>
          </nav>

          <section className="sidebar-runs-section" aria-label="项目 Agent Runs">
            <div className="sidebar-projects-heading">项目</div>
            <nav className="sidebar-run-list" aria-label="Agent Run 列表">
              {runGroups.map((group) => (
                <section className="sidebar-run-group" key={group.id} aria-labelledby={`sidebar-run-group-${group.id}`}>
                  <div className="sidebar-run-group-heading">
                    <span id={`sidebar-run-group-${group.id}`}>{group.title}</span>
                    <button
                      type="button"
                      onClick={() => props.onCreateRun(group.projectId)}
                      aria-label={`在${group.title}中新建 Agent Run`}
                    >
                      <Plus size={12} />
                    </button>
                  </div>
                  {group.runs.map((run) => {
                    const active = run.status === 'running' || run.status === 'queued'
                    return (
                      <div
                        className={`sidebar-run-row ${props.selectedRunId === run.id && props.navigation === 'runs' ? 'is-active' : ''}`}
                        key={run.id}
                      >
                        <button type="button" className="sidebar-run-open" onClick={() => props.onOpenRun(run.id)}>
                          <span>
                            <strong>{run.title}</strong>
                            <small>{formatAgentProviderName(run.provider)}</small>
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
                          onSelect={(action) => action === 'rename' ? props.onRenameRun(run) : props.onArchiveRun(run)}
                        />
                      </div>
                    )
                  })}
                </section>
              ))}
              {props.runs.length === 0 && <p>还没有 Agent Run</p>}
            </nav>
          </section>

          <div className="sidebar-footer">
            <button className="settings-button" onClick={props.onOpenSettings}>
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
        aria-valuenow={props.layout.width}
        tabIndex={0}
        onPointerDown={props.layout.startResize}
        onPointerMove={props.layout.moveResize}
        onPointerUp={props.layout.finishResize}
        onPointerCancel={props.layout.finishResize}
        onLostPointerCapture={props.layout.cancelResize}
        onDoubleClick={props.layout.resetWidth}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return
          event.preventDefault()
          props.layout.resizeByKeyboard(event.key)
        }}
      />
    </aside>
  )
}

function NavigationButton(props: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button className={props.active ? 'is-active' : ''} onClick={props.onClick}>
      {props.icon}
      {props.children}
    </button>
  )
}
