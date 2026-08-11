import { describe, expect, it } from 'vitest'
import type { CredentialVault } from './credential-vault'
import type { AppDatabase } from './database'
import { ProviderSettingsService } from './provider-settings'

function fixture() {
  const values = new Map<string, unknown>()
  const credentials = new Map<string, string>()
  const database = {
    getSetting: <T>(key: string, fallback: T): T => values.has(key) ? values.get(key) as T : fallback,
    setSetting: <T>(key: string, value: T): void => { values.set(key, value) }
  } as unknown as AppDatabase
  const vault = {
    get: (key: string) => credentials.get(key) ?? null,
    set: (key: string, value: string) => { credentials.set(key, value) }
  } as unknown as CredentialVault
  return { settings: new ProviderSettingsService(database, vault), values, credentials }
}

describe('ASR provider settings', () => {
  it('defaults to optional local Whisper with cloud fallback', () => {
    expect(fixture().settings.getPublicSettings().asr).toEqual({
      mode: 'local-first',
      cloudBaseUrl: 'https://api.openai.com/v1',
      cloudModel: 'gpt-transcribe',
      cloudApiKeyConfigured: false,
      fallbackToCloud: true
    })
  })

  it('stores only the non-secret settings in SQLite and keeps the key in the vault', () => {
    const { settings, values, credentials } = fixture()
    const result = settings.configureAsr({
      mode: 'cloud',
      cloudBaseUrl: 'https://api.openai.com/v1/',
      cloudModel: ' whisper-1 ',
      cloudApiKey: ' secret-key ',
      fallbackToCloud: false
    })
    expect(values.get('provider.asr')).toEqual({
      mode: 'cloud',
      cloudBaseUrl: 'https://api.openai.com/v1',
      cloudModel: 'whisper-1',
      fallbackToCloud: false
    })
    expect(credentials.get('provider:asr:cloud:api-key')).toBe('secret-key')
    expect(result.asr.cloudApiKeyConfigured).toBe(true)
    expect(settings.getAsrRuntimeSettings().cloudApiKey).toBe('secret-key')
  })
})
