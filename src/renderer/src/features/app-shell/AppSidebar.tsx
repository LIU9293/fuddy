import {
  ArchiveX,
  ChevronRight,
  CircleDashed,
  Clock3,
  Folder,
  LayoutGrid,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  SquarePen,
  Settings2,
  ArrowLeft
} from 'lucide-react'
import { useState } from 'react'
import type { AgentRun, Project } from '../../../../shared/contracts'
import { formatAgentProviderName } from '../../../../shared/model-display'
import fuddyWordmark from '../../assets/fuddy-wordmark.png'
import { ProjectIcon } from '../../components/ProjectIcon'
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
  runs: AgentRun[]
  projects: Project[]
  selectedRunId: string | null
  layout: SidebarLayoutController
  onCloseSettings: () => void
  onSettingsSection: (section: SettingsSection) => void
  onFiles: () => void
  onProjects: () => void
  onSharedProjects: () => void
  onAutomations: () => void
  onCreateRun: (projectId?: string | null) => void
  onOpenRun: (runId: string) => void
  onRenameRun: (run: AgentRun) => void
  onArchiveRun: (run: AgentRun) => void
  onOpenSettings: () => void
}

export type AppSidebarDataProps = Omit<AppSidebarProps, 'runs' | 'projects'> & {
  store: AppDataStore
}

export function AppSidebarData(props: AppSidebarDataProps): React.JSX.Element {
  const { store, ...sidebarProps } = props
  const runs = useAppDataDomain(store, 'runs') ?? []
  const projects = useAppDataDomain(store, 'projects') ?? []
  return (
    <AppSidebar
      {...sidebarProps}
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
  const groups: SidebarRunGroup[] = projects.map((project) => ({
    id: project.id,
    title: project.name,
    projectId: project.id,
    runs: runs.filter((run) => run.projectId === project.id)
  }))
  const sharedRuns = runs.filter((run) => !run.projectId || !knownProjectIds.has(run.projectId))
  if (sharedRuns.length > 0) groups.push({ id: 'shared', title: '共享任务', projectId: null, runs: sharedRuns })
  return groups
}

export function AppSidebar(props: AppSidebarProps): React.JSX.Element {
  const runGroups = groupSidebarRuns(props.runs, props.projects)
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set())

  function toggleGroup(id: string): void {
    setCollapsedGroups(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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
            <NavigationButton active={props.sidebarSelection === 'files'} onClick={props.onFiles} icon={<Folder size={17} />}>
              文件
            </NavigationButton>
            <NavigationButton active={props.sidebarSelection === 'projects'} onClick={props.onProjects} icon={<LayoutGrid size={17} />}>
              项目
            </NavigationButton>
            <NavigationButton active={props.sidebarSelection === 'shared-projects'}
              onClick={props.onSharedProjects} icon={<LayoutGrid size={17} />}>与我共享</NavigationButton>
            <NavigationButton active={props.sidebarSelection === 'automations'} onClick={props.onAutomations} icon={<Clock3 size={17} />}>
              自动化
            </NavigationButton>
          </nav>

          <section className="sidebar-runs-section" aria-label="项目 Chats">
            <div className="sidebar-projects-heading">项目</div>
            <nav className="sidebar-run-list" aria-label="Chat 列表">
              {runGroups.map((group) => {
                const expanded = !collapsedGroups.has(group.id)
                return (
                  <section className="sidebar-run-group" key={group.id} aria-labelledby={`sidebar-run-group-${group.id}`}>
                    <div className="sidebar-run-group-heading">
                      <button
                        type="button"
                        className="sidebar-run-group-toggle"
                        aria-labelledby={`sidebar-run-group-${group.id}`}
                        aria-controls={`sidebar-group-chats-${group.id}`}
                        aria-expanded={expanded}
                        onClick={() => toggleGroup(group.id)}
                      >
                        <SidebarProjectIcon project={props.projects.find((project) => project.id === group.projectId)} />
                        <span className="sidebar-run-group-title" id={`sidebar-run-group-${group.id}`}>{group.title}</span>
                        <small className="sidebar-run-group-count">
                          {!expanded && group.runs.length > 0 ? group.runs.length : null}
                        </small>
                        <ChevronRight className="sidebar-run-group-chevron" size={12} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="sidebar-run-group-create"
                        onClick={() => props.onCreateRun(group.projectId)}
                        aria-label={`在${group.title}中新建 Chat`}
                        title={`在${group.title}中新建 Chat`}
                      >
                        <SquarePen size={14} aria-hidden="true" />
                      </button>
                    </div>
                    <div id={`sidebar-group-chats-${group.id}`} hidden={!expanded}>
                      {expanded && group.runs.map((run) => {
                        const active = run.status === 'running' || run.status === 'queued'
                        return (
                          <div
                            className={`sidebar-run-row ${props.selectedRunId === run.id && props.navigation === 'runs' ? 'is-active' : ''}`}
                            key={run.id}
                          >
                            <button type="button" className="sidebar-run-open" title={`${run.title} · ${formatAgentProviderName(run.provider)}`} onClick={() => props.onOpenRun(run.id)}>
                              <span>
                                <strong>{run.title}</strong>
                                {run.executionHost && <small>{run.executionHost.name}{run.executionHost.online ? '' : ' · 离线'}</small>}
                              </span>
                            </button>
                            <div className="sidebar-run-trailing">
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
                              {active && (
                                <span className="sidebar-run-indicator" role="img" aria-label={run.status === 'queued' ? '排队中' : '正在运行'}>
                                  <CircleDashed size={14} aria-hidden="true" />
                                </span>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </section>
                )
              })}
              {runGroups.length === 0 && <p>添加项目后即可新建 Chat</p>}
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

function SidebarProjectIcon({ project }: { project?: Project }): React.JSX.Element {
  return (
    <span className="sidebar-project-icon" aria-hidden="true">
      {project?.icon?.trim()
        ? <ProjectIcon project={project} className="is-sidebar" />
        : <Folder size={17} />}
    </span>
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
