import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { CodingAgentProvider, CreateProjectInput, Project, ProjectProfile } from '../../../shared/contracts'
import { normalizeWorkspaceRoots } from '../../../shared/project-workspaces'

type SqlRow = Record<string, string | number | null>
type ProjectEvent = 'project.created' | 'project.updated'

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export class ProjectRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly transaction: <T>(operation: () => T) => T,
    private readonly publish: (type: ProjectEvent, project: Project) => void
  ) {}

  list(): Project[] {
    const rows = this.database.prepare('SELECT * FROM projects ORDER BY sort_order ASC').all() as SqlRow[]
    return rows.map((row) => this.map(row))
  }

  update(project: Project): Project {
    return this.transaction(() => {
      const workspaces = normalizeWorkspaceRoots(project.profile)
      const normalizedProject: Project = {
        ...project,
        icon: project.icon?.trim() || null,
        profile: { ...project.profile, ...workspaces }
      }
      const result = this.database
        .prepare(
          `
        UPDATE projects
        SET name = ?, icon = ?, summary = ?, focus = ?, status = ?, accent = ?, profile_json = ?
        WHERE id = ?
      `
        )
        .run(
          normalizedProject.name,
          normalizedProject.icon ?? null,
          normalizedProject.summary,
          normalizedProject.focus,
          normalizedProject.status,
          normalizedProject.accent,
          JSON.stringify(normalizedProject.profile),
          normalizedProject.id
        )
      if (result.changes === 0) throw new Error(`Project not found: ${normalizedProject.id}`)
      this.database
        .prepare(
          `
        UPDATE connector_instances
        SET config_json = json_set(config_json, '$.repoPath', ?)
        WHERE project_id = ? AND kind = 'repo'
      `
        )
        .run(workspaces.repoPath, normalizedProject.id)
      const updated = this.require(normalizedProject.id)
      this.publish('project.updated', updated)
      return updated
    })
  }

  create(input: CreateProjectInput): Project {
    return this.transaction(() => {
      const baseId =
        input.name
          .normalize('NFKD')
          .toLocaleLowerCase()
          .replace(/[^a-z0-9\u3400-\u9fff]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 80) || `project-${randomUUID().slice(0, 8)}`
      let id = baseId
      let suffix = 2
      while (this.database.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) id = `${baseId}-${suffix++}`
      const now = new Date().toISOString()
      const workspacePath = input.workspacePath?.trim() || ''
      const project: Project = {
        id,
        name: input.name.trim(),
        icon: input.icon?.trim() || null,
        summary: input.summary.trim(),
        focus: input.focus.trim(),
        status: 'active',
        accent: ['#327bd6', '#8d6fd1', '#2f8f6b', '#d17b32', '#d25572'][this.list().length % 5],
        profile: {
          productType: input.productType.trim(),
          stage: input.stage.trim(),
          mission: input.mission.trim(),
          vision: input.vision.trim(),
          repoPath: workspacePath,
          workspaceRoots: workspacePath ? [{ id: 'primary', label: input.name.trim(), path: workspacePath }] : [],
          primaryWorkspaceRootId: workspacePath ? 'primary' : null,
          defaultAgent: input.defaultAgent ?? 'codex',
          websiteUrl: input.websiteUrl ?? null,
          surfaces: [],
          focusAreas: [],
          dataSources: [],
          nextMoves: [],
          currentState: {
            summary: input.summary.trim(),
            facts: [],
            source: 'user',
            updatedAt: now
          }
        }
      }
      const sortOrder = Number(
        (this.database.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM projects').get() as SqlRow).value
      )
      this.database
        .prepare(
          `
        INSERT INTO projects (id, name, icon, summary, focus, status, accent, sort_order, profile_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          project.id,
          project.name,
          project.icon ?? null,
          project.summary,
          project.focus,
          project.status,
          project.accent,
          sortOrder,
          JSON.stringify(project.profile)
        )
      if (workspacePath) this.upsertRepoConnector(project, workspacePath, sortOrder)
      this.publish('project.created', project)
      return project
    })
  }

  private require(id: string): Project {
    const project = this.list().find((candidate) => candidate.id === id)
    if (!project) throw new Error(`Project not found: ${id}`)
    return project
  }

  private upsertRepoConnector(project: Project, repoPath: string, sortOrder: number): void {
    this.database
      .prepare(
        `
      INSERT INTO connector_instances (
        id, project_id, kind, name, enabled, status, config_json,
        credential_ref, capabilities_json, sort_order
      ) VALUES (?, ?, 'repo', ?, 1, 'needs-setup', ?, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        name = excluded.name,
        enabled = 1,
        status = 'needs-setup',
        config_json = excluded.config_json,
        capabilities_json = excluded.capabilities_json,
        sort_order = excluded.sort_order
    `
      )
      .run(
        `repo-${project.id}`,
        project.id,
        `${project.name} Repo`,
        JSON.stringify({ repoPath }),
        JSON.stringify(['health', 'collect', 'evidence']),
        sortOrder
      )
  }

  private map(row: SqlRow): Project {
    const fallbackProfile: ProjectProfile = {
      productType: '未设置',
      stage: '未设置',
      mission: String(row.summary),
      vision: String(row.summary),
      repoPath: '',
      workspaceRoots: [],
      primaryWorkspaceRootId: null,
      defaultAgent: 'codex',
      websiteUrl: null,
      surfaces: [],
      focusAreas: [],
      dataSources: [],
      nextMoves: [],
      currentState: {
        summary: '尚未记录项目现状。',
        facts: [],
        source: 'agent',
        updatedAt: null
      }
    }
    const savedProfile = parseJson<Partial<ProjectProfile> & { defaultCodingAgent?: CodingAgentProvider }>(
      row.profile_json ? String(row.profile_json) : null,
      {}
    )
    const { defaultCodingAgent: legacyDefaultCodingAgent, ...canonicalSavedProfile } = savedProfile
    const workspaces = normalizeWorkspaceRoots(savedProfile)
    return {
      id: String(row.id),
      name: String(row.name),
      icon: row.icon == null || !String(row.icon).trim() ? null : String(row.icon),
      summary: String(row.summary),
      focus: String(row.focus),
      status: row.status as Project['status'],
      accent: String(row.accent),
      profile: {
        ...fallbackProfile,
        ...canonicalSavedProfile,
        defaultAgent: savedProfile.defaultAgent ?? legacyDefaultCodingAgent ?? fallbackProfile.defaultAgent,
        ...workspaces,
        surfaces: savedProfile.surfaces ?? [],
        focusAreas: savedProfile.focusAreas ?? [],
        dataSources: savedProfile.dataSources ?? [],
        nextMoves: savedProfile.nextMoves ?? [],
        currentState: {
          ...fallbackProfile.currentState,
          ...(savedProfile.currentState ?? {}),
          facts: savedProfile.currentState?.facts ?? []
        }
      }
    }
  }
}
