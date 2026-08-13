import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { Project, ProjectProfile, ProjectWorkspaceRoot } from '../shared/contracts'
import { evaluateAggressivePermission } from '../shared/permissions'
import { normalizeWorkspaceRoots } from '../shared/project-workspaces'

const databasePath = process.env.PROJECT_AGENT_DB_PATH?.trim() ?? ''
const projectId = process.env.PROJECT_AGENT_PROJECT_ID?.trim() ?? ''
if (!databasePath || !projectId) throw new Error('Fuddy MCP 缺少数据库路径或项目 ID。')

const database = new DatabaseSync(databasePath)
database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')

const rootSchema = z.object({
  id: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
  path: z.string().trim().min(1).max(2_000)
})

const patchSchema = {
  name: z.string().trim().min(1).max(200).optional(),
  summary: z.string().trim().min(1).max(2_000).optional(),
  focus: z.string().trim().min(1).max(500).optional(),
  status: z.enum(['active', 'watching', 'paused']).optional(),
  productType: z.string().trim().min(1).max(200).optional(),
  stage: z.string().trim().min(1).max(200).optional(),
  mission: z.string().trim().min(1).max(2_000).optional(),
  vision: z.string().trim().min(1).max(2_000).optional(),
  websiteUrl: z.string().url().nullable().optional(),
  defaultAgent: z.enum(['pi', 'codex', 'claude', 'opencode']).optional(),
  focusAreas: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
  dataSources: z.array(z.string().trim().min(1).max(300)).max(50).optional(),
  nextMoves: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
  currentStateSummary: z.string().trim().min(1).max(2_000).optional(),
  currentStateFacts: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
  workspaceRoots: z.array(rootSchema).max(12).optional(),
  primaryWorkspaceRootId: z.string().trim().min(1).max(100).nullable().optional()
}

type ProjectPatch = z.infer<z.ZodObject<typeof patchSchema>>

function loadProject(): Project {
  const row = database.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined
  if (!row) throw new Error(`Project not found: ${projectId}`)
  const saved = JSON.parse(String(row.profile_json ?? '{}')) as Partial<ProjectProfile> & { defaultCodingAgent?: ProjectProfile['defaultAgent'] }
  const { defaultCodingAgent: legacyDefaultCodingAgent, ...canonicalSaved } = saved
  const workspaces = normalizeWorkspaceRoots(saved)
  const profile = {
    productType: '未设置', stage: '未设置', mission: String(row.summary), vision: String(row.summary),
    defaultAgent: saved.defaultAgent ?? legacyDefaultCodingAgent ?? 'codex', websiteUrl: null, surfaces: [], focusAreas: [], dataSources: [], nextMoves: [],
    currentState: { summary: '尚未记录项目现状。', facts: [], source: 'agent', updatedAt: null },
    ...canonicalSaved,
    ...workspaces
  } as ProjectProfile
  return {
    id: String(row.id),
    name: String(row.name),
    summary: String(row.summary),
    focus: String(row.focus),
    status: row.status as Project['status'],
    accent: String(row.accent),
    profile
  }
}

function applyPatch(project: Project, patch: ProjectPatch): Project {
  const profile = { ...project.profile }
  for (const field of ['productType', 'stage', 'mission', 'vision'] as const) {
    if (patch[field] !== undefined) profile[field] = patch[field]
  }
  if (patch.websiteUrl !== undefined) profile.websiteUrl = patch.websiteUrl
  if (patch.defaultAgent !== undefined) profile.defaultAgent = patch.defaultAgent
  for (const field of ['focusAreas', 'dataSources', 'nextMoves'] as const) {
    if (patch[field] !== undefined) profile[field] = patch[field]
  }
  if (patch.workspaceRoots !== undefined) profile.workspaceRoots = patch.workspaceRoots as ProjectWorkspaceRoot[]
  if (patch.primaryWorkspaceRootId !== undefined) profile.primaryWorkspaceRootId = patch.primaryWorkspaceRootId
  Object.assign(profile, normalizeWorkspaceRoots(profile))
  if (patch.currentStateSummary !== undefined || patch.currentStateFacts !== undefined) {
    profile.currentState = {
      summary: patch.currentStateSummary ?? profile.currentState.summary,
      facts: patch.currentStateFacts ?? profile.currentState.facts,
      source: 'agent',
      updatedAt: new Date().toISOString()
    }
  }
  return {
    ...project,
    name: patch.name ?? project.name,
    summary: patch.summary ?? project.summary,
    focus: patch.focus ?? project.focus,
    status: patch.status ?? project.status,
    profile
  }
}

function saveProject(project: Project): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    database.prepare(`
      UPDATE projects
      SET name = ?, summary = ?, focus = ?, status = ?, profile_json = ?
      WHERE id = ?
    `).run(project.name, project.summary, project.focus, project.status, JSON.stringify(project.profile), project.id)
    const connectors = database.prepare("SELECT id, config_json FROM connector_instances WHERE project_id = ? AND kind = 'repo'").all(project.id) as Array<Record<string, unknown>>
    for (const connector of connectors) {
      const config = JSON.parse(String(connector.config_json ?? '{}')) as Record<string, unknown>
      config.repoPath = project.profile.repoPath
      database.prepare('UPDATE connector_instances SET config_json = ? WHERE id = ?').run(JSON.stringify(config), String(connector.id))
    }
    const intent = { tool: 'update_project_info', action: 'update', target: project.id, description: 'Agent 通过 Fuddy MCP 更新项目配置。' }
    const evaluation = evaluateAggressivePermission(intent)
    database.prepare(`INSERT INTO audit_entries (id, intent_json, evaluation_json, outcome, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(randomUUID(), JSON.stringify(intent), JSON.stringify(evaluation), 'executed', new Date().toISOString())
    database.exec('COMMIT')
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK')
    throw error
  }
}

const server = new McpServer({ name: 'project-agent', version: '0.1.0' })
server.registerTool('update_project_info', {
  description: '更新当前 Fuddy 项目的基本信息、产品上下文、Workspace Roots、默认 Agent、数据源或当前状态。只传需要修改的字段；Workspace 变更会在下一个 Run 生效。',
  inputSchema: patchSchema
}, async (patch) => {
  try {
    const saved = applyPatch(loadProject(), patch)
    saveProject(saved)
    return {
      content: [{
        type: 'text',
        text: `已更新项目 ${saved.name}。主 Workspace：${saved.profile.repoPath || '未设置'}；Workspace 数量：${saved.profile.workspaceRoots.length}。`
      }],
      structuredContent: {
        projectId: saved.id,
        primaryWorkspace: saved.profile.repoPath,
        workspaceRoots: saved.profile.workspaceRoots
      }
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : '项目配置更新失败。' }]
    }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)

const close = (): void => {
  database.close()
  process.exit(0)
}
process.on('SIGINT', close)
process.on('SIGTERM', close)
