import type { AgentRunProvider, ProviderSettings } from './contracts'
import { agentProviderLabel, agentRunProviders, isAgentRunProvider, modelSettingsForAgent } from './agent-providers'

export interface AgentModelLabels {
  workAssistant: string
  providers: Record<'pi' | 'codex' | 'claude' | 'opencode', string> & Partial<Record<AgentRunProvider, string>>
}

const providerLabels: AgentModelLabels['providers'] = {
  pi: 'Pi Default',
  codex: 'Codex Default',
  claude: 'Claude Default',
  opencode: 'OpenCode Default'
}

export function formatAgentProviderName(provider: AgentRunProvider): string {
  return agentProviderLabel(provider)
}

export const emptyAgentModelLabels: AgentModelLabels = {
  workAssistant: 'Model Default',
  providers: { ...providerLabels }
}

function titleCaseModelPart(value: string): string {
  const normalized = value.toLowerCase()
  const known: Record<string, string> = {
    gpt: 'GPT',
    sol: 'Sol',
    codex: 'Codex',
    mini: 'Mini',
    nano: 'Nano',
    pro: 'Pro',
    turbo: 'Turbo',
    opus: 'Opus',
    sonnet: 'Sonnet',
    haiku: 'Haiku'
  }
  return known[normalized] ?? (/^\d+(?:\.\d+)?$/.test(value) ? value : `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`)
}

export function compactModelName(model: string): string {
  const leaf = model.trim().split('/').pop() ?? ''
  const withoutOpenAiPrefix = leaf.replace(/^gpt-/i, '')
  return withoutOpenAiPrefix
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(titleCaseModelPart)
    .join(' ')
}

export function formatAgentModelLabel(model: string, reasoningEffort = '', fallback = 'Model Default'): string {
  const modelLabel = compactModelName(model) || fallback
  const effortLabel = reasoningEffort.trim()
    ? reasoningEffort.trim().toLowerCase() === 'xhigh'
      ? 'XHigh'
      : titleCaseModelPart(reasoningEffort.trim())
    : ''
  return [modelLabel, effortLabel].filter(Boolean).join(' ')
}

export function buildAgentModelLabels(settings: ProviderSettings): AgentModelLabels {
  const endpointReady = (endpoint: ProviderSettings['agent']['primary']): boolean => {
    try {
      return endpoint.apiKeyConfigured || ['localhost', '127.0.0.1', '::1'].includes(new URL(endpoint.baseUrl).hostname)
    } catch {
      return endpoint.apiKeyConfigured
    }
  }
  const agentEndpoint = endpointReady(settings.agent.primary)
    ? settings.agent.primary
    : settings.agent.backupEnabled && endpointReady(settings.agent.backup)
      ? settings.agent.backup
      : settings.agent.primary
  const providers = { ...providerLabels }
  const ids = [...agentRunProviders, ...Object.keys(settings.codingAgents.additional ?? {}).filter(isAgentRunProvider)]
  for (const id of ids) {
    const { defaultModel, defaultReasoningEffort } = modelSettingsForAgent(settings.codingAgents, id)
    providers[id] = formatAgentModelLabel(defaultModel, defaultReasoningEffort, providerLabels[id] ?? `${agentProviderLabel(id)} Default`)
  }
  return { workAssistant: formatAgentModelLabel(agentEndpoint.model, 'medium'), providers }
}
