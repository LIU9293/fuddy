export type AgentToolKind = 'read' | 'search' | 'edit' | 'command' | 'browser' | 'other'

export interface AgentToolPresentation {
  kind: AgentToolKind
  label: string
  summary: string
}

type JsonRecord = Record<string, unknown>

const toolKindLabels: Record<AgentToolKind, string> = {
  read: '读取文件',
  search: '搜索代码',
  edit: '编辑文件',
  command: '运行命令',
  browser: '操作浏览器',
  other: '调用工具'
}

const toolKindGroupLabels: Record<AgentToolKind, string> = {
  read: '读取',
  search: '搜索',
  edit: '编辑',
  command: '运行',
  browser: '浏览器',
  other: '其他'
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function parsedRecord(value: string): JsonRecord | null {
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return null
  }
}

function firstString(record: JsonRecord | null, keys: string[]): string {
  if (!record) return ''
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function leafName(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/$/, '')
  return normalized.split('/').at(-1) || value
}

function compact(value: string, maximum = 140): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 1).trimEnd()}…` : normalized
}

export function agentToolKind(toolName: string): AgentToolKind {
  const name = toolName.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (/^(read|readfile|cat|notebookread|listfiles)$/.test(name)) return 'read'
  if (/^(grep|glob|search|find|rg|codesearch|websearch)$/.test(name)) return 'search'
  if (/^(edit|write|writefile|applypatch|patch|notebookedit|multiedit)$/.test(name)) return 'edit'
  if (/^(bash|shell|command|exec|execute|terminal|runcommand)$/.test(name)) return 'command'
  if (/(browser|webfetch|computer|screenshot|navigate|click)/.test(name)) return 'browser'
  return 'other'
}

export function agentToolPresentation(
  toolName: string,
  detail: string,
  metadata: Record<string, unknown> | null = null
): AgentToolPresentation {
  const explicitKind = metadata?.toolKind
  const kind = typeof explicitKind === 'string' && explicitKind in toolKindLabels
    ? explicitKind as AgentToolKind
    : agentToolKind(toolName)
  const explicitSummary = typeof metadata?.toolSummary === 'string' ? compact(metadata.toolSummary) : ''
  if (explicitSummary) return { kind, label: toolKindLabels[kind], summary: explicitSummary }

  const detailRecord = parsedRecord(detail)
  const metadataInput = asRecord(metadata?.input)
  const metadataArguments = asRecord(metadata?.arguments)
  const metadataState = asRecord(metadata?.state)
  const stateInput = asRecord(metadataState?.input)
  const detailState = asRecord(detailRecord?.state)
  const detailInput = asRecord(detailRecord?.input) ?? asRecord(detailState?.input)
  const input = metadataInput ?? metadataArguments ?? stateInput ?? detailInput ?? detailRecord

  const path = firstString(input, ['file_path', 'filePath', 'path', 'relativePath', 'notebook_path'])
  const query = firstString(input, ['query', 'pattern', 'search', 'glob'])
  const command = firstString(input, ['command', 'cmd']) || firstString(metadata, ['command'])
  const url = firstString(input, ['url', 'href'])
  const description = firstString(input, ['description', 'prompt', 'task'])

  let summary = ''
  if ((kind === 'read' || kind === 'edit') && path) summary = leafName(path)
  else if (kind === 'search' && query) summary = `“${compact(query, 90)}”`
  else if (kind === 'command' && command) summary = compact(command)
  else if (kind === 'browser' && url) summary = compact(url)
  else if (description) summary = compact(description)
  else if (kind === 'command') summary = compact(detail.split('\n')[0] ?? '')
  else if (!detailRecord) summary = compact(detail)

  return {
    kind,
    label: kind === 'other' && toolName.trim() ? toolName.trim() : toolKindLabels[kind],
    summary: summary || '查看详情'
  }
}

export function agentToolGroupSummary(tools: Array<Pick<AgentToolPresentation, 'kind' | 'label' | 'summary'>>): string {
  if (tools.length === 0) return '尚无操作'
  if (tools.length === 1) {
    const tool = tools[0]
    return `${tool.label}·${tool.summary}`
  }

  const counts = new Map<AgentToolKind, number>()
  tools.forEach((tool) => counts.set(tool.kind, (counts.get(tool.kind) ?? 0) + 1))
  return [...counts.entries()]
    .map(([kind, count]) => `${toolKindGroupLabels[kind]} ${count} 次`)
    .join(' · ')
}
