import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { attachmentPrompt, isNativeImage, type RuntimeAttachment } from '../../shared/chat-attachments'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { AgentApprovalDecision, AgentApprovalRequest, AgentRunProvider, AgentRunStreamUpdate } from '../../shared/contracts'
import { resolveCliBinary } from './cli-executables'
import type { ProviderSettingsService } from './provider-settings'
import type { McpServerLaunchConfig } from './third-party-mcp-runtime'
import { buildAgentInstructions, buildAdditionalWorkspaceContext } from './agent-runtime-context'
import { terminateProcessTree } from './process-tree'
import { codexSessionError, prepareCodexSession, type CodexSessionReady } from './codex-session'
import { throwIfCancelled } from './cancellation'
import type { AgentAccountContext } from '../../shared/agent-account-context'
import { emptyAccountContext, codexAccountContext, codexExecutionContext, codexLimitContext, claudeAccountContext, claudeModelContext, claudeLimitContext, claudeTurnUsage, opencodeStepUsage, optionalAccountMetadata } from './agent-account-context'

export interface McpLaunchConfigProvider {
  getLaunchConfigs(scope?: string): Promise<McpServerLaunchConfig[]>
}

export interface CliAgentTurnInput {
  runId?: string
  history?: import('../../shared/contracts').AgentRunMessage[]
  codexSessionOwned?: boolean
  onCodexSessionReady?: (ready: CodexSessionReady) => void
  projectId: string | null
  provider: Exclude<AgentRunProvider, 'pi'>
  /** Empty or omitted means the coding agent's own configured default. */
  model?: string | null
  /** Empty or omitted means the coding agent's own configured default. */
  reasoningEffort?: string | null
  prompt: string
  projectContext?: string
  attachments?: RuntimeAttachment[]
  sessionId: string | null
  workingDirectory: string
  workspaceRoots: string[]
  filesDirectory: string
  abortController: AbortController
  onUpdate: (update: AgentRunStreamUpdate) => void
  onActivity?: () => void
  onSessionId: (sessionId: string) => void
  onAccountContext?: (context: AgentAccountContext) => void
  onTool: (toolName: string, detail: string, metadata?: Record<string, unknown>) => void
  onApproval: (request: Omit<AgentApprovalRequest, 'runId' | 'createdAt'>) => Promise<AgentApprovalDecision>
  onSteerReady?: (steer: ((prompt: string, attachments: RuntimeAttachment[], requestId: string) => Promise<void>) | null) => void
}

export interface CliAgentTurnResult {
  text: string
  sessionId: string | null
}

export interface CliAgentProviderRuntimeAdapter {
  provider: CliAgentTurnInput['provider']
  runTurn(input: CliAgentTurnInput, mcpServers: McpServerLaunchConfig[]): Promise<CliAgentTurnResult>
}

type JsonRecord = Record<string, unknown>
type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type ParsedCliRecord = {
  assistant?: string
  reasoning?: string
  reasoningSegmentId?: string
  tool?: { id?: string; name: string; detail: string; status: 'running' | 'completed' | 'failed' }
}

// Codex app-server deliberately uses different casing for the legacy thread
// sandbox enum and the structured turn sandbox policy discriminant.
export const CODEX_THREAD_SANDBOX = 'danger-full-access' as const
export const CODEX_TURN_SANDBOX_POLICY = 'dangerFullAccess' as const
export const CODEX_APPROVAL_POLICY = 'never' as const
export const CODEX_REASONING_SUMMARY = 'none' as const

export function codingAgentRuntimeRoots(input: Pick<CliAgentTurnInput, 'workingDirectory' | 'workspaceRoots' | 'filesDirectory'>): string[] {
  return [...new Set([input.workingDirectory, ...input.workspaceRoots, input.filesDirectory])]
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function streamTextValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function codexTomlStringMap(values: Record<string, string>): string {
  const entries = Object.entries(values).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
  return `{ ${entries.join(', ')} }`
}

export function codexAgentMessagePhase(item: JsonRecord): 'commentary' | 'final_answer' | null {
  if (item.type !== 'agentMessage') return null
  return item.phase === 'commentary' || item.phase === 'final_answer' ? item.phase : null
}

export function claudeSdkReasoningOptions(reasoningEffort?: string | null): { effort?: ClaudeEffort } {
  return reasoningEffort ? { effort: reasoningEffort as ClaudeEffort } : {}
}

export function buildCodexTurnStartParams(
  threadId: string,
  prompt: string,
  reasoningEffort?: string | null,
  attachments: RuntimeAttachment[] = []
): JsonRecord {
  return {
    threadId,
    input: [
      { type: 'text', text: attachmentPrompt(prompt, attachments) },
      ...attachments.filter(file => isNativeImage(file.mimeType)).map(file => ({ type: 'localImage', path: file.path }))
    ],
    approvalPolicy: CODEX_APPROVAL_POLICY,
    sandboxPolicy: { type: CODEX_TURN_SANDBOX_POLICY },
    summary: CODEX_REASONING_SUMMARY,
    ...(reasoningEffort ? { effort: reasoningEffort } : {})
  }
}

export function buildCodexTurnSteerParams(
  threadId: string,
  turnId: string,
  requestId: string,
  prompt: string,
  attachments: RuntimeAttachment[] = []
): JsonRecord {
  return {
    threadId,
    expectedTurnId: turnId,
    clientUserMessageId: requestId,
    input: [
      { type: 'text', text: attachmentPrompt(prompt, attachments) },
      ...attachments.filter(file => isNativeImage(file.mimeType)).map(file => ({ type: 'localImage', path: file.path }))
    ]
  }
}

function recordSessionId(record: JsonRecord): string | null {
  return textValue(record.thread_id) || textValue(record.session_id) || textValue(record.sessionID) || null
}

function codexRecord(record: JsonRecord): ParsedCliRecord {
  const item = record.item && typeof record.item === 'object' ? record.item as JsonRecord : null
  if (!item) return {}
  const itemType = textValue(item.type)
  if (itemType === 'agent_message') return { assistant: textValue(item.text) }
  if (itemType === 'command_execution') {
    const command = textValue(item.command)
    const output = textValue(item.aggregated_output)
    return {
      tool: {
        id: textValue(item.id) || undefined,
        name: 'command',
        detail: [command, output].filter(Boolean).join('\n').slice(0, 4_000),
        status: item.status === 'in_progress' ? 'running' : item.status === 'failed' ? 'failed' : 'completed'
      }
    }
  }
  if (itemType && itemType !== 'reasoning') {
    return {
      tool: {
        id: textValue(item.id) || undefined,
        name: itemType,
        detail: textValue(item.text) || textValue(item.status) || itemType,
        status: item.status === 'in_progress' ? 'running' : item.status === 'failed' ? 'failed' : 'completed'
      }
    }
  }
  return {}
}

export function codexAppServerToolRecord(item: JsonRecord): ParsedCliRecord['tool'] {
  const type = textValue(item.type)
  const id = textValue(item.id) || undefined
  const status = item.status === 'inProgress' || item.status === 'in_progress'
    ? 'running'
    : item.status === 'failed'
      ? 'failed'
      : 'completed'
  if (type === 'commandExecution') {
    return {
      id,
      name: 'command',
      detail: [textValue(item.command), textValue(item.aggregatedOutput)].filter(Boolean).join('\n').slice(0, 4_000) || '运行命令',
      status
    }
  }
  if (type === 'fileChange') {
    return {
      id,
      name: 'edit',
      detail: JSON.stringify(item.changes ?? item).slice(0, 4_000),
      status
    }
  }
  if (type === 'mcpToolCall' || type === 'dynamicToolCall' || type === 'collabAgentToolCall' || type === 'collabToolCall') {
    return {
      id,
      name: textValue(item.tool) || textValue(item.name) || 'mcp_tool',
      detail: JSON.stringify(item.arguments ?? item.result ?? item).slice(0, 4_000),
      status
    }
  }
  if (type === 'webSearch') {
    return { id, name: 'web_search', detail: textValue(item.query) || JSON.stringify(item).slice(0, 4_000), status }
  }
  if (type === 'imageView') {
    return { id, name: 'read', detail: textValue(item.path) || JSON.stringify(item).slice(0, 4_000), status }
  }
  return undefined
}

export function claudeRecord(record: JsonRecord): ParsedCliRecord {
  if (record.type === 'result') return { assistant: textValue(record.result) }
  if (record.type === 'assistant' && record.message && typeof record.message === 'object') {
    const content = (record.message as JsonRecord).content
    if (Array.isArray(content)) {
      const text = content
        .map((block) => block && typeof block === 'object' && (block as JsonRecord).type === 'text'
          ? textValue((block as JsonRecord).text)
          : '')
        .filter(Boolean)
        .join('\n\n')
      if (text) return { assistant: text }
    }
  }
  if (record.type === 'stream_event' && record.event && typeof record.event === 'object') {
    const event = record.event as JsonRecord
    if (event.type === 'content_block_delta' && event.delta && typeof event.delta === 'object') {
      const delta = event.delta as JsonRecord
      if (delta.type === 'text_delta') return { assistant: streamTextValue(delta.text) }
      if (delta.type === 'thinking_delta') {
        const index = typeof event.index === 'number' ? event.index : null
        return {
          reasoning: streamTextValue(delta.thinking),
          ...(index === null ? {} : { reasoningSegmentId: `claude-thinking-${index}` })
        }
      }
    }
  }
  return {}
}

export function opencodeRecord(record: JsonRecord): ParsedCliRecord {
  const part = record.part && typeof record.part === 'object' ? record.part as JsonRecord : record
  if (part.type === 'text') return { assistant: textValue(part.text) }
  if (part.type === 'reasoning') {
    return {
      reasoning: streamTextValue(part.text),
      reasoningSegmentId: textValue(part.id) || undefined
    }
  }
  if (part.type === 'tool') {
    const state = part.state && typeof part.state === 'object' ? part.state as JsonRecord : {}
    const nativeStatus = textValue(state.status)
    const status = nativeStatus === 'pending' || nativeStatus === 'running'
      ? 'running'
      : nativeStatus === 'error' || nativeStatus === 'failed'
        ? 'failed'
        : 'completed'
    return {
      tool: {
        id: textValue(part.callID) || textValue(part.callId) || textValue(part.id) || undefined,
        name: textValue(part.tool) || 'tool',
        detail: JSON.stringify(part.state ?? part).slice(0, 4_000),
        status
      }
    }
  }
  return {}
}

export function buildCliArgs(input: CliAgentTurnInput, mcpServers: McpServerLaunchConfig[]): string[] {
  const additionalDirectories = codingAgentRuntimeRoots(input)
    .filter((directory) => directory !== input.workingDirectory)
  if (input.provider === 'codex') {
    const common = [
      'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
      ...(input.model ? ['--model', input.model] : []),
      ...(input.reasoningEffort ? ['-c', `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`] : []),
      ...additionalDirectories.flatMap((directory) => ['--add-dir', directory]),
      ...mcpServers.flatMap((server) => [
        '-c', `mcp_servers.${server.name}.command=${JSON.stringify(server.command)}`,
        '-c', `mcp_servers.${server.name}.args=${JSON.stringify(server.args)}`,
        ...(server.env ? ['-c', `mcp_servers.${server.name}.env=${codexTomlStringMap(server.env)}`] : [])
      ])
    ]
    return input.sessionId
      ? [...common, 'resume', input.sessionId, input.prompt]
      : [...common, input.prompt]
  }
  if (input.provider === 'claude') {
    const session = input.sessionId
      ? ['--resume', input.sessionId]
      : ['--session-id', crypto.randomUUID()]
    return [
      '--print', '--verbose', '--output-format', 'stream-json', '--include-partial-messages',
      ...(input.model ? ['--model', input.model] : []),
      ...(input.reasoningEffort ? ['--effort', input.reasoningEffort] : []),
      '--mcp-config', JSON.stringify({
        mcpServers: Object.fromEntries(mcpServers.map((server) => [server.name, {
          command: server.command,
          args: server.args,
          ...(server.env ? { env: server.env } : {})
        }]))
      }),
      '--append-system-prompt', buildAgentInstructions(input),
      ...session,
      ...additionalDirectories.flatMap((directory) => ['--add-dir', directory]),
      '--tools', 'default',
      '--permission-mode', 'bypassPermissions',
      '--dangerously-skip-permissions',
      '--', input.prompt
    ]
  }
  return [
    'run', '--auto', '--format', 'json', '--thinking', '--dir', input.workingDirectory,
    ...(input.model ? ['--model', input.model] : []),
    ...(input.reasoningEffort ? ['--variant', input.reasoningEffort] : []),
    ...(input.sessionId ? ['--session', input.sessionId] : []),
    ...(input.attachments?.length ? [...input.attachments.flatMap(file => ['--file', file.path]), '--'] : []),
    input.prompt
  ]
}

export function buildCodexAppServerArgs(mcpServers: McpServerLaunchConfig[]): string[] {
  return [
    'app-server', '--stdio',
    ...mcpServers.flatMap((server) => [
      '-c', `mcp_servers.${server.name}.command=${JSON.stringify(server.command)}`,
      '-c', `mcp_servers.${server.name}.args=${JSON.stringify(server.args)}`,
      ...(server.env ? ['-c', `mcp_servers.${server.name}.env=${codexTomlStringMap(server.env)}`] : [])
    ])
  ]
}

export function buildCliEnv(
  provider: CliAgentTurnInput['provider'],
  mcpServers: McpServerLaunchConfig[],
  baseEnv: NodeJS.ProcessEnv = process.env,
  instructionsFile?: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  if (provider !== 'opencode') return env
  let existing: Record<string, unknown> = {}
  try {
    existing = baseEnv.OPENCODE_CONFIG_CONTENT ? JSON.parse(baseEnv.OPENCODE_CONFIG_CONTENT) as Record<string, unknown> : {}
  } catch {
    existing = {}
  }
  const existingMcp = existing.mcp && typeof existing.mcp === 'object' ? existing.mcp as Record<string, unknown> : {}
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...existing,
    ...(instructionsFile ? { instructions: [...(Array.isArray(existing.instructions) ? existing.instructions : []), instructionsFile] } : {}),
    permission: 'allow',
    mcp: {
      ...existingMcp,
      ...Object.fromEntries(mcpServers.map((server) => [server.name, {
        type: 'local',
        command: [server.command, ...server.args],
        ...(server.env ? { environment: server.env } : {}),
        enabled: true
      }]))
    }
  })
  return env
}

export function claudeAttachmentPrompt(input: Pick<CliAgentTurnInput, 'prompt' | 'attachments' | 'sessionId'>): string | AsyncIterable<SDKUserMessage> {
  if (!input.attachments?.length) return input.prompt
  const attachments = input.attachments
  return (async function* (): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user', session_id: input.sessionId ?? '', parent_tool_use_id: null,
      message: { role: 'user', content: [
        { type: 'text', text: attachmentPrompt(input.prompt, attachments) },
        ...attachments.filter(file => isNativeImage(file.mimeType)).map(file => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: file.mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', data: readFileSync(file.path).toString('base64') }
        }))
      ] }
    }
  })()
}

function claudeUserMessage(prompt: string, attachments: RuntimeAttachment[], sessionId: string | null, priority?: 'now'): SDKUserMessage {
  return {
    type: 'user', session_id: sessionId ?? '', parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
    message: { role: 'user', content: [
      { type: 'text', text: attachmentPrompt(prompt, attachments) },
      ...attachments.filter(file => isNativeImage(file.mimeType)).map(file => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: file.mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', data: readFileSync(file.path).toString('base64') }
      }))
    ] }
  }
}

const CLAUDE_BACKGROUND_WAIT_NOTICE_MS = 1_500

function claudeStreamMessageId(sessionId: string | null, turnIndex: number): string {
  return turnIndex === 0 ? `stream-${sessionId ?? 'new'}` : `stream-${sessionId ?? 'new'}-${turnIndex}`
}

class ClaudeInputStream implements AsyncIterable<SDKUserMessage> {
  private readonly messages: Array<{
    value: SDKUserMessage
    resolve: () => void
    reject: (error: Error) => void
  }> = []
  private readonly waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = []
  private closed = false

  push(message: SDKUserMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Claude 当前回复已结束。'))
    return new Promise<void>((resolve, reject) => {
      const waiter = this.waiters.shift()
      if (waiter) {
        waiter({ value: message, done: false })
        resolve()
      } else {
        this.messages.push({ value: message, resolve, reject })
      }
    })
  }

  close(): void {
    this.closed = true
    for (const message of this.messages.splice(0)) message.reject(new Error('Claude 当前回复已结束。'))
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const message = this.messages.shift()
        if (message) {
          message.resolve()
          return Promise.resolve({ value: message.value, done: false })
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => this.waiters.push(resolve))
      }
    }
  }
}

export class CliAgentRuntime {
  private readonly adapters = new Map<CliAgentTurnInput['provider'], CliAgentProviderRuntimeAdapter>()
  private readonly activeTurns = new Set<Promise<CliAgentTurnResult>>()

  constructor(
    private readonly mcpProvider: McpLaunchConfigProvider,
    private readonly projectAgentMcpScript?: string,
    private readonly databasePath?: string,
    private readonly providerSettings?: ProviderSettingsService,
    adapters?: CliAgentProviderRuntimeAdapter[]
  ) {
    const defaults: CliAgentProviderRuntimeAdapter[] = [
      { provider: 'codex', runTurn: (input, servers) => this.runCodexAppServer(input, servers) },
      { provider: 'claude', runTurn: (input, servers) => this.runClaudeSdk(input, servers) },
      { provider: 'opencode', runTurn: (input, servers) => this.runOpenCode(input, servers) }
    ]
    for (const adapter of adapters ?? defaults) this.registerAdapter(adapter)
  }

  registerAdapter(adapter: CliAgentProviderRuntimeAdapter): void {
    if (this.adapters.has(adapter.provider)) throw new Error(`CLI agent provider already registered: ${adapter.provider}`)
    this.adapters.set(adapter.provider, adapter)
  }

  async runTurn(input: CliAgentTurnInput): Promise<CliAgentTurnResult> {
    throwIfCancelled(input.abortController.signal)
    const configuredModel = input.model?.trim() || this.providerSettings?.getCodingAgentDefaultModel(input.provider)
    const configuredReasoningEffort = input.reasoningEffort?.trim()
      || this.providerSettings?.getCodingAgentDefaultReasoningEffort(input.provider)
    const resolvedInput = {
      ...input,
      model: configuredModel || null,
      reasoningEffort: configuredReasoningEffort || null
    }
    const scope = `${input.provider}-${input.sessionId ?? crypto.randomUUID()}`
    const mcpServers = await this.mcpProvider.getLaunchConfigs(scope)
    if (input.projectId && this.projectAgentMcpScript && this.databasePath) {
      mcpServers.push({
        name: 'project_agent',
        command: process.execPath,
        args: [this.projectAgentMcpScript],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          PROJECT_AGENT_DB_PATH: this.databasePath,
          PROJECT_AGENT_PROJECT_ID: input.projectId
        }
      })
    }
    const adapter = this.adapters.get(resolvedInput.provider)
    if (!adapter) throw new Error(`CLI agent provider is not registered: ${resolvedInput.provider}`)
    throwIfCancelled(input.abortController.signal)
    const turn = adapter.runTurn(resolvedInput, mcpServers)
    this.activeTurns.add(turn)
    try {
      return await turn
    } finally {
      this.activeTurns.delete(turn)
    }
  }

  async stopAndDrain(): Promise<void> {
    await Promise.allSettled([...this.activeTurns])
  }

  private async runClaudeSdk(
    input: CliAgentTurnInput,
    mcpServers: McpServerLaunchConfig[]
  ): Promise<CliAgentTurnResult> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    const executable = resolveCliBinary('claude')
    const additionalDirectories = codingAgentRuntimeRoots(input)
      .filter((directory) => directory !== input.workingDirectory)
    let sessionId = input.sessionId
    let streamedText = ''
    let finalText = ''
    // Background subagents wake Claude Code for follow-up turns after the first
    // `result`. Newer CLIs report `session_state_changed: idle` only once that
    // work has settled; older CLIs keep the one-result-per-turn behavior.
    let reportsSessionState = false
    let turnIndex = 0
    let turnCompleted = false
    let liveBackgroundTasks: string[] = []
    let backgroundWait: { id: string; detail: string } | null = null
    let backgroundWaitTimer: NodeJS.Timeout | null = null
    const finishBackgroundWait = (): void => {
      if (backgroundWaitTimer) clearTimeout(backgroundWaitTimer)
      backgroundWaitTimer = null
      if (!backgroundWait) return
      input.onUpdate({ type: 'tool', toolCallId: backgroundWait.id, toolName: '后台任务', status: 'completed', detail: backgroundWait.detail })
      backgroundWait = null
    }
    const pendingTools = new Map<string, { name: string; detail: string; metadata: JsonRecord }>()
    let accountContext = emptyAccountContext('claude', input.model)
    input.onAccountContext?.(accountContext)
    input.onUpdate({ type: 'status', status: 'running', detail: '正在通过 Claude Agent SDK 启动 Claude Code' })
    const inputStream = new ClaudeInputStream()
    void inputStream.push(claudeUserMessage(input.prompt, input.attachments ?? [], sessionId)).catch(() => undefined)
    const stream = query({
      prompt: inputStream,
      options: {
        abortController: input.abortController,
        cwd: input.workingDirectory,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: buildAgentInstructions(input) },
        ...(input.model ? { model: input.model } : {}),
        ...claudeSdkReasoningOptions(input.reasoningEffort),
        ...(input.sessionId ? { resume: input.sessionId } : {}),
        pathToClaudeCodeExecutable: executable,
        env: { ...buildCliEnv('claude', mcpServers), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
        additionalDirectories,
        includePartialMessages: true,
        thinking: { type: 'adaptive', display: 'summarized' },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['user', 'project', 'local'],
        mcpServers: Object.fromEntries(mcpServers.map((server) => [server.name, {
          type: 'stdio' as const,
          command: server.command,
          args: server.args,
          ...(server.env ? { env: server.env } : {})
        }]))
      }
    })
    try {
    for await (const message of stream) {
      const record = message as unknown as JsonRecord
      if (['assistant', 'user', 'stream_event', 'tool_progress', 'result'].includes(textValue(record.type))) input.onActivity?.()
      if (record.type === 'system' && record.subtype === 'session_state_changed') {
        reportsSessionState = true
        if (record.state === 'idle') break
      }
      if (record.type === 'system' && record.subtype === 'background_tasks_changed' && Array.isArray(record.tasks)) {
        liveBackgroundTasks = record.tasks
          .map(task => task && typeof task === 'object' ? textValue((task as JsonRecord).description) || textValue((task as JsonRecord).task_id) : '')
          .filter(Boolean)
      }
      if (turnCompleted && ['assistant', 'stream_event'].includes(textValue(record.type)) && !record.parent_tool_use_id) {
        turnCompleted = false
        turnIndex += 1
        streamedText = ''
        finishBackgroundWait()
      }
      if (record.type === 'system' && record.subtype === 'init') {
        const account = await optionalAccountMetadata(() => stream.accountInfo())
        accountContext = { ...accountContext, ...claudeAccountContext(account ?? { apiKeySource: record.apiKeySource }), ...claudeModelContext(record), observedAt: new Date().toISOString() }
        input.onAccountContext?.(accountContext)
        input.onSteerReady?.(async (prompt, attachments) => {
          if (input.abortController.signal.aborted) throw new Error('Claude 当前回复已停止。')
          await inputStream.push(claudeUserMessage(prompt, attachments, sessionId, 'now'))
        })
      }
      if (record.type === 'rate_limit_event') {
        const limit = claudeLimitContext(record.rate_limit_info)
        if (limit) {
          accountContext = { ...accountContext, limits: [...accountContext.limits.filter(item => item.name !== limit.name), limit].slice(-32), observedAt: new Date().toISOString() }
          input.onAccountContext?.(accountContext)
        }
      }
      if (record.type === 'result') {
        accountContext = { ...accountContext, turnUsage: claudeTurnUsage(record), observedAt: new Date().toISOString() }
        input.onAccountContext?.(accountContext)
      }
      const found = recordSessionId(record)
      if (found && found !== sessionId) {
        sessionId = found
        input.onSessionId(found)
      }
      // Subagent stream events carry `parent_tool_use_id`; only the main
      // thread's text belongs in this Run's reply.
      const parsed = record.parent_tool_use_id ? {} as ParsedCliRecord : claudeRecord(record)
      if (parsed.reasoning) input.onUpdate({
        type: 'reasoning_delta',
        segmentId: parsed.reasoningSegmentId,
        delta: parsed.reasoning
      })
      if (record.type === 'assistant' && record.message && typeof record.message === 'object') {
        const content = (record.message as JsonRecord).content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== 'object') continue
            const tool = block as JsonRecord
            if (tool.type !== 'tool_use') continue
            const name = textValue(tool.name) || 'tool'
            const detail = JSON.stringify(tool.input ?? {}).slice(0, 4_000)
            input.onUpdate({
              type: 'tool',
              toolCallId: textValue(tool.id) || undefined,
              toolName: name,
              status: 'running',
              detail
            })
            const toolCallId = textValue(tool.id)
            if (toolCallId) pendingTools.set(toolCallId, { name, detail, metadata: tool })
          }
        }
      }
      if (record.type === 'user' && record.message && typeof record.message === 'object') {
        const content = (record.message as JsonRecord).content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== 'object') continue
            const result = block as JsonRecord
            if (result.type !== 'tool_result') continue
            const toolCallId = textValue(result.tool_use_id)
            const pendingTool = pendingTools.get(toolCallId)
            if (!pendingTool) continue
            const status = result.is_error === true ? 'failed' : 'completed'
            const output = typeof result.content === 'string'
              ? result.content
              : JSON.stringify(result.content ?? '')
            const detail = [pendingTool.detail, output].filter(Boolean).join('\n\n').slice(0, 4_000)
            input.onUpdate({
              type: 'tool',
              toolCallId,
              toolName: pendingTool.name,
              status,
              detail
            })
            input.onTool(pendingTool.name, detail, {
              ...pendingTool.metadata,
              status,
              output: output.slice(0, 4_000)
            })
            pendingTools.delete(toolCallId)
          }
        }
      }
      if (parsed.assistant) {
        if (record.type === 'stream_event') {
          streamedText += parsed.assistant
          input.onUpdate({ type: 'message_delta', messageId: claudeStreamMessageId(sessionId, turnIndex), delta: parsed.assistant })
        } else if (record.type === 'result') {
          finalText = parsed.assistant
          if (!streamedText) input.onUpdate({ type: 'message_delta', messageId: claudeStreamMessageId(sessionId, turnIndex), delta: parsed.assistant })
        }
      }
      if (record.type === 'result' && record.is_error === true) {
        const errors = Array.isArray(record.errors) ? record.errors.map(String).join('; ') : textValue(record.result)
        throw new Error(errors || 'Claude Code 执行失败。')
      }
      if (record.type === 'result') {
        if (!reportsSessionState) break
        turnCompleted = true
        if (liveBackgroundTasks.length > 0 && !backgroundWaitTimer && !backgroundWait) {
          // Only surface the wait when Claude does not go idle right away
          // (background shells never delay idle; subagents do).
          backgroundWaitTimer = setTimeout(() => {
            backgroundWaitTimer = null
            backgroundWait = {
              id: `claude-background-${sessionId ?? 'new'}-${turnIndex}`,
              detail: `等待完成：${liveBackgroundTasks.join('；')}`.slice(0, 4_000)
            }
            // A running tool keeps the inactivity watchdog from stopping a
            // silent subagent while the main thread waits for its result.
            input.onUpdate({ type: 'tool', toolCallId: backgroundWait.id, toolName: '后台任务', status: 'running', detail: backgroundWait.detail })
          }, CLAUDE_BACKGROUND_WAIT_NOTICE_MS)
        }
      }
    }
    } finally {
      finishBackgroundWait()
      input.onSteerReady?.(null)
      inputStream.close()
      stream.close?.()
    }
    const text = (finalText || streamedText).trim()
    if (!text) throw new Error('Claude Code 没有返回 Agent 消息。')
    return { text, sessionId }
  }

  private async runCodexAppServer(
    input: CliAgentTurnInput,
    mcpServers: McpServerLaunchConfig[]
  ): Promise<CliAgentTurnResult> {
    const binary = resolveCliBinary('codex')
    throwIfCancelled(input.abortController.signal)
    const args = buildCodexAppServerArgs(mcpServers)
    input.onUpdate({ type: 'status', status: 'running', detail: '正在通过 Codex app-server 启动 Session' })
    return await new Promise<CliAgentTurnResult>((resolve, reject) => {
      const child = spawn(binary, args, {
        cwd: input.workingDirectory,
        env: { ...process.env, PWD: input.workingDirectory },
        detached: process.platform !== 'win32'
      })
      let buffer = ''
      let stderr = ''
      let nextId = 1
      let sessionId = input.sessionId
      let activeTurnId: string | null = null
      let finalAnswerText = ''
      let legacyText = ''
      let lastAgentMessageText = ''
      const streamedAgentMessages = new Map<string, string>()
      const agentMessagePhases = new Map<string, 'commentary' | 'final_answer' | null>()
      let settled = false
      let accountContext = emptyAccountContext('codex', input.model)
      const publishContext = (patch: Partial<AgentAccountContext>): void => {
        if (settled) return
        accountContext = { ...accountContext, ...patch, observedAt: new Date().toISOString() }
        if (accountContext.apiProvider && accountContext.apiProvider !== 'openai') {
          accountContext = { ...accountContext, authMode: 'unknown', plan: undefined, limits: [] }
        }
        input.onAccountContext?.(accountContext)
      }
      publishContext({})
      const pending = new Map<number, { resolve: (value: JsonRecord) => void; reject: (error: Error) => void }>()
      const write = (record: JsonRecord): void => {
        child.stdin.write(`${JSON.stringify(record)}\n`)
      }
      const request = (method: string, params: JsonRecord): Promise<JsonRecord> => {
        if (settled) return Promise.reject(new Error('Codex 连接已关闭。'))
        if (input.abortController.signal.aborted) return Promise.reject(input.abortController.signal.reason)
        const id = nextId++
        return new Promise((requestResolve, requestReject) => {
          pending.set(id, { resolve: requestResolve, reject: requestReject })
          write({ id, method, params })
        })
      }
      const closePending = (): void => {
        for (const entry of pending.values()) entry.reject(new Error('Codex 连接已关闭。'))
        pending.clear()
      }
      const finishError = (error: Error): void => {
        if (settled) return
        settled = true
        input.onSteerReady?.(null)
        closePending()
        input.abortController.signal.removeEventListener('abort', abortChild)
        void terminateProcessTree(child).then(() => reject(codexSessionError(error)), reject)
      }
      const abortChild = (): void => finishError(input.abortController.signal.reason instanceof Error
        ? input.abortController.signal.reason
        : new Error('Chat 已停止。'))
      input.abortController.signal.addEventListener('abort', abortChild, { once: true })
      const finishSuccess = (): void => {
        if (settled) return
        const text = (finalAnswerText || legacyText || lastAgentMessageText).trim()
        if (!text) return finishError(new Error('Codex app-server 没有返回 Agent 消息。'))
        settled = true
        input.onSteerReady?.(null)
        closePending()
        input.abortController.signal.removeEventListener('abort', abortChild)
        void terminateProcessTree(child).then(() => resolve({ text, sessionId }), reject)
      }
      const handleApproval = (record: JsonRecord): void => {
        const method = textValue(record.method)
        const serverId = record.id
        if ((typeof serverId !== 'number' && typeof serverId !== 'string') || !method.endsWith('/requestApproval')) return
        write({ id: serverId, result: { decision: 'accept' } })
      }
      const processLine = (line: string): void => {
        if (settled) return
        if (!line.trim()) return
        let record: JsonRecord
        try { record = JSON.parse(line) as JsonRecord } catch { return }
        if (typeof record.id === 'number' && !record.method) {
          const waiter = pending.get(record.id)
          if (!waiter) return
          pending.delete(record.id)
          if (record.error && typeof record.error === 'object') waiter.reject(new Error(textValue((record.error as JsonRecord).message) || 'Codex app-server 请求失败。'))
          else waiter.resolve(record.result && typeof record.result === 'object' ? record.result as JsonRecord : {})
          return
        }
        const method = textValue(record.method)
        if (method.endsWith('/requestApproval')) {
          handleApproval(record)
          return
        }
        const params = record.params && typeof record.params === 'object' ? record.params as JsonRecord : {}
        if (method === 'turn/started' && params.turn && typeof params.turn === 'object') {
          activeTurnId = textValue((params.turn as JsonRecord).id) || activeTurnId
        }
        // Progress can arrive without visible text, especially with summary=none.
        // Only signal receipt; do not persist or render private reasoning data.
        if (params.threadId === sessionId && (
          method === 'item/started' || method === 'item/completed'
          || method === 'item/agentMessage/delta' || method === 'item/plan/delta'
          || method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta'
          || method === 'item/mcpToolCall/progress'
          || method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/summaryPartAdded'
          || method === 'item/reasoning/textDelta'
          || method === 'turn/started' || method === 'turn/plan/updated' || method === 'turn/diff/updated'
          || (method === 'error' && params.willRetry === true)
        )) input.onActivity?.()
        if (method === 'account/rateLimits/updated') publishContext(codexLimitContext(params))
        if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          const messageId = textValue(params.itemId) || textValue(params.item_id) || `stream-${sessionId ?? 'new'}`
          const phase = agentMessagePhases.get(messageId) ?? null
          streamedAgentMessages.set(messageId, (streamedAgentMessages.get(messageId) ?? '') + params.delta)
          if (phase === 'final_answer') finalAnswerText += params.delta
          else if (phase === null) legacyText += params.delta
          input.onUpdate({ type: 'message_delta', messageId, delta: params.delta, phase })
        }
        if (method === 'item/started' && params.item && typeof params.item === 'object') {
          const item = params.item as JsonRecord
          const itemId = textValue(item.id)
          if (item.type === 'agentMessage' && itemId) agentMessagePhases.set(itemId, codexAgentMessagePhase(item))
          const tool = codexAppServerToolRecord(item)
          if (tool) input.onUpdate({
            type: 'tool',
            toolCallId: tool.id,
            toolName: tool.name,
            status: 'running',
            detail: tool.detail
          })
        }
        if (method === 'item/completed' && params.item && typeof params.item === 'object') {
          const item = params.item as JsonRecord
          if (item.type === 'agentMessage' && typeof item.text === 'string') {
            const messageId = textValue(item.id) || `stream-${sessionId ?? 'new'}`
            const phase = codexAgentMessagePhase(item)
            const emitted = streamedAgentMessages.get(messageId) ?? ''
            const delta = emitted
              ? item.text.startsWith(emitted) ? item.text.slice(emitted.length) : ''
              : item.text
            agentMessagePhases.set(messageId, phase)
            lastAgentMessageText = item.text
            if (phase === 'final_answer') finalAnswerText = item.text
            else if (phase === null) legacyText = item.text
            if (delta) {
              streamedAgentMessages.set(messageId, emitted + delta)
              input.onUpdate({ type: 'message_delta', messageId, delta, phase })
            }
          }
          const tool = codexAppServerToolRecord(item)
          if (tool) {
            input.onUpdate({
              type: 'tool',
              toolCallId: tool.id,
              toolName: tool.name,
              status: tool.status,
              detail: tool.detail
            })
            input.onTool(tool.name, tool.detail, { ...item, status: tool.status })
          }
        }
        if (method === 'turn/completed') {
          const turn = params.turn && typeof params.turn === 'object' ? params.turn as JsonRecord : {}
          const error = turn.error && typeof turn.error === 'object' ? turn.error as JsonRecord : {}
          if (turn.status === 'failed') finishError(new Error(textValue(error.message) || 'Codex Turn 执行失败。'))
          else finishSuccess()
        }
      }
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          processLine(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
        }
      })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      child.stdin.on('error', error => finishError(error))
      child.on('error', (error) => finishError((error as NodeJS.ErrnoException).code === 'ENOENT'
        ? new Error('codex CLI 未安装或不在 PATH 中。请先在终端安装并登录。')
        : error))
      child.on('close', (code) => {
        input.abortController.signal.removeEventListener('abort', abortChild)
        if (buffer.trim()) processLine(buffer)
        if (!settled) finishError(new Error(stderr.trim() || `codex app-server 退出，code ${code ?? 'unknown'}`))
      })
      void (async () => {
        await request('initialize', {
          clientInfo: { name: 'project-agent', title: 'Fuddy', version: '0.1.0' },
          capabilities: { experimentalApi: true }
        })
        write({ method: 'initialized', params: {} })
        // Read-only metadata is opportunistic; it never gates thread/turn creation.
        void optionalAccountMetadata(() => request('account/read', { refreshToken: false })).then(value => { if (value) publishContext(codexAccountContext(value)) })
        void optionalAccountMetadata(() => request('account/rateLimits/read', {})).then(value => { if (value) publishContext(codexLimitContext(value)) })
        const runtimeWorkspaceRoots = codingAgentRuntimeRoots(input)
        if (input.sessionId && !input.codexSessionOwned) {
          input.onUpdate({ type: 'status', status: 'running', detail: '正在迁移历史，为 Fuddy 创建独立会话' })
        }
        const prepared = await prepareCodexSession({
          request,
          runId: input.runId ?? input.sessionId ?? 'standalone',
          sessionId: input.sessionId,
          owned: input.codexSessionOwned === true,
          history: input.history ?? [],
          checkCancelled: () => throwIfCancelled(input.abortController.signal),
          params: {
            cwd: input.workingDirectory, approvalPolicy: CODEX_APPROVAL_POLICY, sandbox: CODEX_THREAD_SANDBOX,
            ...(input.model ? { model: input.model } : {}),
            runtimeWorkspaceRoots,
            developerInstructions: buildAgentInstructions(input)
          }
        })
        const threadResult = prepared.result
        const thread = threadResult.thread && typeof threadResult.thread === 'object' ? threadResult.thread as JsonRecord : {}
        publishContext(codexExecutionContext(threadResult))
        const found = textValue(thread.id) || input.sessionId
        if (!found) throw new Error('Codex app-server 没有返回 thread id。')
        sessionId = found
        if (prepared.ready && input.onCodexSessionReady) input.onCodexSessionReady(prepared.ready)
        else if (found !== input.sessionId) input.onSessionId(found)
        throwIfCancelled(input.abortController.signal)
        const started = await request('turn/start', buildCodexTurnStartParams(found, input.prompt, input.reasoningEffort, input.attachments))
        const startedTurn = started.turn && typeof started.turn === 'object' ? started.turn as JsonRecord : {}
        activeTurnId = textValue(startedTurn.id) || activeTurnId
        if (activeTurnId) input.onSteerReady?.(async (prompt, attachments, requestId) => {
          if (!activeTurnId || settled) throw new Error('Codex 当前回复已结束。')
          const response = await request('turn/steer', buildCodexTurnSteerParams(found, activeTurnId, requestId, prompt, attachments))
          if (textValue(response.turnId) !== activeTurnId) throw new Error('Codex 未接受这条 Steer 消息。')
        })
      })().catch(finishError)
    })
  }

  private async runOpenCode(input: CliAgentTurnInput, mcpServers: McpServerLaunchConfig[]): Promise<CliAgentTurnResult> {
    // Per-turn config instructions refresh resumed sessions without adding
    // background to user messages or changing the user's Agent configuration.
    const directory = await mkdtemp(join(tmpdir(), 'fuddy-agent-instructions-'))
    try {
      const file = join(directory, 'context.md')
      await writeFile(file, [buildAgentInstructions(input), buildAdditionalWorkspaceContext(input)].filter(Boolean).join('\n\n'), { mode: 0o600 })
      throwIfCancelled(input.abortController.signal)
      return await this.runJsonCli(input, mcpServers, file)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  private async runJsonCli(input: CliAgentTurnInput, mcpServers: McpServerLaunchConfig[], instructionsFile: string): Promise<CliAgentTurnResult> {
    const binary = resolveCliBinary(input.provider)
    const args = buildCliArgs(input, mcpServers)
    let latestSessionId = input.sessionId
    let buffer = ''
    let finalText = ''
    const persistedToolIds = new Set<string>()
    let accountContext = emptyAccountContext('opencode', input.model)
    input.onAccountContext?.(accountContext)
    const usageStepIds = new Set<string>()

    input.onUpdate({ type: 'status', status: 'running', detail: `正在启动 ${input.provider} CLI` })

    return await new Promise<CliAgentTurnResult>((resolve, reject) => {
      const child = spawn(binary, args, {
        cwd: input.workingDirectory,
        env: { ...buildCliEnv(input.provider, mcpServers, process.env, instructionsFile), PWD: input.workingDirectory },
        detached: process.platform !== 'win32'
      })
      const stderr: Buffer[] = []
      let settled = false
      const finishError = (error: Error): void => {
        if (settled) return
        settled = true
        input.abortController.signal.removeEventListener('abort', abortChild)
        void terminateProcessTree(child).then(() => reject(error), reject)
      }
      const abortChild = (): void => finishError(input.abortController.signal.reason instanceof Error
        ? input.abortController.signal.reason
        : new Error('Chat 已停止。'))
      input.abortController.signal.addEventListener('abort', abortChild, { once: true })

      const processLine = (line: string): void => {
        const trimmed = line.trim()
        if (!trimmed) return
        let record: JsonRecord
        try {
          record = JSON.parse(trimmed) as JsonRecord
        } catch {
          return
        }
        const foundSessionId = recordSessionId(record)
        if (foundSessionId && foundSessionId !== latestSessionId) {
          latestSessionId = foundSessionId
          input.onSessionId(foundSessionId)
        }
        const parsed = opencodeRecord(record)
        if (['text', 'reasoning', 'tool_use', 'step_start', 'step_finish'].includes(textValue(record.type))) input.onActivity?.()
        const usage = opencodeStepUsage(record)
        const part = record.part && typeof record.part === 'object' ? record.part as JsonRecord : {}
        const stepId = textValue(part.id)
        if (usage && stepId && !usageStepIds.has(stepId)) {
          usageStepIds.add(stepId)
          const previous = accountContext.turnUsage
          const add = (key: 'inputTokens' | 'outputTokens' | 'estimatedCostUsd'): number | undefined =>
            usage[key] === undefined ? previous?.[key] : (previous?.[key] ?? 0) + usage[key]!
          accountContext = { ...accountContext, observedAt: new Date().toISOString(), turnUsage: {
            inputTokens: add('inputTokens'), outputTokens: add('outputTokens'), estimatedCostUsd: add('estimatedCostUsd')
          } }
          input.onAccountContext?.(accountContext)
        }
        if (parsed.reasoning) input.onUpdate({
          type: 'reasoning_delta',
          segmentId: parsed.reasoningSegmentId,
          delta: parsed.reasoning
        })
        if (parsed.tool) {
          input.onUpdate({
            type: 'tool',
            toolCallId: parsed.tool.id,
            toolName: parsed.tool.name,
            status: parsed.tool.status,
            detail: parsed.tool.detail
          })
          if (parsed.tool.status !== 'running') {
            const persistenceKey = parsed.tool.id ?? `${parsed.tool.name}:${parsed.tool.detail}`
            if (!persistedToolIds.has(persistenceKey)) {
              persistedToolIds.add(persistenceKey)
              input.onTool(parsed.tool.name, parsed.tool.detail, { ...record, status: parsed.tool.status })
            }
          }
        }
        if (parsed.assistant) {
          finalText = parsed.assistant
          input.onUpdate({ type: 'message_delta', messageId: `stream-${latestSessionId ?? 'new'}`, delta: parsed.assistant })
        }
      }

      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          processLine(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
        }
      })
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          finishError(new Error(`${input.provider} CLI 未安装或不在 PATH 中。请先在终端安装并登录。`))
          return
        }
        finishError(error)
      })
      child.on('close', (code) => {
        if (settled) return
        if (buffer.trim()) processLine(buffer)
        const errorText = Buffer.concat(stderr).toString('utf8').trim()
        if (code !== 0) {
          finishError(new Error(errorText || `${basename(binary)} CLI 退出，code ${code ?? 'unknown'}`))
          return
        }
        const text = finalText.trim()
        if (!text) {
          finishError(new Error(`${input.provider} CLI 没有返回 Agent 消息。`))
          return
        }
        settled = true
        input.abortController.signal.removeEventListener('abort', abortChild)
        resolve({ text, sessionId: latestSessionId })
      })
      // OpenCode reads piped stdin before starting even when the prompt is
      // already in argv. An open pipe leaves it waiting forever for EOF.
      child.stdin?.end()
    })
  }
}
