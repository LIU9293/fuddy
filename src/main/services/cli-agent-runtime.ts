import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import type { AgentApprovalDecision, AgentApprovalRequest, AgentRunProvider, AgentRunStreamUpdate } from '../../shared/contracts'
import { resolveCliBinary } from './cli-executables'
import type { ProviderSettingsService } from './provider-settings'
import type { McpServerLaunchConfig } from './third-party-mcp-runtime'

export interface McpLaunchConfigProvider {
  getLaunchConfigs(scope?: string): Promise<McpServerLaunchConfig[]>
}

export interface CliAgentTurnInput {
  projectId: string | null
  provider: Exclude<AgentRunProvider, 'pi'>
  /** Empty or omitted means the coding agent's own configured default. */
  model?: string | null
  prompt: string
  sessionId: string | null
  workingDirectory: string
  workspaceRoots: string[]
  filesDirectory: string
  abortController: AbortController
  onUpdate: (update: AgentRunStreamUpdate) => void
  onSessionId: (sessionId: string) => void
  onTool: (toolName: string, detail: string, metadata?: Record<string, unknown>) => void
  onApproval: (request: Omit<AgentApprovalRequest, 'runId' | 'createdAt'>) => Promise<AgentApprovalDecision>
}

export interface CliAgentTurnResult {
  text: string
  sessionId: string | null
}

type JsonRecord = Record<string, unknown>

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function codexTomlStringMap(values: Record<string, string>): string {
  const entries = Object.entries(values).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
  return `{ ${entries.join(', ')} }`
}

function recordSessionId(record: JsonRecord): string | null {
  return textValue(record.thread_id) || textValue(record.session_id) || textValue(record.sessionID) || null
}

function codexRecord(record: JsonRecord): {
  assistant?: string
  tool?: { name: string; detail: string }
} {
  const item = record.item && typeof record.item === 'object' ? record.item as JsonRecord : null
  if (!item) return {}
  const itemType = textValue(item.type)
  if (itemType === 'agent_message') return { assistant: textValue(item.text) }
  if (itemType === 'command_execution') {
    const command = textValue(item.command)
    const output = textValue(item.aggregated_output)
    return { tool: { name: 'command', detail: [command, output].filter(Boolean).join('\n').slice(0, 4_000) } }
  }
  if (itemType && itemType !== 'reasoning') {
    return { tool: { name: itemType, detail: textValue(item.text) || textValue(item.status) || itemType } }
  }
  return {}
}

function claudeRecord(record: JsonRecord): { assistant?: string; tool?: { name: string; detail: string } } {
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
      if (delta.type === 'text_delta') return { assistant: textValue(delta.text) }
    }
  }
  return {}
}

function opencodeRecord(record: JsonRecord): { assistant?: string; tool?: { name: string; detail: string } } {
  const part = record.part && typeof record.part === 'object' ? record.part as JsonRecord : record
  if (part.type === 'text') return { assistant: textValue(part.text) }
  if (part.type === 'tool') {
    return { tool: { name: textValue(part.tool) || 'tool', detail: JSON.stringify(part.state ?? part).slice(0, 4_000) } }
  }
  return {}
}

export function buildCliArgs(input: CliAgentTurnInput, mcpServers: McpServerLaunchConfig[]): string[] {
  const additionalDirectories = [...new Set([...input.workspaceRoots, input.filesDirectory])]
    .filter((directory) => directory !== input.workingDirectory)
  if (input.provider === 'codex') {
    const common = [
      'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
      ...(input.model ? ['--model', input.model] : []),
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
      '--mcp-config', JSON.stringify({
        mcpServers: Object.fromEntries(mcpServers.map((server) => [server.name, {
          command: server.command,
          args: server.args,
          ...(server.env ? { env: server.env } : {})
        }]))
      }),
      '--append-system-prompt', `这是 Project Agent 中的代码 Session。工作目录是 ${input.workingDirectory}，项目产物目录是 ${input.filesDirectory}。`,
      ...session,
      ...additionalDirectories.flatMap((directory) => ['--add-dir', directory]),
      '--tools', 'default',
      '--permission-mode', 'bypassPermissions',
      '--dangerously-skip-permissions',
      '--', input.prompt
    ]
  }
  return [
    'run', '--auto', '--format', 'json', '--dir', input.workingDirectory,
    ...(input.model ? ['--model', input.model] : []),
    ...(input.sessionId ? ['--session', input.sessionId] : []),
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
  baseEnv: NodeJS.ProcessEnv = process.env
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

export class CliAgentRuntime {
  constructor(
    private readonly mcpProvider: McpLaunchConfigProvider,
    private readonly projectAgentMcpScript?: string,
    private readonly databasePath?: string,
    private readonly providerSettings?: ProviderSettingsService
  ) {}

  async runTurn(input: CliAgentTurnInput): Promise<CliAgentTurnResult> {
    const configuredModel = input.model?.trim() || this.providerSettings?.getCodingAgentDefaultModel(input.provider)
    const resolvedInput = { ...input, model: configuredModel || null }
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
    if (resolvedInput.provider === 'codex') return await this.runCodexAppServer(resolvedInput, mcpServers)
    if (resolvedInput.provider === 'claude') return await this.runClaudeSdk(resolvedInput, mcpServers)
    return await this.runJsonCli(resolvedInput, mcpServers)
  }

  private async runClaudeSdk(
    input: CliAgentTurnInput,
    mcpServers: McpServerLaunchConfig[]
  ): Promise<CliAgentTurnResult> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    const executable = resolveCliBinary('claude')
    let sessionId = input.sessionId
    let streamedText = ''
    let finalText = ''
    input.onUpdate({ type: 'status', status: 'running', detail: '正在通过 Claude Agent SDK 启动 Claude Code' })
    const stream = query({
      prompt: input.prompt,
      options: {
        abortController: input.abortController,
        cwd: input.workingDirectory,
        ...(input.model ? { model: input.model } : {}),
        ...(input.sessionId ? { resume: input.sessionId } : {}),
        pathToClaudeCodeExecutable: executable,
        env: buildCliEnv('claude', mcpServers),
        additionalDirectories: [input.filesDirectory],
        includePartialMessages: true,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['user', 'project'],
        mcpServers: Object.fromEntries(mcpServers.map((server) => [server.name, {
          type: 'stdio' as const,
          command: server.command,
          args: server.args,
          ...(server.env ? { env: server.env } : {})
        }]))
      }
    })
    for await (const message of stream) {
      const record = message as unknown as JsonRecord
      const found = recordSessionId(record)
      if (found && found !== sessionId) {
        sessionId = found
        input.onSessionId(found)
      }
      const parsed = claudeRecord(record)
      if (record.type === 'assistant' && record.message && typeof record.message === 'object') {
        const content = (record.message as JsonRecord).content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== 'object') continue
            const tool = block as JsonRecord
            if (tool.type !== 'tool_use') continue
            const name = textValue(tool.name) || 'tool'
            const detail = JSON.stringify(tool.input ?? {}).slice(0, 4_000)
            input.onUpdate({ type: 'tool', toolName: name, status: 'running', detail })
            input.onTool(name, detail, tool)
          }
        }
      }
      if (parsed.assistant) {
        if (record.type === 'stream_event') {
          streamedText += parsed.assistant
          input.onUpdate({ type: 'message_delta', messageId: `stream-${sessionId ?? 'new'}`, delta: parsed.assistant })
        } else if (record.type === 'result') {
          finalText = parsed.assistant
          if (!streamedText) input.onUpdate({ type: 'message_delta', messageId: `stream-${sessionId ?? 'new'}`, delta: parsed.assistant })
        }
      }
      if (record.type === 'result' && record.is_error === true) {
        const errors = Array.isArray(record.errors) ? record.errors.map(String).join('; ') : textValue(record.result)
        throw new Error(errors || 'Claude Code 执行失败。')
      }
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
    const args = buildCodexAppServerArgs(mcpServers)
    input.onUpdate({ type: 'status', status: 'running', detail: '正在通过 Codex app-server 启动 Session' })
    return await new Promise<CliAgentTurnResult>((resolve, reject) => {
      const child = spawn(binary, args, {
        cwd: input.workingDirectory,
        env: { ...process.env, PWD: input.workingDirectory }
      })
      let buffer = ''
      let stderr = ''
      let nextId = 1
      let sessionId = input.sessionId
      let streamedText = ''
      let settled = false
      const pending = new Map<number, { resolve: (value: JsonRecord) => void; reject: (error: Error) => void }>()
      const write = (record: JsonRecord): void => {
        child.stdin.write(`${JSON.stringify(record)}\n`)
      }
      const request = (method: string, params: JsonRecord): Promise<JsonRecord> => {
        const id = nextId++
        write({ id, method, params })
        return new Promise((requestResolve, requestReject) => pending.set(id, { resolve: requestResolve, reject: requestReject }))
      }
      const finishError = (error: Error): void => {
        if (settled) return
        settled = true
        child.kill()
        reject(error)
      }
      const abortChild = (): void => finishError(input.abortController.signal.reason instanceof Error
        ? input.abortController.signal.reason
        : new Error('Agent Run 已停止。'))
      input.abortController.signal.addEventListener('abort', abortChild, { once: true })
      const finishSuccess = (): void => {
        if (settled) return
        const text = streamedText.trim()
        if (!text) return finishError(new Error('Codex app-server 没有返回 Agent 消息。'))
        settled = true
        input.abortController.signal.removeEventListener('abort', abortChild)
        child.kill()
        resolve({ text, sessionId })
      }
      const handleApproval = (record: JsonRecord): void => {
        const method = textValue(record.method)
        const serverId = record.id
        if ((typeof serverId !== 'number' && typeof serverId !== 'string') || !method.endsWith('/requestApproval')) return
        write({ id: serverId, result: { decision: 'accept' } })
      }
      const processLine = (line: string): void => {
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
        if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          streamedText += params.delta
          input.onUpdate({ type: 'message_delta', messageId: `stream-${sessionId ?? 'new'}`, delta: params.delta })
        }
        if (method === 'item/completed' && params.item && typeof params.item === 'object') {
          const item = params.item as JsonRecord
          if (item.type === 'agentMessage' && !streamedText && typeof item.text === 'string') streamedText = item.text
          if (item.type === 'commandExecution') {
            const detail = [textValue(item.command), textValue(item.aggregatedOutput)].filter(Boolean).join('\n').slice(0, 4_000)
            input.onUpdate({ type: 'tool', toolName: 'command', status: item.status === 'failed' ? 'failed' : 'completed', detail })
            input.onTool('command', detail, item)
          }
        }
        if (method === 'turn/completed') {
          const turn = params.turn && typeof params.turn === 'object' ? params.turn as JsonRecord : {}
          if (turn.status === 'failed') finishError(new Error('Codex Turn 执行失败。'))
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
          clientInfo: { name: 'project-agent', title: 'Project Agent', version: '0.1.0' },
          capabilities: { experimentalApi: true }
        })
        write({ method: 'initialized', params: {} })
        const threadResult = input.sessionId
          ? await request('thread/resume', {
              threadId: input.sessionId, cwd: input.workingDirectory, approvalPolicy: 'never',
              ...(input.model ? { model: input.model } : {}),
              sandbox: 'dangerFullAccess', runtimeWorkspaceRoots: [input.workingDirectory, input.filesDirectory]
            })
          : await request('thread/start', {
              cwd: input.workingDirectory, approvalPolicy: 'never', sandbox: 'dangerFullAccess',
              ...(input.model ? { model: input.model } : {}),
              runtimeWorkspaceRoots: [input.workingDirectory, input.filesDirectory],
              developerInstructions: `这是 Project Agent 中的代码 Session。项目产物目录是 ${input.filesDirectory}。`
            })
        const thread = threadResult.thread && typeof threadResult.thread === 'object' ? threadResult.thread as JsonRecord : {}
        const found = textValue(thread.id) || input.sessionId
        if (!found) throw new Error('Codex app-server 没有返回 thread id。')
        sessionId = found
        if (found !== input.sessionId) input.onSessionId(found)
        await request('turn/start', {
          threadId: found,
          input: [{ type: 'text', text: input.prompt }],
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'dangerFullAccess' }
        })
      })().catch(finishError)
    })
  }

  private async runJsonCli(input: CliAgentTurnInput, mcpServers: McpServerLaunchConfig[]): Promise<CliAgentTurnResult> {
    const binary = resolveCliBinary(input.provider)
    const args = buildCliArgs(input, mcpServers)
    let latestSessionId = input.sessionId
    let buffer = ''
    let finalText = ''
    let streamedText = ''

    input.onUpdate({ type: 'status', status: 'running', detail: `正在启动 ${input.provider} CLI` })

    return await new Promise<CliAgentTurnResult>((resolve, reject) => {
      const child = spawn(binary, args, {
        cwd: input.workingDirectory,
        env: { ...buildCliEnv(input.provider, mcpServers), PWD: input.workingDirectory }
      })
      const stderr: Buffer[] = []
      let settled = false
      const finishError = (error: Error): void => {
        if (settled) return
        settled = true
        input.abortController.signal.removeEventListener('abort', abortChild)
        child.kill()
        reject(error)
      }
      const abortChild = (): void => finishError(input.abortController.signal.reason instanceof Error
        ? input.abortController.signal.reason
        : new Error('Agent Run 已停止。'))
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
        const parsed = input.provider === 'codex'
          ? codexRecord(record)
          : input.provider === 'claude'
            ? claudeRecord(record)
            : opencodeRecord(record)
        if (parsed.tool) {
          input.onUpdate({ type: 'tool', toolName: parsed.tool.name, status: 'completed', detail: parsed.tool.detail })
          input.onTool(parsed.tool.name, parsed.tool.detail, record)
        }
        if (parsed.assistant) {
          if (input.provider === 'claude' && record.type === 'stream_event') {
            streamedText += parsed.assistant
            input.onUpdate({ type: 'message_delta', messageId: `stream-${latestSessionId ?? 'new'}`, delta: parsed.assistant })
          } else {
            finalText = parsed.assistant
            if (!streamedText) {
              input.onUpdate({ type: 'message_delta', messageId: `stream-${latestSessionId ?? 'new'}`, delta: parsed.assistant })
            }
          }
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
        const text = (finalText || streamedText).trim()
        if (!text) {
          finishError(new Error(`${input.provider} CLI 没有返回 Agent 消息。`))
          return
        }
        settled = true
        input.abortController.signal.removeEventListener('abort', abortChild)
        resolve({ text, sessionId: latestSessionId })
      })
    })
  }
}
