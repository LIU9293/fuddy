import { describe, expect, it } from 'vitest'
import { getProjectAnalyticsProfile, listProjectAnalyticsProfileSummaries, listProjectAnalyticsProfiles } from './project-analytics-profiles'

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
})
