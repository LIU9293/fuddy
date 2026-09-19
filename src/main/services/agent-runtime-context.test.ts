import { describe, expect, it } from 'vitest'
import { buildAgentInstructions, buildAdditionalWorkspaceContext, buildProjectContext } from './agent-runtime-context'
import { testProject } from '../test-support/project-fixtures'

describe('agent runtime instructions', () => {
  it('keeps runtime paths out of the fixed project context', () => {
    const instructions = buildAgentInstructions({ filesDirectory: '/files/project-files' })

    expect(instructions).toContain('/files/project-files')
    expect(instructions).not.toContain('Workspace Roots')
    expect(instructions).not.toContain('项目主工作目录')
    expect(instructions).not.toContain('/repo')
  })

  it('retains only additional roots for adapters without native directory options', () => {
    expect(buildAdditionalWorkspaceContext({
      workingDirectory: '/repo',
      workspaceRoots: ['/repo', '/other', '/other']
    })).toBe('附加 Workspace：["/other"]')
  })

  it('omits onboarding defaults, obsolete fields and duplicate summaries', () => {
    const project = testProject('arb', 'arb', '/repo')
    project.summary = 'My personal trading bot'
    project.profile.currentState.summary = '从 Fuddy 初始设置添加的项目。'
    project.profile.focusAreas = ['未设置', ' ']
    expect(buildProjectContext(project)).toBe('项目：arb\n项目简介：My personal trading bot')
    project.profile.currentState.summary = project.summary
    expect(buildProjectContext(project)).toBe('项目：arb\n项目简介：My personal trading bot')
  })

  it.each(['user', 'agent', 'connector'] as const)('preserves real state and its %s provenance', source => {
    const project = testProject('arb', 'arb')
    project.profile.currentState = { summary: '交易暂停', facts: ['rebalance 失败'], source, updatedAt: '2026-09-18' }
    const context = buildProjectContext(project)
    expect(context).toContain('交易暂停')
    expect(context).toContain('rebalance 失败')
    expect(context).toContain('2026-09-18')
    if (source === 'user') expect(context).toContain('用户确认')
    else expect(context).not.toContain('用户确认')
  })
})
