import type { AgentRunProvider, CodingAgentProvider } from './contracts'

export interface AgentProviderDefinition {
  id: AgentRunProvider
  label: string
  kind: 'built-in' | 'coding'
}

export const agentProviderDefinitions = {
  pi: { id: 'pi', label: 'Pi', kind: 'built-in' },
  codex: { id: 'codex', label: 'Codex', kind: 'coding' },
  claude: { id: 'claude', label: 'Claude Code', kind: 'coding' },
  opencode: { id: 'opencode', label: 'OpenCode', kind: 'coding' }
} as const satisfies Record<AgentRunProvider, AgentProviderDefinition>

export const agentRunProviders = Object.keys(agentProviderDefinitions) as AgentRunProvider[]
export const codingAgentProviders = ['codex', 'claude', 'opencode'] as const satisfies readonly CodingAgentProvider[]
