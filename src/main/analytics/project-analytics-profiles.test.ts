import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { getProjectAnalyticsProfile, listProjectAnalyticsProfileSummaries, listProjectAnalyticsProfiles } from './project-analytics-profiles'
import { loadProjectAnalyticsProfiles } from './project-analytics-profiles'
import { registerBundledProjectAnalyticsProfiles } from '../project-extensions/bundled-project-analytics'

beforeAll(() => registerBundledProjectAnalyticsProfiles())

describe('project analytics profiles', () => {
  it('defines unique versioned profiles for Vows and AI Marketing', () => {
    const profiles = listProjectAnalyticsProfiles()
    expect(profiles.map((profile) => profile.id)).toEqual(['vows-growth-v1', 'ai-marketing-production-v1'])
    expect(new Set(profiles.map((profile) => profile.id)).size).toBe(profiles.length)
    expect(profiles.every((profile) => profile.metrics.length >= 8)).toBe(true)
    expect(profiles.every((profile) => profile.requiredConnectors.includes('postgres'))).toBe(true)
  })

  it('reuses each project existing agent shape and exposes safe summaries', () => {
    expect(getProjectAnalyticsProfile('vows')?.agentIntegration).toEqual(expect.objectContaining({
      kind: 'repo-skill', skillPath: '.agents/skills/wedding-promotion/SKILL.md', workspacePath: 'marketing/'
    }))
    expect(getProjectAnalyticsProfile('ai-marketing')?.agentIntegration).toEqual(expect.objectContaining({
      kind: 'http-super-agent', threadPath: '/api/super-agent/threads', chatPath: '/api/super-agent/chat'
    }))
    expect(listProjectAnalyticsProfileSummaries().map((profile) => profile.agentKind))
      .toEqual(['repo-skill', 'http-super-agent'])
  })

  it('loads a declarative profile without changing shared contracts or IPC', () => {
    const directory = mkdtempSync(join(tmpdir(), 'project-capabilities-'))
    writeFileSync(join(directory, 'custom.json'), JSON.stringify({
      id: 'custom-growth-v1', version: 1, projectId: 'custom', projectName: 'Custom', timezone: 'Asia/Shanghai',
      objective: '验证自定义增长闭环。', funnel: ['访问', '激活'],
      metrics: [{ key: 'activations', label: '激活', funnelStage: '激活', source: 'metrics.activations', unit: 'count' }],
      requiredConnectors: ['postgres'], recommendedConnectors: [], decisionRules: ['只使用聚合数据。'],
      agentIntegration: {
        kind: 'http-super-agent', threadPath: '/threads', chatPath: '/chat', workspace: 'global',
        approvalBoundary: '外部动作前需要批准。'
      }
    }))
    expect(loadProjectAnalyticsProfiles(directory)).toBe(1)
    expect(getProjectAnalyticsProfile('custom')?.id).toBe('custom-growth-v1')
  })
})
