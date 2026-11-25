import type { CodingAgentModelCatalog, CodingAgentModelSettings, CodingAgentProvider, CodingAgentSettings } from './contracts'

export const builtInAgentProviders = [
  'codex', 'claude', 'cursor', 'grok', 'fx', 'opencode', 'antigravity', 'kiro', 'pi', 'muse'
] as const

export type BuiltInAgentProvider = typeof builtInAgentProviders[number]
export type T3AgentProvider = BuiltInAgentProvider | `acp-${string}`

export interface AgentProviderDefinition {
  id: BuiltInAgentProvider
  label: string
  kind: 'built-in' | 'coding'
}

export const agentProviderDefinitions = {
  pi: { id: 'pi', label: 'Pi', kind: 'coding' },
  codex: { id: 'codex', label: 'Codex', kind: 'coding' },
  claude: { id: 'claude', label: 'Claude Code', kind: 'coding' },
  opencode: { id: 'opencode', label: 'OpenCode', kind: 'coding' },
  cursor: { id: 'cursor', label: 'Cursor', kind: 'coding' },
  grok: { id: 'grok', label: 'Grok Build', kind: 'coding' },
  fx: { id: 'fx', label: 'Fx', kind: 'coding' },
  antigravity: { id: 'antigravity', label: 'Antigravity', kind: 'coding' },
  kiro: { id: 'kiro', label: 'Kiro', kind: 'coding' },
  muse: { id: 'muse', label: 'Muse', kind: 'coding' }
} as const satisfies Record<BuiltInAgentProvider, AgentProviderDefinition>

export const agentRunProviders = builtInAgentProviders
export const codingAgentProviders = ['codex', 'claude', 'opencode'] as const satisfies readonly CodingAgentProvider[]

export function isBuiltInAgentProvider(value: unknown): value is BuiltInAgentProvider {
  return typeof value === 'string' && Object.hasOwn(agentProviderDefinitions, value)
}

export function isAgentRunProvider(value: unknown): value is T3AgentProvider {
  return isBuiltInAgentProvider(value)
    || (typeof value === 'string' && /^acp-[a-zA-Z0-9_-]{1,60}$/u.test(value))
}

export function agentProviderLabel(provider: T3AgentProvider): string {
  return isBuiltInAgentProvider(provider) ? agentProviderDefinitions[provider].label : provider.slice(4)
}

export function agentProviderOptions(catalog?: CodingAgentModelCatalog | null, selected?: T3AgentProvider | null): Array<{ value: T3AgentProvider; label: string }> {
  const ids = new Set<T3AgentProvider>(builtInAgentProviders)
  for (const id of Object.keys(catalog ?? {})) if (isAgentRunProvider(id)) ids.add(id)
  if (selected) ids.add(selected)
  return [...ids].map(value => ({ value, label: catalog?.[value]?.label ?? agentProviderLabel(value) }))
}

export function modelSettingsForAgent(settings: CodingAgentSettings, provider: T3AgentProvider): CodingAgentModelSettings {
  if (provider === 'codex' || provider === 'claude' || provider === 'opencode') return settings[provider]
  return settings.additional?.[provider] ?? { defaultModel: '', defaultReasoningEffort: '' }
}

export function withAgentModelSettings(settings: CodingAgentSettings, provider: T3AgentProvider, model: CodingAgentModelSettings): CodingAgentSettings {
  if (provider === 'codex' || provider === 'claude' || provider === 'opencode') return { ...settings, [provider]: model }
  return { ...settings, additional: { ...settings.additional, [provider]: model } }
}
