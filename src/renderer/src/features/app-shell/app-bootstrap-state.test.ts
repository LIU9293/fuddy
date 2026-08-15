import { describe, expect, it } from 'vitest'
import type { AppBootstrap } from '../../../../shared/contracts'
import { applyAppBootstrapPatch, mergeBootstrapKeys, mutableBootstrapKeys } from './app-bootstrap-state'

describe('app bootstrap patches', () => {
  it('replaces only requested domains and preserves stable references elsewhere', () => {
    const projects = [{ id: 'project-1' }] as AppBootstrap['projects']
    const runs = [{ id: 'run-1' }] as AppBootstrap['runs']
    const current = { projects, runs, decisions: [] } as unknown as AppBootstrap
    const nextRuns = [{ id: 'run-2' }] as AppBootstrap['runs']

    const next = applyAppBootstrapPatch(current, { runs: nextRuns })

    expect(next.runs).toBe(nextRuns)
    expect(next.projects).toBe(projects)
    expect(next.decisions).toBe(current.decisions)
  })

  it('coalesces domain keys without duplicates', () => {
    const keys = new Set<'runs' | 'decisions'>()
    mergeBootstrapKeys(keys, ['runs', 'runs'])
    mergeBootstrapKeys(keys, ['decisions'])
    expect([...keys]).toEqual(['runs', 'decisions'])
  })

  it('keeps generic remote refreshes limited to persisted product data', () => {
    expect(mutableBootstrapKeys).toContain('projects')
    expect(mutableBootstrapKeys).toContain('automationRuns')
    expect(mutableBootstrapKeys).not.toContain('providerSettings')
    expect(mutableBootstrapKeys).not.toContain('capabilities')
    expect(mutableBootstrapKeys).not.toContain('credentialStorage')
  })
})
