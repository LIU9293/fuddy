import { describe, expect, it, vi } from 'vitest'
import type { AppBootstrap } from '../../../../shared/contracts'
import { AppDataStore } from './app-data-store'

function bootstrap(): AppBootstrap {
  return {
    projects: [], goals: [], decisions: [], decisionRemediations: [], runs: [], connectors: [], connectorRuns: [],
    dailyBriefings: [], morningBriefings: [], briefingMessages: [], automations: [], automationRuns: [],
    providerSettings: {} as AppBootstrap['providerSettings'],
    connectorCatalog: [], analyticsProfiles: [], capabilities: [],
    credentialStorage: {} as AppBootstrap['credentialStorage'], permissionMode: 'full-access'
  }
}

describe('AppDataStore', () => {
  it('notifies only subscribers for changed domains', () => {
    const store = new AppDataStore()
    store.replace(bootstrap())
    const runsChanged = vi.fn()
    const projectsChanged = vi.fn()
    store.subscribeDomain('runs', runsChanged)
    store.subscribeDomain('projects', projectsChanged)

    store.patch({ runs: [{ id: 'run-1' }] as AppBootstrap['runs'] })

    expect(runsChanged).toHaveBeenCalledOnce()
    expect(projectsChanged).not.toHaveBeenCalled()
  })

  it('preserves untouched domain snapshots across a patch', () => {
    const store = new AppDataStore()
    const initial = bootstrap()
    store.replace(initial)
    store.patch({ decisions: [{ id: 'decision-1' }] as AppBootstrap['decisions'] })

    expect(store.getDomain('projects')).toBe(initial.projects)
    expect(store.getDomain('decisions')).not.toBe(initial.decisions)
  })
})
