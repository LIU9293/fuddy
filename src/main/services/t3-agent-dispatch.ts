import type { AgentRunProvider } from '../../shared/contracts'
import { agentRunProviders, isAgentRunProvider } from '../../shared/agent-providers'
import { AgentProviderRegistry, codingAgentContinuationContext, sharedCapabilities, type AgentProviderAdapter } from './agent-provider-registry'
import type { CliAgentRuntime } from './cli-agent-runtime'
import type { ProviderSettingsService } from './provider-settings'
import { T3AgentRuntime } from './t3-agent-runtime'
import type { T3RuntimeProcess } from './t3-runtime-process'
import type { ThirdPartyMcpRuntime } from './third-party-mcp-runtime'

export function t3EngineBindingKey(provider: AgentRunProvider, runId: string): string {
  return provider === 'codex' ? `agent.engine.${runId}` : `agent.engine.${provider}.${runId}`
}

export function createT3AgentRegistry(dependencies: {
  process: Pick<T3RuntimeProcess, 'request' | 'watch'>
  tools: Pick<ThirdPartyMcpRuntime, 'getLaunchConfigs'>
  settings: Pick<ProviderSettingsService, 'getCodingAgentDefaultModel' | 'getCodingAgentDefaultReasoningEffort'>
  codexMigration: Pick<CliAgentRuntime, 'adoptCodexSession'>
  mcpScript: string
  databasePath: string
  bind: (key: string) => void
}): AgentProviderRegistry {
  const create = (provider: AgentRunProvider): AgentProviderAdapter => {
    const runtime = new T3AgentRuntime(dependencies.process, provider)
    return {
      provider,
      capabilities: sharedCapabilities,
      recoverSteer: (threadId, requestId, startedAt) => runtime.recoverSteer(threadId, requestId, startedAt),
      async runTurn(input) {
        if (!input.workingDirectory) throw new Error('这个 Chat 缺少工作目录。')
        const base = { ...input, provider, workingDirectory: input.workingDirectory, history: undefined }
        if (input.recoverCommittedTurn) return runtime.recoverTurn(base)

        const servers = await dependencies.tools.getLaunchConfigs(`${provider}-${input.runId}`)
        if (input.projectId) servers.push({
          name: 'project_agent', command: process.execPath, args: [dependencies.mcpScript],
          env: { ELECTRON_RUN_AS_NODE: '1', PROJECT_AGENT_DB_PATH: dependencies.databasePath, PROJECT_AGENT_PROJECT_ID: input.projectId }
        })
        const model = input.model?.trim() || dependencies.settings.getCodingAgentDefaultModel(provider)
        const reasoningEffort = input.reasoningEffort?.trim() || dependencies.settings.getCodingAgentDefaultReasoningEffort(provider)
        const turn = { ...base, model, reasoningEffort }
        if (provider === 'codex' && turn.sessionId && !turn.codexSessionOwned) {
          const sessionId = await dependencies.codexMigration.adoptCodexSession({
            ...turn, provider, history: input.history()
          }, servers)
          turn.sessionId = sessionId
          turn.codexSessionOwned = Boolean(sessionId)
        }
        if (!turn.sessionId) {
          const history = codingAgentContinuationContext(input.history())
          if (history) turn.prompt = `历史对话\n\n${history}\n\n用户本轮消息\n\n${turn.prompt}`
        }
        dependencies.bind(t3EngineBindingKey(provider, input.runId))
        return runtime.runTurn(turn, servers)
      }
    }
  }
  return new AgentProviderRegistry(agentRunProviders.map(create), provider =>
    isAgentRunProvider(provider) && provider.startsWith('acp-') ? create(provider) : undefined)
}
