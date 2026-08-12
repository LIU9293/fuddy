import { execFile, spawn } from 'node:child_process'
import type {
  CodingAgentModelCatalog,
  CodingAgentModelCatalogEntry,
  CodingAgentModelOption,
  CodingAgentProvider,
  CodingAgentReasoningEffortOption
} from '../../shared/contracts'
import { resolveCliBinary } from './cli-executables'
import { codingAgentProviders } from '../../shared/agent-providers'

type JsonRecord = Record<string, unknown>

const discoveryTimeoutMs = 15_000

interface DiscoveredModels {
  models: CodingAgentModelOption[]
  defaultReasoningEfforts: CodingAgentReasoningEffortOption[]
  defaultReasoningEffort: string | null
}

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

function uniqueReasoningEfforts(efforts: CodingAgentReasoningEffortOption[]): CodingAgentReasoningEffortOption[] {
  const seen = new Set<string>()
  return efforts.filter((effort) => {
    if (!effort.id || seen.has(effort.id)) return false
    seen.add(effort.id)
    return true
  })
}

function reasoningEffortsFromStrings(values: unknown): CodingAgentReasoningEffortOption[] {
  if (!Array.isArray(values)) return []
  return uniqueReasoningEfforts(values.flatMap((value) => {
    const id = textValue(value)
    return id ? [{ id, label: id, description: null }] : []
  }))
}

function parseCodexReasoningEfforts(values: unknown): CodingAgentReasoningEffortOption[] {
  if (!Array.isArray(values)) return []
  return uniqueReasoningEfforts(values.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const record = value as JsonRecord
    const id = textValue(record.reasoningEffort) || textValue(record.id)
    return id ? [{ id, label: id, description: textValue(record.description) || null }] : []
  }))
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
      description: textValue(record.description) || null,
      isDefault: record.isDefault === true,
      reasoningEfforts: parseCodexReasoningEfforts(record.supportedReasoningEfforts),
      defaultReasoningEffort: textValue(record.defaultReasoningEffort) || null
    }]
  }))
}

export function parseOpenCodeModels(output: string): CodingAgentModelOption[] {
  return uniqueModels(output.split(/\r?\n/).flatMap((line) => {
    const id = line.trim()
    if (!id || id.startsWith('[') || !id.includes('/')) return []
    return [{
      id,
      label: id,
      description: null,
      isDefault: false,
      reasoningEfforts: [],
      defaultReasoningEffort: null
    }]
  }))
}

export function parseOpenCodeVerboseModels(output: string): CodingAgentModelOption[] {
  const models: CodingAgentModelOption[] = []
  let currentId = ''
  let jsonBuffer = ''
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!jsonBuffer && line && !line.startsWith('{') && !line.includes(' ') && line.includes('/')) {
      currentId = line
      continue
    }
    if (!jsonBuffer && line === '{') jsonBuffer = `${rawLine}\n`
    else if (jsonBuffer) jsonBuffer += `${rawLine}\n`
    if (!jsonBuffer || !currentId) continue
    try {
      const record = JSON.parse(jsonBuffer) as JsonRecord
      const variants = record.variants && typeof record.variants === 'object'
        ? Object.keys(record.variants as JsonRecord)
        : []
      models.push({
        id: currentId,
        label: textValue(record.name) || currentId,
        description: null,
        isDefault: false,
        reasoningEfforts: uniqueReasoningEfforts(variants.map((id) => ({ id, label: id, description: null }))),
        defaultReasoningEffort: null
      })
      currentId = ''
      jsonBuffer = ''
    } catch {
      // The pretty-printed JSON object is not complete yet.
    }
  }
  return uniqueModels(models)
}

function listCodexModels(): Promise<DiscoveredModels> {
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
      const defaultModel = models.find((model) => model.isDefault)
      resolve({
        models,
        defaultReasoningEfforts: defaultModel?.reasoningEfforts ?? [],
        defaultReasoningEffort: defaultModel?.defaultReasoningEffort ?? null
      })
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

async function listClaudeModels(): Promise<DiscoveredModels> {
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
    const defaultModel = models.find((model) => model.value.trim() === 'default')
    const defaultReasoningEfforts = reasoningEffortsFromStrings(defaultModel?.supportedEffortLevels)
    const discoveredModels = uniqueModels(models.flatMap((model) => {
      const id = model.value.trim()
      if (!id || id === 'default') return []
      return [{
        id,
        label: model.displayName.trim() || id,
        description: model.description.trim() || null,
        isDefault: false,
        reasoningEfforts: model.supportsEffort === false ? [] : reasoningEffortsFromStrings(model.supportedEffortLevels),
        defaultReasoningEffort: null
      }]
    }))
    return { models: discoveredModels, defaultReasoningEfforts, defaultReasoningEffort: null }
  } finally {
    if (timer) clearTimeout(timer)
    stream.close()
  }
}

function listOpenCodeModels(): Promise<DiscoveredModels> {
  return new Promise((resolve, reject) => {
    execFile(resolveCliBinary('opencode'), ['models', '--verbose'], {
      encoding: 'utf8',
      env: { ...process.env },
      timeout: discoveryTimeoutMs,
      maxBuffer: 2 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message))
        return
      }
      const models = parseOpenCodeVerboseModels(stdout)
      resolve({
        models: models.length > 0 ? models : parseOpenCodeModels(stdout),
        defaultReasoningEfforts: [],
        defaultReasoningEffort: null
      })
    })
  })
}

async function discover(provider: CodingAgentProvider): Promise<CodingAgentModelCatalogEntry> {
  try {
    const discoverer: Record<CodingAgentProvider, () => Promise<DiscoveredModels>> = {
      codex: listCodexModels,
      claude: listClaudeModels,
      opencode: listOpenCodeModels
    }
    const discovered = await discoverer[provider]()
    return {
      provider,
      ...discovered,
      error: discovered.models.length > 0 ? null : '当前 Agent 没有返回可选模型'
    }
  } catch (error) {
    return {
      provider,
      models: [],
      defaultReasoningEfforts: [],
      defaultReasoningEffort: null,
      error: errorMessage(error)
    }
  }
}

export async function discoverCodingAgentModels(): Promise<CodingAgentModelCatalog> {
  const entries = await Promise.all(codingAgentProviders.map(async (provider) => [
    provider,
    await discover(provider)
  ] as const))
  return Object.fromEntries(entries) as unknown as CodingAgentModelCatalog
}
