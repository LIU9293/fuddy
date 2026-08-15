import { useMemo, useReducer } from 'react'
import type { Navigation, ProjectSection, SettingsSection, SidebarSelection } from '../../views/shared'

export type AppMainRoute =
  | { kind: 'briefing' }
  | { kind: 'inbox' }
  | { kind: 'files' }
  | { kind: 'projects' }
  | { kind: 'project'; projectId: string; section: ProjectSection }
  | { kind: 'runs'; runId: string | null; creating: boolean }
  | { kind: 'automations' }

export type AppRoute = AppMainRoute | {
  kind: 'settings'
  section: SettingsSection
  projectId: string | null
  returnTo: AppMainRoute
}

type AppRouteAction =
  | { type: 'open-main'; route: AppMainRoute }
  | { type: 'open-project'; projectId: string; section: ProjectSection }
  | { type: 'set-project-section'; section: ProjectSection }
  | { type: 'open-settings' }
  | { type: 'close-settings' }
  | { type: 'set-settings-section'; section: SettingsSection }
  | { type: 'set-settings-project'; projectId: string | null }

export const initialAppRoute: AppRoute = { kind: 'briefing' }

export function appRouteReducer(route: AppRoute, action: AppRouteAction): AppRoute {
  switch (action.type) {
    case 'open-main':
      return action.route
    case 'open-project':
      return { kind: 'project', projectId: action.projectId, section: action.section }
    case 'set-project-section':
      return route.kind === 'project' ? { ...route, section: action.section } : route
    case 'open-settings':
      return route.kind === 'settings'
        ? route
        : {
            kind: 'settings',
            section: 'general',
            projectId: route.kind === 'project' ? route.projectId : null,
            returnTo: route
          }
    case 'close-settings':
      return route.kind === 'settings' ? route.returnTo : route
    case 'set-settings-section':
      return route.kind === 'settings' ? { ...route, section: action.section } : route
    case 'set-settings-project':
      return route.kind === 'settings' ? { ...route, projectId: action.projectId } : route
  }
}

export function navigationForRoute(route: AppRoute): Navigation {
  return route.kind === 'project' ? 'inbox' : route.kind
}

export function sidebarSelectionForRoute(route: AppRoute): SidebarSelection {
  if (route.kind === 'settings') return sidebarSelectionForRoute(route.returnTo)
  return route.kind === 'project' ? 'projects' : route.kind
}

export function selectedProjectForRoute(route: AppRoute): string | null {
  if (route.kind === 'project') return route.projectId
  if (route.kind === 'settings') return route.projectId
  return null
}

export function projectSectionForRoute(route: AppRoute): ProjectSection {
  return route.kind === 'project' ? route.section : 'inbox'
}

export function selectedRunForRoute(route: AppRoute): string | null {
  return route.kind === 'runs' ? route.runId : null
}

export function creatingRunForRoute(route: AppRoute): boolean {
  return route.kind === 'runs' && route.creating
}

export interface AppNavigationController {
  route: AppRoute
  navigation: Navigation
  sidebarSelection: SidebarSelection
  selectedProject: string | null
  projectSection: ProjectSection
  settingsSection: SettingsSection
  selectedAgentRunId: string | null
  creatingAgentRun: boolean
  openBriefing: () => void
  openInbox: () => void
  openFiles: () => void
  openProjects: () => void
  openAutomations: () => void
  openProject: (projectId: string, section?: ProjectSection) => void
  setProjectSection: (section: ProjectSection) => void
  openRun: (runId: string) => void
  openRuns: () => void
  createRun: () => void
  setRunSelection: (runId: string | null, creating: boolean) => void
  openSettings: () => void
  closeSettings: () => void
  setSettingsSection: (section: SettingsSection) => void
  setSettingsProject: (projectId: string | null) => void
}

export function useAppNavigation(): AppNavigationController {
  const [route, dispatch] = useReducer(appRouteReducer, initialAppRoute)

  return useMemo(() => ({
    route,
    navigation: navigationForRoute(route),
    sidebarSelection: sidebarSelectionForRoute(route),
    selectedProject: selectedProjectForRoute(route),
    projectSection: projectSectionForRoute(route),
    settingsSection: route.kind === 'settings' ? route.section : 'general',
    selectedAgentRunId: selectedRunForRoute(route),
    creatingAgentRun: creatingRunForRoute(route),
    openBriefing: () => dispatch({ type: 'open-main', route: { kind: 'briefing' } }),
    openInbox: () => dispatch({ type: 'open-main', route: { kind: 'inbox' } }),
    openFiles: () => dispatch({ type: 'open-main', route: { kind: 'files' } }),
    openProjects: () => dispatch({ type: 'open-main', route: { kind: 'projects' } }),
    openAutomations: () => dispatch({ type: 'open-main', route: { kind: 'automations' } }),
    openProject: (projectId, section = 'inbox') => dispatch({ type: 'open-project', projectId, section }),
    setProjectSection: (section) => dispatch({ type: 'set-project-section', section }),
    openRun: (runId) => dispatch({ type: 'open-main', route: { kind: 'runs', runId, creating: false } }),
    openRuns: () => dispatch({ type: 'open-main', route: { kind: 'runs', runId: null, creating: false } }),
    createRun: () => dispatch({ type: 'open-main', route: { kind: 'runs', runId: null, creating: true } }),
    setRunSelection: (runId, creating) => dispatch({
      type: 'open-main',
      route: { kind: 'runs', runId: creating ? null : runId, creating }
    }),
    openSettings: () => dispatch({ type: 'open-settings' }),
    closeSettings: () => dispatch({ type: 'close-settings' }),
    setSettingsSection: (section) => dispatch({ type: 'set-settings-section', section }),
    setSettingsProject: (projectId) => dispatch({ type: 'set-settings-project', projectId })
  }), [route])
}
