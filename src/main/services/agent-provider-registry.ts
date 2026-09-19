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
import type { RuntimeAttachment } from '../../shared/chat-attachments'

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
  attachments?: RuntimeAttachment[]
  history: () => AgentRunMessage[]
  sessionId: string | null
  codexSessionOwned?: boolean
  onCodexSessionReady?: (ready: import('./codex-session').CodexSessionReady) => void
  model?: string | null
  reasoningEffort?: string | null
  workingDirectory: string | null
  workspaceRoots: string[]
  filesDirectory: string
  abortController: AbortController
  onUpdate: (update: AgentRunStreamUpdate) => void
  onTool: (toolName: string, detail: string, metadata?: Record<string, unknown>) => void
  onSessionId: (sessionId: string) => void
  onAccountContext?: (context: import('../../shared/agent-account-context').AgentAccountContext) => void
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
      const attachmentNames = message.attachments?.map(file => file.filename) ?? []
      const attachmentContext = attachmentNames.length ? `\n附件保存在项目文件空间：${JSON.stringify(attachmentNames)}` : ''
      const clipped = content.length > codingAgentHistoryMessageCharacterLimit
        ? `${content.slice(0, codingAgentHistoryMessageCharacterLimit - 1)}…`
        : content
      return `${message.role === 'user' ? '用户' : 'Agent'}：${clipped}${attachmentContext}`
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
        attachments: input.attachments,
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
        if (!input.workingDirectory) throw new Error('这个 Chat 缺少 working directory。')
        const history = !input.sessionId || (provider === 'codex' && !input.codexSessionOwned) ? input.history() : []
        const continuationContext = input.sessionId ? '' : codingAgentContinuationContext(history)
        return await cliRuntime.runTurn({
          runId: input.runId,
          history,
          codexSessionOwned: input.codexSessionOwned,
          onCodexSessionReady: input.onCodexSessionReady,
          projectId: input.projectId,
          provider,
          projectContext: input.projectContext,
          attachments: input.attachments,
          prompt: continuationContext
            ? `以下是这个 Fuddy Chat 在重建原生 Session 前的历史对话。请继续当前对话，不要重复已完成的回答：\n\n${continuationContext}\n\n用户任务：\n${input.prompt}`
            : input.prompt,
          sessionId: input.sessionId,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          workingDirectory: input.workingDirectory,
          workspaceRoots: input.workspaceRoots,
          filesDirectory: input.filesDirectory,
          abortController: input.abortController,
          onUpdate: input.onUpdate,
          onSessionId: input.onSessionId,
          onAccountContext: input.onAccountContext,
          onTool: input.onTool,
          onApproval: input.onApproval
        })
      }
    })
  }
  return registry
}
