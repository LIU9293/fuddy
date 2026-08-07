import { existsSync, mkdirSync } from 'node:fs'
import {
  Type,
  createProvider,
  type Api,
  type AssistantMessage,
  type Message,
  type Model
} from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent'
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentRunMessage,
  AgentRunStreamUpdate,
  Project,
  ProjectWorkspaceRoot
} from '../../shared/contracts'
import { evaluateAggressivePermission } from '../../shared/permissions'
import { normalizeWorkspaceRoots } from '../../shared/project-workspaces'
import { AppDatabase } from './database'
import { ProviderSettingsService, type RuntimeAgentEndpoint } from './provider-settings'
import { ThirdPartyMcpRuntime } from './third-party-mcp-runtime'

export interface PiTaskTurnInput {
  runId: string
  projectId: string | null
  projectContext: string
  prompt: string
  history: AgentRunMessage[]
  sessionId: string | null
  workingDirectory: string
  workspaceRoots: string[]
  filesDirectory: string
  abortController: AbortController
  onUpdate: (update: AgentRunStreamUpdate) => void
  onTool: (toolName: string, detail: string, metadata?: Record<string, unknown>) => void
  onSessionId: (sessionId: string) => void
  onApproval: (request: Omit<AgentApprovalRequest, 'runId' | 'createdAt'>) => Promise<AgentApprovalDecision>
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}

function historyMessage(message: AgentRunMessage): Message | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null
  return message.role === 'user'
    ? { role: 'user', content: message.content, timestamp: new Date(message.createdAt).getTime() }
    : {
        role: 'assistant',
        content: [{ type: 'text', text: message.content }],
        api: 'openai-responses',
        provider: 'project-agent-history',
        model: 'history',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: new Date(message.createdAt).getTime()
      }
}

async function runtimeForEndpoint(endpoint: RuntimeAgentEndpoint): Promise<{
  modelRuntime: ModelRuntime
  model: Model<Api>
}> {
  const providerId = `project-agent-${endpoint.mode}`
  const baseUrl = endpoint.mode === 'cc-switch-codex-oauth'
    ? endpoint.baseUrl.replace(/\/v1\/?$/, '')
    : endpoint.baseUrl
  const api = endpoint.mode === 'cc-switch-codex-oauth'
    ? 'anthropic-messages' as const
    : 'openai-responses' as const
  const headers: Record<string, string> = endpoint.mode === 'cc-switch-codex-oauth'
    ? { Authorization: 'Bearer PROXY_MANAGED', 'x-api-key': 'PROXY_MANAGED', 'anthropic-version': '2023-06-01' }
    : {}
  const model = {
    id: endpoint.model,
    name: endpoint.model,
    api,
    provider: providerId,
    baseUrl,
    headers,
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192
  } satisfies Model<typeof api>
  const apiKey = endpoint.mode === 'cc-switch-codex-oauth' ? 'PROXY_MANAGED' : endpoint.apiKey ?? ''
  const provider = createProvider({
    id: providerId,
    name: 'Project Agent Provider',
    baseUrl,
    headers,
    auth: {
      apiKey: {
        name: 'Project Agent Provider',
        resolve: async () => ({ auth: apiKey ? { apiKey } : {} })
      }
    },
    models: [model],
    api: endpoint.mode === 'cc-switch-codex-oauth'
      ? anthropicMessagesApi()
      : openAIResponsesApi()
  })
  const modelRuntime = await ModelRuntime.create({ modelsPath: null })
  modelRuntime.registerNativeProvider(provider)
  if (apiKey) await modelRuntime.setRuntimeApiKey(providerId, apiKey)
  return { modelRuntime, model }
}

function textFromToolResult(result: unknown, fallback: string): string {
  if (!result || typeof result !== 'object') return fallback
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content
  return content?.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n').trim() || fallback
}

export class PiTaskHarness {
  constructor(
    private readonly providerSettings: ProviderSettingsService,
    private readonly database: AppDatabase,
    private readonly mcpRuntime: ThirdPartyMcpRuntime,
    private readonly sessionDirectory: string
  ) {
    mkdirSync(this.sessionDirectory, { recursive: true })
  }

  async runTurn(input: PiTaskTurnInput): Promise<string> {
    let mcpAvailability = 'Browser Use 与 Computer Use MCP 已连接。'
    try {
      await this.mcpRuntime.start()
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      mcpAvailability = `Browser Use / Computer Use MCP 本轮不可用：${message}`
    }
    const settings = this.providerSettings.getAgentRuntimeSettings()
    const endpoints = settings.backupEnabled ? [settings.primary, settings.backup] : [settings.primary]
    const failures: string[] = []

    for (const [index, endpoint] of endpoints.entries()) {
      let mutationOccurred = false
      let session: AgentSession | null = null
      try {
        const { modelRuntime, model } = await runtimeForEndpoint(endpoint)
        const sessionManager = input.sessionId && existsSync(input.sessionId)
          ? SessionManager.open(input.sessionId, this.sessionDirectory, input.workingDirectory)
          : SessionManager.create(input.workingDirectory, this.sessionDirectory, { id: input.runId })
        if (sessionManager.getEntries().length === 0) {
          for (const message of input.history) {
            const converted = historyMessage(message)
            if (converted) sessionManager.appendMessage(converted)
          }
        }
        const resourceLoader = new DefaultResourceLoader({
          cwd: input.workingDirectory,
          agentDir: getAgentDir(),
          noExtensions: true,
          appendSystemPrompt: [this.systemPrompt(input, mcpAvailability)]
        })
        await resourceLoader.reload()
        const customTools = this.createCustomTools(input)
        const created = await createAgentSession({
          cwd: input.workingDirectory,
          modelRuntime,
          model,
          thinkingLevel: 'medium',
          sessionManager,
          resourceLoader,
          customTools,
          tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', ...customTools.map((tool) => tool.name)]
        })
        session = created.session
        const abortSession = (): void => { void session?.abort() }
        input.abortController.signal.addEventListener('abort', abortSession, { once: true })
        const sessionFile = session.sessionFile
        if (sessionFile) input.onSessionId(sessionFile)
        const messageId = `pi-${input.runId}-${Date.now()}`
        const toolArguments = new Map<string, Record<string, unknown>>()
        let lastTurnAssistant: AssistantMessage | null = null
        session.subscribe((event) => {
          if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
            input.onUpdate({ type: 'message_delta', messageId, delta: event.assistantMessageEvent.delta })
          }
          if (event.type === 'tool_execution_start') {
            toolArguments.set(event.toolCallId, event.args)
            if (['write', 'edit', 'bash', 'update_project_info'].includes(event.toolName)) mutationOccurred = true
            input.onUpdate({ type: 'tool', toolName: event.toolName, status: 'running', detail: JSON.stringify(event.args) })
          }
          if (event.type === 'tool_execution_end') {
            const detail = textFromToolResult(event.result, event.toolName)
            const resultDetails = event.result && typeof event.result === 'object'
              ? (event.result as { details?: Record<string, unknown> }).details
              : undefined
            input.onTool(event.toolName, detail, { ...(resultDetails ?? {}), arguments: toolArguments.get(event.toolCallId) ?? {} })
            toolArguments.delete(event.toolCallId)
            input.onUpdate({ type: 'tool', toolName: event.toolName, status: event.isError ? 'failed' : 'completed', detail })
          }
          if (event.type === 'message_end' && event.message.role === 'assistant') {
            lastTurnAssistant = event.message
          }
        })
        input.onUpdate({ type: 'status', status: 'running', detail: 'Pi Coding Agent SDK 正在执行' })
        try {
          if (input.abortController.signal.aborted) throw input.abortController.signal.reason
          await session.prompt(input.prompt)
        } finally {
          input.abortController.signal.removeEventListener('abort', abortSession)
        }
        const text = lastTurnAssistant ? assistantText(lastTurnAssistant) : ''
        if (!text) throw new Error(session.agent.state.errorMessage || 'Pi Agent 没有返回文本内容。')
        return text
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误'
        failures.push(`${index === 0 ? 'Primary' : 'Backup'}: ${message}`)
        if (mutationOccurred) break
      } finally {
        session?.dispose()
      }
    }
    throw new Error(`Pi Coding Agent SDK 不可用。${failures.join('；')}`)
  }

  private systemPrompt(input: PiTaskTurnInput, mcpAvailability: string): string {
    const roots = input.workspaceRoots.map((root, index) => `${index + 1}. ${root}${root === input.workingDirectory ? '（当前主目录）' : ''}`).join('\n')
    return `你是 Project Agent 中负责项目任务的执行 Agent，运行在一个可持续对话的 Agent Run Session 中。

当前工作目录：${input.workingDirectory}
项目允许的 Workspace Roots：
${roots || `1. ${input.workingDirectory}`}
项目产物目录：${input.filesDirectory}

当前项目与任务上下文：
${input.projectContext}

你拥有 Pi Coding Agent 的 read、bash、edit、write、grep、find、ls 基础工具，也可以使用 update_project_info 修改当前项目配置。
你还可以使用第三方 MCP：Browser Use 负责网页，Computer Use 负责没有结构化接口的本机 App。${mcpAvailability}
先检查项目中的 AGENTS.md、README、已有脚本、数据库模型和 Skills，再基于实际证据行动。不要编造数据库内容或执行结果。
所有独立运营、Marketing、分析和文档产物应写入项目产物目录；代码和项目内文档应写入对应 Workspace。
修改项目 Workspace 后，新目录从下一回合开始生效。
使用中文和 Markdown，先给结论，再给实际执行结果。`
  }

  private createCustomTools(input: PiTaskTurnInput): ToolDefinition[] {
    const updateProject = defineTool({
      name: 'update_project_info',
      label: 'Update project info',
      description: '更新当前 Project Agent 项目的基本信息、产品上下文、Workspace Roots、默认 Agent、数据源或当前状态。只传需要修改的字段。',
      promptSnippet: 'Update the current project configuration and workspace roots',
      executionMode: 'sequential',
      parameters: Type.Object({
        name: Type.Optional(Type.String()),
        summary: Type.Optional(Type.String()),
        focus: Type.Optional(Type.String()),
        status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('watching'), Type.Literal('paused')])),
        productType: Type.Optional(Type.String()),
        stage: Type.Optional(Type.String()),
        mission: Type.Optional(Type.String()),
        vision: Type.Optional(Type.String()),
        websiteUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        defaultAgent: Type.Optional(Type.Union([Type.Literal('pi'), Type.Literal('codex'), Type.Literal('claude'), Type.Literal('opencode')])),
        focusAreas: Type.Optional(Type.Array(Type.String())),
        dataSources: Type.Optional(Type.Array(Type.String())),
        nextMoves: Type.Optional(Type.Array(Type.String())),
        currentStateSummary: Type.Optional(Type.String()),
        currentStateFacts: Type.Optional(Type.Array(Type.String())),
        workspaceRoots: Type.Optional(Type.Array(Type.Object({
          id: Type.String(),
          label: Type.String(),
          path: Type.String()
        }))),
        primaryWorkspaceRootId: Type.Optional(Type.Union([Type.String(), Type.Null()]))
      }),
      execute: async (_toolCallId, params) => {
        if (!input.projectId) throw new Error('共享任务不能修改项目配置。')
        const project = this.database.listProjects().find((item) => item.id === input.projectId)
        if (!project) throw new Error('当前项目不存在。')
        const updated = this.applyProjectUpdate(project, params)
        const intent = {
          tool: 'update_project_info',
          action: 'update',
          target: project.id,
          description: 'Agent 更新当前项目的显式配置字段。'
        }
        const evaluation = evaluateAggressivePermission(intent)
        this.database.recordPermissionEvaluation(intent, evaluation)
        if (evaluation.decision === 'requires-confirmation') throw new Error(evaluation.reason)
        const saved = this.database.updateProject(updated)
        return {
          content: [{ type: 'text', text: `已更新项目 ${saved.name}。主 Workspace：${saved.profile.repoPath || '未设置'}；Workspace 数量：${saved.profile.workspaceRoots.length}。` }],
          details: { projectId: saved.id, workspaceRoots: saved.profile.workspaceRoots, artifact: false }
        }
      }
    })

    const mcpTools = this.mcpRuntime.listTools().map((tool) => defineTool({
      name: tool.name,
      label: tool.name.replaceAll('_', ' '),
      description: tool.description,
      parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
      execute: async (_toolCallId, params) => {
        const result = await this.mcpRuntime.callTool(tool.name, params)
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = []
        for (const block of result.content) {
          if (block.type === 'text') content.push({ type: 'text', text: block.text })
          if (block.type === 'image') content.push({ type: 'image', data: block.data, mimeType: block.mimeType })
        }
        const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
        if (result.isError) throw new Error(text || `${tool.name} 执行失败。`)
        return { content: content.length > 0 ? content : [{ type: 'text' as const, text: `${tool.name} 已完成` }], details: { mcpServer: tool.serverName } }
      }
    }))
    return [updateProject, ...mcpTools]
  }

  private applyProjectUpdate(project: Project, params: Record<string, unknown>): Project {
    const profile = { ...project.profile }
    const stringFields = ['productType', 'stage', 'mission', 'vision'] as const
    for (const field of stringFields) {
      if (typeof params[field] === 'string' && params[field].trim()) profile[field] = params[field].trim()
    }
    if (params.websiteUrl === null || typeof params.websiteUrl === 'string') profile.websiteUrl = params.websiteUrl?.trim() || null
    if (params.defaultAgent === 'pi' || params.defaultAgent === 'codex' || params.defaultAgent === 'claude' || params.defaultAgent === 'opencode') {
      profile.defaultAgent = params.defaultAgent
    }
    for (const field of ['focusAreas', 'dataSources', 'nextMoves'] as const) {
      if (Array.isArray(params[field])) profile[field] = params[field].filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
    }
    if (Array.isArray(params.workspaceRoots)) profile.workspaceRoots = params.workspaceRoots as ProjectWorkspaceRoot[]
    if (params.primaryWorkspaceRootId === null || typeof params.primaryWorkspaceRootId === 'string') {
      profile.primaryWorkspaceRootId = params.primaryWorkspaceRootId
    }
    Object.assign(profile, normalizeWorkspaceRoots(profile))
    if (typeof params.currentStateSummary === 'string' || Array.isArray(params.currentStateFacts)) {
      profile.currentState = {
        summary: typeof params.currentStateSummary === 'string' && params.currentStateSummary.trim()
          ? params.currentStateSummary.trim()
          : profile.currentState.summary,
        facts: Array.isArray(params.currentStateFacts)
          ? params.currentStateFacts.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
          : profile.currentState.facts,
        source: 'agent',
        updatedAt: new Date().toISOString()
      }
    }
    return {
      ...project,
      name: typeof params.name === 'string' && params.name.trim() ? params.name.trim() : project.name,
      summary: typeof params.summary === 'string' && params.summary.trim() ? params.summary.trim() : project.summary,
      focus: typeof params.focus === 'string' && params.focus.trim() ? params.focus.trim() : project.focus,
      status: params.status === 'active' || params.status === 'watching' || params.status === 'paused' ? params.status : project.status,
      profile
    }
  }
}
