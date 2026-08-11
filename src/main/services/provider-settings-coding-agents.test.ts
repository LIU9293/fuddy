import { describe, expect, it } from 'vitest'
import type { CredentialVault } from './credential-vault'
import type { AppDatabase } from './database'
import { ProviderSettingsService } from './provider-settings'

function createSettings(storedCodingAgents?: unknown): ProviderSettingsService {
  const values = new Map<string, unknown>()
  if (storedCodingAgents !== undefined) values.set('provider.coding-agents', storedCodingAgents)
  const database = {
    getSetting: <T>(key: string, fallback: T): T => (values.has(key) ? values.get(key) as T : fallback),
    setSetting: <T>(key: string, value: T): void => { values.set(key, value) }
  } as unknown as AppDatabase
  const vault = { get: () => null } as unknown as CredentialVault
  return new ProviderSettingsService(database, vault)
}

describe('coding agent provider settings', () => {
  it('uses each CLI default until an app-level model is configured', () => {
    const settings = createSettings()

    expect(settings.getPublicSettings().codingAgents).toEqual({
      defaultAgent: 'codex',
      codex: { defaultModel: '', defaultReasoningEffort: '' },
      claude: { defaultModel: '', defaultReasoningEffort: '' },
      opencode: { defaultModel: '', defaultReasoningEffort: '' }
    })
    expect(settings.getCodingAgentDefaultModel('codex')).toBeNull()
    expect(settings.getCodingAgentDefaultReasoningEffort('codex')).toBeNull()
  })

  it('trims and persists a default model per coding agent', () => {
    const settings = createSettings()
    const saved = settings.configureCodingAgents({
      defaultAgent: 'claude',
      codex: { defaultModel: '  gpt-codex-test  ', defaultReasoningEffort: ' high ' },
      claude: { defaultModel: 'claude-test', defaultReasoningEffort: ' max ' },
      opencode: { defaultModel: ' provider/model-test ', defaultReasoningEffort: ' medium ' }
    })

    expect(saved.codingAgents).toEqual({
      defaultAgent: 'claude',
      codex: { defaultModel: 'gpt-codex-test', defaultReasoningEffort: 'high' },
      claude: { defaultModel: 'claude-test', defaultReasoningEffort: 'max' },
      opencode: { defaultModel: 'provider/model-test', defaultReasoningEffort: 'medium' }
    })
    expect(settings.getCodingAgentDefaultModel('opencode')).toBe('provider/model-test')
    expect(settings.getCodingAgentDefaultReasoningEffort('opencode')).toBe('medium')
  })

  it('migrates existing model-only settings with an empty reasoning effort', () => {
    const settings = createSettings({
      defaultAgent: 'opencode',
      codex: { defaultModel: 'gpt-codex-test' },
      claude: { defaultModel: 'claude-test' },
      opencode: { defaultModel: 'provider/model-test' }
    })

    expect(settings.getPublicSettings().codingAgents).toEqual({
      defaultAgent: 'opencode',
      codex: { defaultModel: 'gpt-codex-test', defaultReasoningEffort: '' },
      claude: { defaultModel: 'claude-test', defaultReasoningEffort: '' },
      opencode: { defaultModel: 'provider/model-test', defaultReasoningEffort: '' }
    })
  })
})
