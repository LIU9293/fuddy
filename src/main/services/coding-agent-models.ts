import { execFile, spawn } from 'node:child_process'
import type {
  CodingAgentModelCatalog,
  CodingAgentModelCatalogEntry,
  CodingAgentModelOption,
  CodingAgentProvider
} from '../../shared/contracts'
import { resolveCliBinary } from './cli-executables'

type JsonRecord = Record<string, unknown>

const discoveryTimeoutMs = 15_000

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim().split('\n')[0] || '读取模型失败'
}

function uniqueModels(models: CodingAgentModelOption[]): CodingAgentModelOption[] {
  const seen = new Set<string>()
  return models.filter((model) => {
    if (!model.id || seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}

export function parseCodexModels(result: unknown): CodingAgentModelOption[] {
  if (!result || typeof result !== 'object') return []
  const data = (result as JsonRecord).data
  if (!Array.isArray(data)) return []
  return uniqueModels(data.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const record = value as JsonRecord
    const id = textValue(record.model) || textValue(record.id)
    if (!id) return []
    return [{
      id,
      label: textValue(record.displayName) || id,
      description: null,
      isDefault: record.isDefault === true
    }]
  }))
}

export function parseOpenCodeModels(output: string): CodingAgentModelOption[] {
  return uniqueModels(output.split(/\r?\n/).flatMap((line) => {
    const id = line.trim()
    if (!id || id.startsWith('[') || !id.includes('/')) return []
    return [{ id, label: id, description: null, isDefault: false }]
  }))
}

function listCodexModels(): Promise<CodingAgentModelOption[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCliBinary('codex'), ['app-server', '--stdio'], {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let buffer = ''
    let stderr = ''
    let nextId = 1
    let settled = false
    const pending = new Map<number, {
      resolve: (result: JsonRecord) => void
      reject: (error: Error) => void
    }>()
    const timer = setTimeout(() => finishError(new Error('Codex 模型读取超时')), discoveryTimeoutMs)

    const finish = (models: CodingAgentModelOption[]): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(models)
    }
    const finishError = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      reject(error)
    }
    const write = (message: JsonRecord): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }
    const request = (method: string, params: JsonRecord): Promise<JsonRecord> => new Promise((requestResolve, requestReject) => {
      const id = nextId++
      pending.set(id, { resolve: requestResolve, reject: requestReject })
      write({ method, id, params })
    })
    const processLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed) return
      try {
        const record = JSON.parse(trimmed) as JsonRecord
        if (typeof record.id !== 'number') return
        const waiter = pending.get(record.id)
        if (!waiter) return
        pending.delete(record.id)
        if (record.error && typeof record.error === 'object') {
          waiter.reject(new Error(textValue((record.error as JsonRecord).message) || 'Codex app-server 请求失败'))
          return
        }
        waiter.resolve(record.result && typeof record.result === 'object' ? record.result as JsonRecord : {})
      } catch {
        // Ignore non-JSON diagnostics on stdout.
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
      ? new Error('未检测到 Codex CLI')
      : error))
    child.on('close', (code) => {
      if (!settled) finishError(new Error(stderr.trim() || `Codex app-server 已退出（${code ?? 'unknown'}）`))
    })

    void (async () => {
      await request('initialize', {
        clientInfo: { name: 'project-agent', title: 'Project Agent', version: '0.1.0' },
        capabilities: {}
      })
      write({ method: 'initialized', params: {} })
      const result = await request('model/list', { limit: 100, includeHidden: false })
      finish(parseCodexModels(result))
    })().catch((error: unknown) => finishError(error instanceof Error ? error : new Error(String(error))))
  })
}

async function listClaudeModels(): Promise<CodingAgentModelOption[]> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const stream = query({
    prompt: '',
    options: {
      cwd: process.cwd(),
      pathToClaudeCodeExecutable: resolveCliBinary('claude'),
      env: { ...process.env },
      settingSources: ['user', 'project']
    }
  })
  let timer: NodeJS.Timeout | undefined
  try {
    const models = await Promise.race([
      stream.supportedModels(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Claude Code 模型读取超时')), discoveryTimeoutMs)
      })
    ])
    return uniqueModels(models.flatMap((model) => {
      const id = model.value.trim()
      if (!id || id === 'default') return []
      return [{
        id,
        label: model.displayName.trim() || id,
        description: model.description.trim() || null,
        isDefault: false
      }]
    }))
  } finally {
    if (timer) clearTimeout(timer)
    stream.close()
  }
}

function listOpenCodeModels(): Promise<CodingAgentModelOption[]> {
  return new Promise((resolve, reject) => {
    execFile(resolveCliBinary('opencode'), ['models'], {
      encoding: 'utf8',
      env: { ...process.env },
      timeout: discoveryTimeoutMs,
      maxBuffer: 2 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message))
        return
      }
      resolve(parseOpenCodeModels(stdout))
    })
  })
}

async function discover(provider: CodingAgentProvider): Promise<CodingAgentModelCatalogEntry> {
  try {
    const models = provider === 'codex'
      ? await listCodexModels()
      : provider === 'claude'
        ? await listClaudeModels()
        : await listOpenCodeModels()
    return {
      provider,
      models,
      error: models.length > 0 ? null : '当前 Agent 没有返回可选模型'
    }
  } catch (error) {
    return { provider, models: [], error: errorMessage(error) }
  }
}

export async function discoverCodingAgentModels(): Promise<CodingAgentModelCatalog> {
  const [codex, claude, opencode] = await Promise.all([
    discover('codex'),
    discover('claude'),
    discover('opencode')
  ])
  return { codex, claude, opencode }
}
