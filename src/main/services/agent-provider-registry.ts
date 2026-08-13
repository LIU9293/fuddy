import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentRunMessage,
  AgentRunProvider,
  AgentRunStreamUpdate
} from '../../shared/contracts'
import type { CliAgentRuntime } from './cli-agent-runtime'
import type { PiTaskHarness } from './pi-task-harness'
import { codingAgentProviders } from '../../shared/agent-providers'

export interface AgentProviderCapabilities {
  nativeSessions: boolean
  modelSelection: boolean
  reasoningSummaries: boolean
  toolCalls: boolean
  approvals: boolean
}

export interface AgentProviderTurnInput {
  runId: string
  projectId: string | null
  projectContext: string
  prompt: string
  history: () => AgentRunMessage[]
  sessionId: string | null
  model?: string | null
  reasoningEffort?: string | null
  workingDirectory: string | null
  workspaceRoots: string[]
  filesDirectory: string
  abortController: AbortController
  onUpdate: (update: AgentRunStreamUpdate) => void
  onTool: (toolName: string, detail: string, metadata?: Record<string, unknown>) => void
  onSessionId: (sessionId: string) => void
  onApproval: (request: Omit<AgentApprovalRequest, 'runId' | 'createdAt'>) => Promise<AgentApprovalDecision>
}

export interface AgentProviderTurnResult {
  text: string
  sessionId: string | null
}

export interface AgentProviderAdapter {
  provider: AgentRunProvider
  capabilities: AgentProviderCapabilities
  runTurn(input: AgentProviderTurnInput): Promise<AgentProviderTurnResult>
}

const codingAgentHistoryMessageLimit = 12
const codingAgentHistoryCharacterLimit = 32_000
const codingAgentHistoryMessageCharacterLimit = 8_000

export function codingAgentContinuationContext(messages: AgentRunMessage[]): string {
  const formatted = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .filter((message) => message.content.trim().length > 0)
    .slice(-codingAgentHistoryMessageLimit)
    .map((message) => {
      const content = message.content.trim()
      const clipped = content.length > codingAgentHistoryMessageCharacterLimit
        ? `${content.slice(0, codingAgentHistoryMessageCharacterLimit - 1)}…`
        : content
      return `${message.role === 'user' ? '用户' : 'Agent'}：${clipped}`
    })

  const retained: string[] = []
  let retainedCharacters = 0
  for (let index = formatted.length - 1; index >= 0; index -= 1) {
    const message = formatted[index]
    const nextLength = retainedCharacters + message.length + (retained.length > 0 ? 2 : 0)
    if (nextLength > codingAgentHistoryCharacterLimit) break
    retained.unshift(message)
    retainedCharacters = nextLength
  }
  return retained.join('\n\n')
}

export class AgentProviderRegistry {
  private readonly adapters = new Map<AgentRunProvider, AgentProviderAdapter>()

  constructor(adapters: AgentProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter)
  }

  register(adapter: AgentProviderAdapter): void {
    if (this.adapters.has(adapter.provider)) {
      throw new Error(`Agent provider already registered: ${adapter.provider}`)
    }
    this.adapters.set(adapter.provider, adapter)
  }

  get(provider: AgentRunProvider): AgentProviderAdapter {
    const adapter = this.adapters.get(provider)
    if (!adapter) throw new Error(`Agent provider is not registered: ${provider}`)
    return adapter
  }

  list(): AgentProviderAdapter[] {
    return [...this.adapters.values()]
  }

  runTurn(provider: AgentRunProvider, input: AgentProviderTurnInput): Promise<AgentProviderTurnResult> {
    return this.get(provider).runTurn(input)
  }
}

const sharedCapabilities: AgentProviderCapabilities = {
  nativeSessions: true,
  modelSelection: true,
  reasoningSummaries: true,
  toolCalls: true,
  approvals: true
}

export function createDefaultAgentProviderRegistry(
  piHarness: PiTaskHarness,
  cliRuntime: CliAgentRuntime
): AgentProviderRegistry {
  const registry = new AgentProviderRegistry()
  registry.register({
    provider: 'pi',
    capabilities: { ...sharedCapabilities, modelSelection: false },
    async runTurn(input) {
      const text = await piHarness.runTurn({
        runId: input.runId,
        projectId: input.projectId,
        projectContext: input.projectContext,
        prompt: input.prompt,
        history: input.history(),
        sessionId: input.sessionId,
        workingDirectory: input.workingDirectory ?? input.filesDirectory,
        workspaceRoots: input.workspaceRoots,
        filesDirectory: input.filesDirectory,
        abortController: input.abortController,
        onUpdate: input.onUpdate,
        onTool: input.onTool,
        onApproval: input.onApproval,
        onSessionId: input.onSessionId
      })
      return { text, sessionId: null }
    }
  })

  for (const provider of codingAgentProviders) {
    registry.register({
      provider,
      capabilities: { ...sharedCapabilities },
      async runTurn(input) {
        if (!input.workingDirectory) throw new Error('这个 Agent Run 缺少 working directory。')
        const continuationContext = input.sessionId ? '' : codingAgentContinuationContext(input.history())
        return await cliRuntime.runTurn({
          projectId: input.projectId,
          provider,
          prompt: [
            input.projectContext,
            continuationContext
              ? `以下是这个 Fuddy Agent Run 在重建原生 Session 前的历史对话。请继续当前对话，不要重复已完成的回答：\n\n${continuationContext}`
              : '',
            `用户任务：\n${input.prompt}`
          ].filter(Boolean).join('\n\n'),
          sessionId: input.sessionId,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          workingDirectory: input.workingDirectory,
          workspaceRoots: input.workspaceRoots,
          filesDirectory: input.filesDirectory,
          abortController: input.abortController,
          onUpdate: input.onUpdate,
          onSessionId: input.onSessionId,
          onTool: input.onTool,
          onApproval: input.onApproval
        })
      }
    })
  }
  return registry
}
