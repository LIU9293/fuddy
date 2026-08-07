import { describe, expect, it } from 'vitest'
import type { CredentialVault } from './credential-vault'
import type { AppDatabase } from './database'
import { ProviderSettingsService } from './provider-settings'

function createSettings(): ProviderSettingsService {
  const values = new Map<string, unknown>()
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
      codex: { defaultModel: '' },
      claude: { defaultModel: '' },
      opencode: { defaultModel: '' }
    })
    expect(settings.getCodingAgentDefaultModel('codex')).toBeNull()
  })

  it('trims and persists a default model per coding agent', () => {
    const settings = createSettings()
    const saved = settings.configureCodingAgents({
      codex: { defaultModel: '  gpt-codex-test  ' },
      claude: { defaultModel: 'claude-test' },
      opencode: { defaultModel: ' provider/model-test ' }
    })

    expect(saved.codingAgents).toEqual({
      codex: { defaultModel: 'gpt-codex-test' },
      claude: { defaultModel: 'claude-test' },
      opencode: { defaultModel: 'provider/model-test' }
    })
    expect(settings.getCodingAgentDefaultModel('opencode')).toBe('provider/model-test')
  })
})
