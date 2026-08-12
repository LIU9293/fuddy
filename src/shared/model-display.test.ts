import { describe, expect, it } from 'vitest'
import type { ProviderSettings } from './contracts'
import { buildAgentModelLabels, compactModelName, formatAgentModelLabel } from './model-display'

describe('agent model display', () => {
  it('formats the configured model and reasoning effort as a compact label', () => {
    expect(compactModelName('openai/gpt-5.6-sol')).toBe('5.6 Sol')
    expect(formatAgentModelLabel('gpt-5.6-sol', 'high')).toBe('5.6 Sol High')
    expect(formatAgentModelLabel('', '', 'Codex Default')).toBe('Codex Default')
  })

  it('builds labels for the work assistant and every Agent Run provider', () => {
    const settings = {
      agent: {
        primary: { mode: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6', apiKeyConfigured: true },
        backup: { mode: 'openai-compatible', baseUrl: 'https://example.com/v1', model: 'gpt-5.6-sol', apiKeyConfigured: true },
        backupEnabled: true
      },
      codingAgents: {
        defaultAgent: 'codex',
        codex: { defaultModel: 'gpt-5.6-sol', defaultReasoningEffort: 'high' },
        claude: { defaultModel: '', defaultReasoningEffort: '' },
        opencode: { defaultModel: 'openai/gpt-5.6-mini', defaultReasoningEffort: 'low' }
      }
    } as ProviderSettings

    expect(buildAgentModelLabels(settings)).toEqual({
      workAssistant: '5.6 Medium',
      providers: {
        pi: '5.6',
        codex: '5.6 Sol High',
        claude: 'Claude Default',
        opencode: '5.6 Mini Low'
      }
    })
  })
})
