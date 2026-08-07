import type {
  AgentProviderMode,
  ConfigureAgentEndpointInput,
  ConfigureAgentProviderInput,
  ConfigureCodingAgentSettingsInput,
  ConfigureTtsEndpointInput,
  ConfigureTtsProviderInput,
  ProviderSettings,
  TtsProviderMode
} from '../../shared/contracts'
import { CredentialVault } from './credential-vault'
import { AppDatabase } from './database'

const AGENT_KEY = 'provider.agent'
const CODING_AGENTS_KEY = 'provider.coding-agents'
const TTS_KEY = 'provider.tts'
const AGENT_PRIMARY_CREDENTIAL = 'provider:agent:api-key'
const AGENT_BACKUP_CREDENTIAL = 'provider:agent:backup:api-key'
const TTS_PRIMARY_CREDENTIAL = 'provider:tts:api-key'
const TTS_BACKUP_CREDENTIAL = 'provider:tts:backup:api-key'

interface StoredAgentEndpoint {
  mode: AgentProviderMode
  baseUrl: string
  model: string
}

interface StoredAgentProvider {
  primary: StoredAgentEndpoint
  backup: StoredAgentEndpoint
  backupEnabled: boolean
}

interface StoredTtsEndpoint {
  mode: TtsProviderMode
  baseUrl: string
  model: string
  voice: string
  instructions: string
}

interface StoredTtsProvider {
  primary: StoredTtsEndpoint
  backup: StoredTtsEndpoint
  backupEnabled: boolean
}

export type RuntimeAgentEndpoint = StoredAgentEndpoint & { apiKey: string | null }
export type RuntimeTtsEndpoint = StoredTtsEndpoint & { apiKey: string | null }

export interface RuntimeAgentSettings {
  primary: RuntimeAgentEndpoint
  backup: RuntimeAgentEndpoint
  backupEnabled: boolean
}

export interface RuntimeTtsSettings {
  primary: RuntimeTtsEndpoint
  backup: RuntimeTtsEndpoint
  backupEnabled: boolean
}

const voiceInstructions = '使用自然、沉稳、清晰的普通话，像一位可信赖的个人助理做晨间汇报。语速适中，数字读得清楚，不要夸张。'

const defaultAgentPrimary: StoredAgentEndpoint = {
  mode: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.6'
}

const defaultAgentBackup: StoredAgentEndpoint = {
  mode: 'openai-compatible',
  baseUrl: 'https://ai.coinsummer.com/v1',
  model: 'gpt-5.6-sol'
}

const defaultTtsPrimary: StoredTtsEndpoint = {
  mode: 'system',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini-tts',
  voice: 'marin',
  instructions: voiceInstructions
}

const defaultTtsBackup: StoredTtsEndpoint = {
  mode: 'elevenlabs',
  baseUrl: 'https://api.elevenlabs.io/v1',
  model: 'eleven_multilingual_v2',
  voice: '',
  instructions: voiceInstructions
}

const defaultAgent: StoredAgentProvider = {
  primary: defaultAgentPrimary,
  backup: defaultAgentBackup,
  backupEnabled: false
}

const defaultCodingAgents: ConfigureCodingAgentSettingsInput = {
  codex: { defaultModel: '' },
  claude: { defaultModel: '' },
  opencode: { defaultModel: '' }
}

const defaultTts: StoredTtsProvider = {
  primary: defaultTtsPrimary,
  backup: defaultTtsBackup,
  backupEnabled: false
}

function normalizeBaseUrl(value: string): string {
  const raw = value.trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Provider Base URL 格式无效。')
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('远程 Provider 必须使用 HTTPS；本地地址可以使用 HTTP。')
  }
  if (url.search || url.hash) throw new Error('Provider Base URL 不能包含 query 或 hash。')
  return raw
}

function required(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} 不能为空。`)
  return normalized
}

function isCcSwitchBaseUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname) && url.port === '15721'
  } catch {
    return false
  }
}

function migrateAgentEndpoint(
  endpoint: { mode?: unknown; baseUrl?: unknown; model?: unknown },
  fallback: StoredAgentEndpoint
): StoredAgentEndpoint {
  const baseUrl = typeof endpoint.baseUrl === 'string' ? endpoint.baseUrl : fallback.baseUrl
  const mode: AgentProviderMode = endpoint.mode === 'cc-switch-codex-oauth' ||
    (endpoint.mode === 'openai-compatible' && !isCcSwitchBaseUrl(baseUrl))
    ? endpoint.mode
    : isCcSwitchBaseUrl(baseUrl)
      ? 'cc-switch-codex-oauth'
      : fallback.mode
  return {
    mode,
    baseUrl,
    model: typeof endpoint.model === 'string' ? endpoint.model : fallback.model
  }
}

function migrateAgent(raw: unknown): StoredAgentProvider {
  if (!raw || typeof raw !== 'object') return defaultAgent
  const value = raw as Partial<StoredAgentProvider> & {
    mode?: unknown
    baseUrl?: unknown
    model?: unknown
  }
  if (value.primary && value.backup) {
    return {
      primary: migrateAgentEndpoint(value.primary, defaultAgentPrimary),
      backup: migrateAgentEndpoint(value.backup, defaultAgentBackup),
      backupEnabled: Boolean(value.backupEnabled)
    }
  }
  if (value.mode === 'openai-compatible') {
    return {
      primary: migrateAgentEndpoint(value, defaultAgentPrimary),
      backup: defaultAgentBackup,
      backupEnabled: false
    }
  }
  return defaultAgent
}

function migrateTts(raw: unknown): StoredTtsProvider {
  if (!raw || typeof raw !== 'object') return defaultTts
  const value = raw as Partial<StoredTtsProvider> & Partial<StoredTtsEndpoint>
  if (value.primary && value.backup) {
    return {
      primary: { ...defaultTtsPrimary, ...value.primary },
      backup: { ...defaultTtsBackup, ...value.backup },
      backupEnabled: Boolean(value.backupEnabled)
    }
  }
  if (value.mode === 'system' || value.mode === 'openai-compatible' || value.mode === 'elevenlabs') {
    return {
      primary: {
        mode: value.mode,
        baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : defaultTtsPrimary.baseUrl,
        model: typeof value.model === 'string' ? value.model : defaultTtsPrimary.model,
        voice: typeof value.voice === 'string' ? value.voice : defaultTtsPrimary.voice,
        instructions: typeof value.instructions === 'string' ? value.instructions : voiceInstructions
      },
      backup: defaultTtsBackup,
      backupEnabled: false
    }
  }
  return defaultTts
}

function normalizeAgentEndpoint(input: ConfigureAgentEndpointInput, label: string): StoredAgentEndpoint {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  if (input.mode === 'cc-switch-codex-oauth' && !isCcSwitchBaseUrl(baseUrl)) {
    throw new Error(`${label} CC Switch 必须使用本机 15721 端口。`)
  }
  return {
    mode: input.mode,
    baseUrl,
    model: required(input.model, `${label} Model`)
  }
}

function normalizeTtsEndpoint(input: ConfigureTtsEndpointInput, label: string, active: boolean): StoredTtsEndpoint {
  const cloud = input.mode !== 'system'
  return {
    mode: input.mode,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    model: cloud && active ? required(input.model, `${label} TTS Model`) : input.model.trim(),
    voice: cloud && active ? required(input.voice, `${label} TTS Voice`) : input.voice.trim(),
    instructions: input.instructions.trim() || voiceInstructions
  }
}

export class ProviderSettingsService {
  constructor(
    private readonly database: AppDatabase,
    private readonly vault: CredentialVault
  ) {}

  private readAgent(): StoredAgentProvider {
    return migrateAgent(this.database.getSetting<unknown>(AGENT_KEY, defaultAgent))
  }

  private readTts(): StoredTtsProvider {
    return migrateTts(this.database.getSetting<unknown>(TTS_KEY, defaultTts))
  }

  private readCodingAgents(): ConfigureCodingAgentSettingsInput {
    const stored = this.database.getSetting<unknown>(CODING_AGENTS_KEY, defaultCodingAgents)
    if (!stored || typeof stored !== 'object') return defaultCodingAgents
    const value = stored as Partial<Record<keyof ConfigureCodingAgentSettingsInput, { defaultModel?: unknown }>>
    return {
      codex: { defaultModel: typeof value.codex?.defaultModel === 'string' ? value.codex.defaultModel : '' },
      claude: { defaultModel: typeof value.claude?.defaultModel === 'string' ? value.claude.defaultModel : '' },
      opencode: { defaultModel: typeof value.opencode?.defaultModel === 'string' ? value.opencode.defaultModel : '' }
    }
  }

  getPublicSettings(): ProviderSettings {
    const agent = this.readAgent()
    const tts = this.readTts()
    return {
      agent: {
        primary: { ...agent.primary, apiKeyConfigured: Boolean(this.vault.get(AGENT_PRIMARY_CREDENTIAL)) },
        backup: { ...agent.backup, apiKeyConfigured: Boolean(this.vault.get(AGENT_BACKUP_CREDENTIAL)) },
        backupEnabled: agent.backupEnabled
      },
      codingAgents: this.readCodingAgents(),
      tts: {
        primary: { ...tts.primary, apiKeyConfigured: Boolean(this.vault.get(TTS_PRIMARY_CREDENTIAL)) },
        backup: { ...tts.backup, apiKeyConfigured: Boolean(this.vault.get(TTS_BACKUP_CREDENTIAL)) },
        backupEnabled: tts.backupEnabled
      }
    }
  }

  configureCodingAgents(input: ConfigureCodingAgentSettingsInput): ProviderSettings {
    this.database.setSetting<ConfigureCodingAgentSettingsInput>(CODING_AGENTS_KEY, {
      codex: { defaultModel: input.codex.defaultModel.trim() },
      claude: { defaultModel: input.claude.defaultModel.trim() },
      opencode: { defaultModel: input.opencode.defaultModel.trim() }
    })
    return this.getPublicSettings()
  }

  getCodingAgentDefaultModel(provider: keyof ConfigureCodingAgentSettingsInput): string | null {
    return this.readCodingAgents()[provider].defaultModel.trim() || null
  }

  configureAgent(input: ConfigureAgentProviderInput): ProviderSettings {
    this.database.setSetting<StoredAgentProvider>(AGENT_KEY, {
      primary: normalizeAgentEndpoint(input.primary, 'Primary'),
      backup: normalizeAgentEndpoint(input.backup, 'Backup'),
      backupEnabled: input.backupEnabled
    })
    if (input.primary.apiKey?.trim()) this.vault.set(AGENT_PRIMARY_CREDENTIAL, input.primary.apiKey.trim())
    if (input.backup.apiKey?.trim()) this.vault.set(AGENT_BACKUP_CREDENTIAL, input.backup.apiKey.trim())
    return this.getPublicSettings()
  }

  configureTts(input: ConfigureTtsProviderInput): ProviderSettings {
    this.database.setSetting<StoredTtsProvider>(TTS_KEY, {
      primary: normalizeTtsEndpoint(input.primary, 'Primary', true),
      backup: normalizeTtsEndpoint(input.backup, 'Backup', input.backupEnabled),
      backupEnabled: input.backupEnabled
    })
    if (input.primary.apiKey?.trim()) this.vault.set(TTS_PRIMARY_CREDENTIAL, input.primary.apiKey.trim())
    if (input.backup.apiKey?.trim()) this.vault.set(TTS_BACKUP_CREDENTIAL, input.backup.apiKey.trim())
    return this.getPublicSettings()
  }

  getAgentRuntimeSettings(): RuntimeAgentSettings {
    const stored = this.readAgent()
    return {
      primary: { ...stored.primary, apiKey: this.vault.get(AGENT_PRIMARY_CREDENTIAL) },
      backup: { ...stored.backup, apiKey: this.vault.get(AGENT_BACKUP_CREDENTIAL) },
      backupEnabled: stored.backupEnabled
    }
  }

  getTtsRuntimeSettings(): RuntimeTtsSettings {
    const stored = this.readTts()
    return {
      primary: { ...stored.primary, apiKey: this.vault.get(TTS_PRIMARY_CREDENTIAL) },
      backup: { ...stored.backup, apiKey: this.vault.get(TTS_BACKUP_CREDENTIAL) },
      backupEnabled: stored.backupEnabled
    }
  }

  getTtsCacheKey(): string {
    const settings = this.readTts()
    return JSON.stringify(settings)
  }
}
