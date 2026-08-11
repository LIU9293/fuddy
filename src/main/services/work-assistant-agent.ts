import { mkdirSync } from 'node:fs'
import type { AssistantMessage, ImageContent, Message } from '@earendil-works/pi-ai'
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession
} from '@earendil-works/pi-coding-agent'
import type {
  AgentSessionUpdate,
  BriefingMessage,
  WorkAssistantActionProposal,
  WorkAssistantImageAttachment,
  WorkAssistantTaskContext
} from '../../shared/contracts'
import type { AppDatabase } from './database'
import { createPiModelRuntimeForEndpoint } from './pi-task-harness'
import type { ProviderSettingsService } from './provider-settings'
import type { WorkspaceAgentActions } from './workspace-agent-actions'

export interface WorkAssistantAgentTurnInput {
  question: string
  attachments: WorkAssistantImageAttachment[]
  taskContext: WorkAssistantTaskContext | null
  history: BriefingMessage[]
  onUpdate: (update: AgentSessionUpdate) => void
}

export interface WorkAssistantAgentTurnResult {
  content: string
  proposals: WorkAssistantActionProposal[]
  linkedRunId: string | null
}

export interface WorkAssistantAgentRuntime {
  isConfigured(): boolean
  runTurn(input: WorkAssistantAgentTurnInput): Promise<WorkAssistantAgentTurnResult>
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}

function historyMessage(message: BriefingMessage): Message {
  if (message.role === 'user') {
    return { role: 'user', content: message.content, timestamp: new Date(message.createdAt).getTime() }
  }
  const actionState = (message.actions ?? []).length > 0
    ? `\n\n[结构化 Action：${(message.actions ?? []).map((action) => `${action.title}=${action.status}`).join('；')}]`
    : ''
  return {
    role: 'assistant',
    content: [{ type: 'text', text: `${message.content}${actionState}` }],
    api: 'openai-responses',
    provider: 'project-agent-history',
    model: 'history',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: new Date(message.createdAt).getTime()
  }
}

function imageContent(attachment: WorkAssistantImageAttachment): ImageContent {
  return {
    type: 'image',
    data: attachment.dataUrl.slice(attachment.dataUrl.indexOf(',') + 1),
    mimeType: attachment.mimeType
  }
}

export class PiWorkAssistantAgent implements WorkAssistantAgentRuntime {
  private turnQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly providerSettings: ProviderSettingsService,
    private readonly database: AppDatabase,
    private readonly actions: WorkspaceAgentActions,
    private readonly sessionDirectory: string,
    private readonly workingDirectory: string
  ) {
    mkdirSync(this.sessionDirectory, { recursive: true })
  }

  isConfigured(): boolean {
    const settings = this.providerSettings.getAgentRuntimeSettings()
    const configured = (endpoint: typeof settings.primary): boolean => Boolean(
      endpoint.baseUrl && endpoint.model && (endpoint.apiKey || this.isLoopback(endpoint.baseUrl))
    )
    return configured(settings.primary) || (settings.backupEnabled && configured(settings.backup))
  }

  runTurn(input: WorkAssistantAgentTurnInput): Promise<WorkAssistantAgentTurnResult> {
    const turn = this.turnQueue.then(() => this.runTurnNow(input))
    this.turnQueue = turn.then(() => undefined, () => undefined)
    return turn
  }

  private async runTurnNow(input: WorkAssistantAgentTurnInput): Promise<WorkAssistantAgentTurnResult> {
    const settings = this.providerSettings.getAgentRuntimeSettings()
    const endpoints = settings.backupEnabled ? [settings.primary, settings.backup] : [settings.primary]
    const failures: string[] = []

    for (const [index, endpoint] of endpoints.entries()) {
      let session: AgentSession | null = null
      const turnState = this.actions.createTurnState()
      try {
        const { modelRuntime, model } = await createPiModelRuntimeForEndpoint(endpoint)
        const sessionManager = SessionManager.continueRecent(this.workingDirectory, this.sessionDirectory)
        if (sessionManager.getEntries().length === 0) {
          for (const message of input.history) sessionManager.appendMessage(historyMessage(message))
        }
        const resourceLoader = new DefaultResourceLoader({
          cwd: this.workingDirectory,
          agentDir: getAgentDir(),
          noExtensions: true,
          appendSystemPrompt: [this.systemPrompt(input.taskContext)]
        })
        await resourceLoader.reload()
        const customTools = this.actions.createTools(turnState)
        const created = await createAgentSession({
          cwd: this.workingDirectory,
          modelRuntime,
          model,
          thinkingLevel: 'medium',
          sessionManager,
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: true },
            retry: { enabled: true, maxRetries: 2, baseDelayMs: 1_000 },
            hideThinkingBlock: true
          }),
          resourceLoader,
          customTools,
          tools: customTools.map((tool) => tool.name)
        })
        session = created.session
        const messageId = `work-assistant-${Date.now()}`
        let lastAssistant: AssistantMessage | null = null
        let streamedText = ''
        session.subscribe((event) => {
          if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
            streamedText += event.assistantMessageEvent.delta
            input.onUpdate({
              sessionUpdate: 'agent_message_chunk',
              messageId,
              content: { type: 'text', text: event.assistantMessageEvent.delta }
            })
          }
          if (event.type === 'tool_execution_end' && event.toolName === 'ask_user' && !event.isError) {
            // ask_user is a deliberate turn boundary. The UI now owns the next input,
            // so do not spend another model request asking the Agent to say it is waiting.
            queueMicrotask(() => { void session?.abort() })
          }
          if (event.type === 'message_end' && event.message.role === 'assistant') lastAssistant = event.message
        })
        try {
          await session.prompt(this.userPrompt(input), {
            images: input.attachments.map(imageContent)
          })
        } catch (error) {
          if (turnState.proposals.length === 0) throw error
        }
        const content = lastAssistant ? assistantText(lastAssistant) : ''
        if (!content && turnState.proposals.length === 0) {
          throw new Error(session.agent.state.errorMessage || '工作助理 Agent 没有返回内容。')
        }
        return {
          content: content || streamedText.trim() || '请在下方选择后，我再继续。',
          proposals: turnState.proposals,
          linkedRunId: turnState.linkedRunId
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误'
        failures.push(`${index === 0 ? 'Primary' : 'Backup'}: ${message}`)
        if (turnState.proposals.length > 0) {
          return {
            content: '请在下方选择后，我再继续。',
            proposals: turnState.proposals,
            linkedRunId: turnState.linkedRunId
          }
        }
      } finally {
        session?.dispose()
      }
    }
    throw new Error(`工作助理 Agent 不可用。${failures.join('；')}`)
  }

  private systemPrompt(taskContext: WorkAssistantTaskContext | null): string {
    const projects = this.database.listProjects().map((project) => ({ id: project.id, name: project.name, status: project.status }))
    const recentActions = this.database.listBriefingMessages().slice(-12).flatMap((message) =>
      (message.actions ?? []).map((action) => ({ messageId: message.id, title: action.title, status: action.status, acceptedOptionId: action.acceptedOptionId })))
    return `你是 Project Agent 的工作助理，是一个拥有真实工具、持久 Session 和自动上下文压缩的跨项目 Agent。

你的职责是理解并管理所有项目、目标、决策收件箱、文件、Agent Run、联网研究和每日简报。你负责协调与管理；具体项目执行优先交给 Agent Run。

必须遵守：
- 需要事实或 ID 时调用读取工具；不要根据提示词中的摘要编造数据库、文件、Run 或执行状态。
- 工具是唯一的执行入口。不要输出伪造的“请确认”文本或 Markdown 按钮。
- 任何 confirm/explicit 能力都必须先调用 ask_user。ask_user 只发送按钮，不代表 Action 已执行；调用后停止本轮等待用户选择。
- ask_user 通常提供一个明确的执行按钮和一个取消按钮；取消按钮必须使用 assistant.dismiss，不能复用执行能力。
- 读取与打开链接可以直接执行。open_agent_run 只是附加跳转链接，绝不改变 Run、消息或收件箱状态。
- 创建 Agent Run 只创建 Draft 并预填首条消息，不自动发送。真正发送或继续执行必须通过 agent-run.send 再次确认。
- 生成每日简报会运行跨项目巡检，属于 briefing.generate，必须通过 ask_user 确认。
- 用户明确确认的事实优先于推断；代码合并不等于生产问题已解决。
- 不暴露隐藏思考链。用中文和简洁 Markdown 回复，先给结论。

当前项目索引：${JSON.stringify(projects)}
当前任务上下文：${JSON.stringify(taskContext)}
最近结构化 Action 状态：${JSON.stringify(recentActions)}`
  }

  private userPrompt(input: WorkAssistantAgentTurnInput): string {
    return input.taskContext
      ? `当前任务上下文：${JSON.stringify(input.taskContext)}\n\n用户消息：${input.question}`
      : input.question
  }

  private isLoopback(baseUrl: string): boolean {
    try {
      return ['localhost', '127.0.0.1', '::1'].includes(new URL(baseUrl).hostname)
    } catch {
      return false
    }
  }
}
