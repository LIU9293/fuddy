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

  migrateLocalWorkspaces(): void {
    this.database.exec(`CREATE TABLE IF NOT EXISTS project_local_workspaces (
      project_id TEXT PRIMARY KEY REFERENCES projects(id), configuration_json TEXT NOT NULL,
      shared_id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL DEFAULT 1,
      author TEXT NOT NULL, owner_user_id TEXT
    )`)
    for (const project of this.listAll()) {
      this.saveLocal(project)
      this.database.prepare('UPDATE projects SET profile_json = ? WHERE id = ?')
        .run(JSON.stringify(this.sharedProfile(project)), project.id)
    }
  }

  private sharedProfile(project: Project): Omit<ProjectProfile, 'repoPath' | 'workspaceRoots' | 'primaryWorkspaceRootId' | 'defaultAgent'> {
    const { repoPath, workspaceRoots, primaryWorkspaceRootId, defaultAgent, ...profile } = project.profile
    return profile
  }

  private saveLocal(project: Project): void {
    const configuration = { ...normalizeWorkspaceRoots(project.profile), defaultAgent: project.profile.defaultAgent }
    this.database.prepare(`INSERT INTO project_local_workspaces
      (project_id, configuration_json, shared_id, author, owner_user_id) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET configuration_json = excluded.configuration_json`)
      .run(project.id, JSON.stringify(configuration), randomUUID(), randomUUID(), this.currentOwner())
  }

  forAccount(ownerUserId: string): Project[] {
    this.database.prepare('UPDATE project_local_workspaces SET owner_user_id = ? WHERE owner_user_id IS NULL').run(ownerUserId)
    const ids = new Set((this.database.prepare('SELECT project_id FROM project_local_workspaces WHERE owner_user_id = ?')
      .all(ownerUserId) as SqlRow[]).map((row) => String(row.project_id)))
    return this.listAll().filter((project) => ids.has(project.id))
  }

  mergeShared(incoming: Project, ownerUserId: string): Project {
    if (!incoming.shared) throw new Error('项目缺少账户标识，请更新另一台 Mac 上的 Fuddy。')
    return this.transaction(() => {
      const existing = this.forAccount(ownerUserId).find((project) => project.shared?.id === incoming.shared!.id)
      if (existing?.shared && (existing.shared.revision > incoming.shared!.revision
        || (existing.shared.revision === incoming.shared!.revision && existing.shared.author >= incoming.shared!.author))) return existing
      const id = existing?.id ?? `account-${incoming.shared!.id}`
      if (!existing) {
        this.database.prepare(`INSERT INTO projects (id,name,icon,summary,focus,status,accent,sort_order,profile_json)
          VALUES (?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM projects),?)`)
          .run(id, incoming.name, incoming.icon ?? null, incoming.summary, incoming.focus, incoming.status, incoming.accent, JSON.stringify(this.sharedProfile(incoming)))
        this.database.prepare(`INSERT INTO project_local_workspaces
          (project_id,configuration_json,shared_id,revision,author,owner_user_id) VALUES (?,?,?,?,?,?)`)
          .run(id, JSON.stringify({ repoPath: '', workspaceRoots: [], primaryWorkspaceRootId: null, defaultAgent: 'codex' }), incoming.shared!.id, incoming.shared!.revision, incoming.shared!.author, ownerUserId)
      } else {
        this.database.prepare('UPDATE projects SET name=?,icon=?,summary=?,focus=?,status=?,accent=?,profile_json=? WHERE id=?')
          .run(incoming.name, incoming.icon ?? null, incoming.summary, incoming.focus, incoming.status, incoming.accent, JSON.stringify(this.sharedProfile(incoming)), id)
        this.database.prepare('UPDATE project_local_workspaces SET revision=?,author=? WHERE project_id=?')
          .run(incoming.shared!.revision, incoming.shared!.author, id)
      }
      const project = this.require(id)
      this.publish(existing ? 'project.updated' : 'project.created', project)
      return project
    })
  }

  private currentOwner(): string | null {
    const cached = this.database.prepare("SELECT value_json FROM app_settings WHERE key='account.cached-state'").get() as SqlRow | undefined
    return cached ? parseJson<{ user?: { id?: string } } | null>(String(cached.value_json), null)?.user?.id ?? null : null
  }

  list(): Project[] {
    const owner = this.currentOwner()
    const all = this.listAll()
    const migrated = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_local_workspaces'").get()
    if (!owner || !migrated) return all
    const allowed = new Set((this.database.prepare('SELECT project_id FROM project_local_workspaces WHERE owner_user_id IS NULL OR owner_user_id=?').all(owner) as SqlRow[]).map((row) => String(row.project_id)))
    return all.filter((project) => allowed.has(project.id))
  }

  private listAll(): Project[] {
    const rows = this.database.prepare('SELECT * FROM projects ORDER BY sort_order ASC').all() as SqlRow[]
    return rows.map((row) => this.map(row))
  }

  update(project: Project): Project {
    return this.transaction(() => {
      const previous = this.require(project.id)
      if (project.shared && previous.shared && (project.shared.revision !== previous.shared.revision || project.shared.author !== previous.shared.author)) {
        throw new Error('项目信息已在另一台 Mac 更新，请刷新后再保存。')
      }
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
          JSON.stringify(this.sharedProfile(normalizedProject)),
          normalizedProject.id
        )
      if (result.changes === 0) throw new Error(`Project not found: ${normalizedProject.id}`)
      this.saveLocal(normalizedProject)
      const sharedChanged = JSON.stringify({ ...previous, shared: undefined, profile: this.sharedProfile(previous) })
        !== JSON.stringify({ ...normalizedProject, shared: undefined, profile: this.sharedProfile(normalizedProject) })
      if (sharedChanged) this.database.prepare('UPDATE project_local_workspaces SET revision=revision+1, author=? WHERE project_id=?')
        .run(randomUUID(), project.id)
      this.database
        .prepare(
          `
        UPDATE connector_instances
        SET config_json = json_set(config_json, '$.repoPath', ?)
        WHERE project_id = ? AND kind = 'repo'
      `
        )
        .run(workspaces.repoPath, normalizedProject.id)
      if (workspaces.repoPath && !this.database.prepare("SELECT 1 FROM connector_instances WHERE project_id=? AND kind='repo'").get(project.id)) {
        this.upsertRepoConnector(normalizedProject, workspaces.repoPath, 0)
      }
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
          JSON.stringify(this.sharedProfile(project))
        )
      this.saveLocal(project)
      if (workspacePath) this.upsertRepoConnector(project, workspacePath, sortOrder)
      const created = this.require(project.id)
      this.publish('project.created', created)
      return created
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
    const localTableExists = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_local_workspaces'").get()
    const local = localTableExists ? this.database.prepare('SELECT * FROM project_local_workspaces WHERE project_id=?').get(row.id) as SqlRow | undefined : undefined
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
    const localConfiguration = local ? parseJson<Partial<ProjectProfile>>(String(local.configuration_json), {}) : savedProfile
    const workspaces = normalizeWorkspaceRoots(localConfiguration)
    return {
      id: String(row.id),
      ...(local ? { shared: { id: String(local.shared_id), revision: Number(local.revision), author: String(local.author) } } : {}),
      name: String(row.name),
      icon: row.icon == null || !String(row.icon).trim() ? null : String(row.icon),
      summary: String(row.summary),
      focus: String(row.focus),
      status: row.status as Project['status'],
      accent: String(row.accent),
      profile: {
        ...fallbackProfile,
        ...canonicalSavedProfile,
        defaultAgent: localConfiguration.defaultAgent ?? legacyDefaultCodingAgent ?? fallbackProfile.defaultAgent,
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
