import { describe, expect, it } from 'vitest'
import {
  appRouteReducer,
  creatingRunForRoute,
  initialAppRoute,
  navigationForRoute,
  projectSectionForRoute,
  selectedProjectForRoute,
  selectedRunForRoute,
  sidebarSelectionForRoute
} from './app-route'

describe('app route state machine', () => {
  it('derives project navigation from one route value', () => {
    const route = appRouteReducer(initialAppRoute, {
      type: 'open-project',
      projectId: 'project-1',
      section: 'goals'
    })

    expect(navigationForRoute(route)).toBe('inbox')
    expect(sidebarSelectionForRoute(route)).toBe('projects')
    expect(selectedProjectForRoute(route)).toBe('project-1')
    expect(projectSectionForRoute(route)).toBe('goals')
  })

  it('returns from settings to the exact prior route', () => {
    const runRoute = { kind: 'runs', runId: 'run-1', creating: false } as const
    const settings = appRouteReducer(runRoute, { type: 'open-settings' })
    const restored = appRouteReducer(settings, { type: 'close-settings' })

    expect(restored).toEqual(runRoute)
    expect(selectedRunForRoute(restored)).toBe('run-1')
    expect(creatingRunForRoute(restored)).toBe(false)
  })

  it('keeps project context while opening global settings', () => {
    const projectRoute = appRouteReducer(initialAppRoute, {
      type: 'open-project', projectId: 'project-1', section: 'status'
    })
    const settings = appRouteReducer(projectRoute, { type: 'open-settings' })

    expect(selectedProjectForRoute(settings)).toBe('project-1')
    expect(appRouteReducer(settings, { type: 'close-settings' })).toEqual(projectRoute)
  })

  it('keeps run creation and selection mutually exclusive', () => {
    const creating = appRouteReducer(initialAppRoute, {
      type: 'open-main',
      route: { kind: 'runs', runId: null, creating: true }
    })

    expect(selectedRunForRoute(creating)).toBeNull()
    expect(creatingRunForRoute(creating)).toBe(true)
  })
})
