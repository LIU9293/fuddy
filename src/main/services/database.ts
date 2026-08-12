import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  AutomationJob,
  AutomationRun,
  AgentRun,
  AgentRunArtifact,
  AgentRunDetail,
  AgentRunMessage,
  AppBootstrap,
  AuditEntry,
  BriefingMessage,
  Capability,
  ConnectorInstance,
  ConnectorRun,
  ConnectorRunStatus,
  CodingAgentProvider,
  CreateProjectInput,
  CreateDecisionInput,
  CredentialStorageStatus,
  DailyBriefing,
  DecisionItem,
  DecisionRemediation,
  DecisionStatus,
  DecisionWaitingReason,
  EvidenceRef,
  GoalCheckIn,
  GoalMilestone,
  GoalMilestoneStatus,
  GoalPriority,
  GoalStatus,
  MorningBriefing,
  PermissionEvaluation,
  PermissionIntent,
  ProviderSettings,
  Project,
  ProjectAnalyticsProfileSummary,
  ProjectGoal,
  ProjectProfile,
  WorkAssistantActionProposal,
  WorkAssistantTaskContext
} from '../../shared/contracts'
import type { ConnectorCatalogItem } from '../../shared/contracts'
import { normalizeWorkspaceRoots } from '../../shared/project-workspaces'
import { companionEventDefinitions, companionProtocolVersion } from '../../shared/companion-sync'
import { emptyAgentModelLabels, type AgentModelLabels } from '../../shared/model-display'
import { runDatabaseMigrations } from './database-migrations'
import type {
  AgentTurnSettledPayload,
  CompanionCommand,
  CompanionCommandStatus,
  CompanionEntityType,
  CompanionEventPayloadMap,
  CompanionEventType,
  CompanionOutboxEvent,
  CompanionSnapshotPayload
} from '../../shared/companion-sync'

type SqlRow = Record<string, string | number | null>

export interface DecisionInspectionInput {
  projectId: string | null
  dedupeKey: string
  observationKey: string
  state: 'active' | 'resolved'
  observedAt: string
  summary: string
  evidenceRefs: EvidenceRef[]
  decision?: DecisionItem
}

export interface DecisionInspectionResult {
  decision: DecisionItem | null
  created: boolean
  updated: boolean
  resolved: boolean
}

export interface DecisionStatusTransitionInput {
  actor: 'system' | 'agent' | 'user'
  reason?: string
  waitingReason?: DecisionWaitingReason | null
  evidenceRefs?: EvidenceRef[]
  occurredAt?: string
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback

  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export class AppDatabase {
  private readonly database: DatabaseSync
  private readonly companionEventListeners = new Set<() => void>()

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path)
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    runDatabaseMigrations(this.database, [
      { version: 1, name: 'baseline-schema', apply: () => this.ensureCurrentSchema() },
      {
        version: 2,
        name: 'normalize-project-workspaces',
        apply: () => {
          this.migrateProjectWorkspaceProfiles()
          this.migrateAgentRunWorkspaces()
        }
      },
      { version: 3, name: 'normalize-decision-lifecycles', apply: () => this.migrateDecisionLifecycle() }
    ])
    this.seed()
    this.prunePublishedCompanionEvents()
  }

  close(): void {
    this.companionEventListeners.clear()
    this.database.close()
  }

  onCompanionEventEnqueued(listener: () => void): () => void {
    this.companionEventListeners.add(listener)
    return () => this.companionEventListeners.delete(listener)
  }

  getBootstrap(
    capabilities: Capability[],
    connectorCatalog: ConnectorCatalogItem[],
    analyticsProfiles: ProjectAnalyticsProfileSummary[],
    credentialStorage: CredentialStorageStatus,
    providerSettings: ProviderSettings
  ): AppBootstrap {
    return {
      projects: this.listProjects(),
      goals: this.listGoals(),
      decisions: this.listDecisions(),
      decisionRemediations: this.listDecisionRemediations(),
      runs: this.listRuns(),
      connectors: this.listConnectors(),
      connectorRuns: this.listConnectorRuns(),
      dailyBriefings: this.listDailyBriefings(),
      morningBriefings: this.listMorningBriefings(),
      briefingMessages: this.listBriefingMessages(),
      automations: this.listAutomations(),
      automationRuns: this.listAutomationRuns(),
      providerSettings,
      connectorCatalog,
      analyticsProfiles,
      capabilities,
      credentialStorage,
      permissionMode: 'full-access'
    }
  }

  listProjects(): Project[] {
    const rows = this.database
      .prepare('SELECT * FROM projects ORDER BY sort_order ASC')
      .all() as SqlRow[]

    return rows.map((row) => {
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
    })
  }

  updateProject(project: Project): Project {
    return this.companionTransaction(() => {
    const workspaces = normalizeWorkspaceRoots(project.profile)
    const normalizedProject: Project = {
      ...project,
      icon: project.icon?.trim() || null,
      profile: { ...project.profile, ...workspaces }
    }
    const result = this.database.prepare(`
      UPDATE projects
      SET name = ?, icon = ?, summary = ?, focus = ?, status = ?, accent = ?, profile_json = ?
      WHERE id = ?
    `).run(
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
    this.database.prepare(`
      UPDATE connector_instances
      SET config_json = json_set(config_json, '$.repoPath', ?)
      WHERE project_id = ? AND kind = 'repo'
    `).run(workspaces.repoPath, normalizedProject.id)
    const updated = this.listProjects().find((candidate) => candidate.id === normalizedProject.id) as Project
    this.enqueueCompanionEvent('project.updated', 'project', updated.id, updated)
    return updated
    })
  }

  createProject(input: CreateProjectInput): Project {
    return this.companionTransaction(() => {
      const baseId = input.name
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
        accent: ['#327bd6', '#8d6fd1', '#2f8f6b', '#d17b32', '#d25572'][this.listProjects().length % 5],
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
      const sortOrder = Number((this.database.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM projects').get() as SqlRow).value)
      this.database.prepare(`
        INSERT INTO projects (id, name, icon, summary, focus, status, accent, sort_order, profile_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(project.id, project.name, project.icon ?? null, project.summary, project.focus, project.status, project.accent, sortOrder, JSON.stringify(project.profile))
      this.enqueueCompanionEvent('project.created', 'project', project.id, project)
      return project
    })
  }

  listGoals(projectId?: string): ProjectGoal[] {
    const rows = projectId
      ? this.database
          .prepare("SELECT * FROM project_goals WHERE project_id = ? ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END, updated_at DESC")
          .all(projectId) as SqlRow[]
      : this.database
          .prepare("SELECT * FROM project_goals ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END, updated_at DESC")
          .all() as SqlRow[]

    const milestones = this.database
      .prepare('SELECT * FROM goal_milestones ORDER BY goal_id, sort_order ASC, created_at ASC')
      .all() as SqlRow[]
    const checkIns = this.database
      .prepare('SELECT * FROM goal_checkins ORDER BY created_at DESC')
      .all() as SqlRow[]

    return rows.map((row) => this.mapGoal(
      row,
      milestones.filter((item) => String(item.goal_id) === String(row.id)),
      checkIns.filter((item) => String(item.goal_id) === String(row.id)).slice(0, 8)
    ))
  }

  getGoal(id: string): ProjectGoal {
    const goal = this.listGoals().find((item) => item.id === id)
    if (!goal) throw new Error(`Goal not found: ${id}`)
    return goal
  }

  createGoal(goal: ProjectGoal): ProjectGoal {
    return this.companionTransaction(() => {
    this.database.prepare(`
      INSERT INTO project_goals (
        id, project_id, title, description, status, priority, metric_json, deadline,
        next_check_in_at, progress, confidence, agent_summary,
        monitoring_sources_json, created_by, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      goal.id,
      goal.projectId,
      goal.title,
      goal.description,
      goal.status,
      goal.priority,
      JSON.stringify(goal.metric),
      goal.deadline,
      goal.nextCheckInAt,
      goal.progress,
      goal.confidence,
      goal.agentSummary,
      JSON.stringify(goal.monitoringSources),
      goal.createdBy,
      goal.createdAt,
      goal.updatedAt,
      goal.completedAt
    )

    const insertMilestone = this.database.prepare(`
      INSERT INTO goal_milestones (
        id, goal_id, title, status, due_at, evidence_refs_json, sort_order,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    goal.milestones.forEach((milestone) => insertMilestone.run(
      milestone.id,
      goal.id,
      milestone.title,
      milestone.status,
      milestone.dueAt,
      JSON.stringify(milestone.evidenceRefs),
      milestone.sortOrder,
      milestone.createdAt,
      milestone.updatedAt,
      milestone.completedAt
    ))
    goal.checkIns.forEach((checkIn) => this.createGoalCheckIn(checkIn))
    const created = this.getGoal(goal.id)
    this.enqueueCompanionEvent('goal.created', 'goal', created.id, created)
    return created
    })
  }

  updateGoalTracking(input: {
    id: string
    status: GoalStatus
    progress: number
    metric: ProjectGoal['metric']
    confidence: number
    agentSummary: string
    nextCheckInAt: string | null
  }): ProjectGoal {
    return this.companionTransaction(() => {
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE project_goals
      SET status = ?, progress = ?, metric_json = ?, confidence = ?, agent_summary = ?,
          next_check_in_at = ?, updated_at = ?,
          completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, ?) ELSE NULL END
      WHERE id = ?
    `).run(
      input.status,
      Math.max(0, Math.min(1, input.progress)),
      JSON.stringify(input.metric),
      Math.max(0, Math.min(1, input.confidence)),
      input.agentSummary,
      input.nextCheckInAt,
      now,
      input.status,
      now,
      input.id
    )
    const updated = this.getGoal(input.id)
    this.enqueueCompanionEvent('goal.updated', 'goal', updated.id, updated)
    return updated
    })
  }

  updateGoalStatus(id: string, status: GoalStatus): ProjectGoal {
    const goal = this.getGoal(id)
    return this.updateGoalTracking({
      id,
      status,
      progress: status === 'completed' ? 1 : goal.progress,
      metric: goal.metric,
      confidence: goal.confidence,
      agentSummary: status === 'planned'
        ? '目标已加入 Roadmap，激活后 Agent 才会开始例行检查。'
        : status === 'paused'
        ? '目标已暂停，恢复后 Agent 才会继续例行检查。'
        : status === 'completed'
          ? '目标已由用户标记为完成。'
          : goal.agentSummary,
      nextCheckInAt: status === 'planned' || status === 'paused' || status === 'completed'
        ? null
        : goal.nextCheckInAt ?? new Date(Date.now() + 7 * 86_400_000).toISOString()
    })
  }

  updateGoalPriority(id: string, priority: GoalPriority): ProjectGoal {
    return this.companionTransaction(() => {
    const now = new Date().toISOString()
    const result = this.database.prepare(`
      UPDATE project_goals
      SET priority = ?, updated_at = ?
      WHERE id = ?
    `).run(priority, now, id)
    if (result.changes === 0) throw new Error(`Goal not found: ${id}`)
    const updated = this.getGoal(id)
    this.enqueueCompanionEvent('goal.updated', 'goal', updated.id, updated)
    return updated
    })
  }

  updateGoalMilestones(
    goalId: string,
    updates: Array<{ title: string; status: GoalMilestoneStatus }>
  ): void {
    return this.companionTransaction(() => {
    const now = new Date().toISOString()
    const update = this.database.prepare(`
      UPDATE goal_milestones
      SET status = ?, updated_at = ?,
          completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, ?) ELSE NULL END
      WHERE goal_id = ? AND title = ?
    `)
    updates.forEach((item) => update.run(item.status, now, item.status, now, goalId, item.title))
    const goal = this.getGoal(goalId)
    this.enqueueCompanionEvent('goal.updated', 'goal', goal.id, goal)
    })
  }

  completeGoalMilestone(goalId: string, milestoneId: string): ProjectGoal {
    return this.companionTransaction(() => {
      const now = new Date().toISOString()
      const result = this.database.prepare(`
        UPDATE goal_milestones
        SET status = 'completed', updated_at = ?, completed_at = COALESCE(completed_at, ?)
        WHERE id = ? AND goal_id = ?
      `).run(now, now, milestoneId, goalId)
      if (result.changes === 0) throw new Error(`Milestone not found: ${milestoneId}`)
      this.refreshGoalProgressFromMilestones(goalId, now)
      const goal = this.getGoal(goalId)
      this.enqueueCompanionEvent('goal.updated', 'goal', goal.id, goal)
      return goal
    })
  }

  deleteGoalMilestone(goalId: string, milestoneId: string): ProjectGoal {
    return this.companionTransaction(() => {
      const existing = this.database.prepare(`
        SELECT id FROM goal_milestones WHERE id = ? AND goal_id = ?
      `).get(milestoneId, goalId)
      if (!existing) throw new Error(`Milestone not found: ${milestoneId}`)
      const linkedRunIds = (this.database.prepare(`
        SELECT id FROM agent_runs WHERE milestone_id = ?
      `).all(milestoneId) as SqlRow[]).map((row) => String(row.id))
      const now = new Date().toISOString()
      this.database.prepare(`
        UPDATE agent_runs SET milestone_id = NULL, updated_at = ? WHERE milestone_id = ?
      `).run(now, milestoneId)
      this.database.prepare('DELETE FROM goal_milestones WHERE id = ? AND goal_id = ?').run(milestoneId, goalId)
      this.refreshGoalProgressFromMilestones(goalId, now)
      for (const runId of linkedRunIds) {
        const run = this.getAgentRun(runId)
        this.enqueueCompanionEvent('agent-run.updated', 'agent-run', run.id, run)
      }
      const goal = this.getGoal(goalId)
      this.enqueueCompanionEvent('goal.updated', 'goal', goal.id, goal)
      return goal
    })
  }

  private refreshGoalProgressFromMilestones(goalId: string, updatedAt: string): void {
    const goal = this.getGoal(goalId)
    const metric = goal.metric
    const progress = metric.current !== null && metric.target !== null && metric.baseline !== metric.target
      ? Math.max(0, Math.min(1, (metric.current - (metric.baseline ?? 0)) / (metric.target - (metric.baseline ?? 0))))
      : goal.milestones.length === 0
        ? 0
        : goal.milestones.filter((milestone) => milestone.status === 'completed').length / goal.milestones.length
    this.database.prepare(`
      UPDATE project_goals SET progress = ?, updated_at = ? WHERE id = ?
    `).run(progress, updatedAt, goalId)
  }

  createGoalCheckIn(checkIn: GoalCheckIn): GoalCheckIn {
    this.database.prepare(`
      INSERT INTO goal_checkins (
        id, goal_id, status, progress, summary, evidence_refs_json, generation, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      checkIn.id,
      checkIn.goalId,
      checkIn.status,
      checkIn.progress,
      checkIn.summary,
      JSON.stringify(checkIn.evidenceRefs),
      checkIn.generation,
      checkIn.createdAt
    )
    return checkIn
  }

  listDecisions(): DecisionItem[] {
    const rows = this.database
      .prepare('SELECT * FROM decision_items ORDER BY created_at DESC')
      .all() as SqlRow[]

    return rows.map((row) => this.mapDecision(row))
  }

  listDecisionRemediations(decisionId?: string): DecisionRemediation[] {
    const rows = decisionId
      ? this.database.prepare(`
          SELECT * FROM decision_remediations
          WHERE decision_id = ?
          ORDER BY last_seen_at DESC, first_seen_at DESC
        `).all(decisionId) as SqlRow[]
      : this.database.prepare(`
          SELECT * FROM decision_remediations
          ORDER BY last_seen_at DESC, first_seen_at DESC
        `).all() as SqlRow[]
    return rows.map((row) => this.mapDecisionRemediation(row))
  }

  upsertDecisionRemediation(remediation: DecisionRemediation): DecisionRemediation {
    this.database.prepare(`
      INSERT INTO decision_remediations (
        id, decision_id, source_type, source_ref, state, summary, next_action,
        evidence_refs_json, metadata_json, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(decision_id, source_type, source_ref) DO UPDATE SET
        state = excluded.state,
        summary = excluded.summary,
        next_action = excluded.next_action,
        evidence_refs_json = excluded.evidence_refs_json,
        metadata_json = excluded.metadata_json,
        last_seen_at = excluded.last_seen_at
    `).run(
      remediation.id,
      remediation.decisionId,
      remediation.sourceType,
      remediation.sourceRef,
      remediation.state,
      remediation.summary,
      remediation.nextAction,
      JSON.stringify(remediation.evidenceRefs),
      JSON.stringify(remediation.metadata),
      remediation.firstSeenAt,
      remediation.lastSeenAt
    )
    const row = this.database.prepare(`
      SELECT * FROM decision_remediations
      WHERE decision_id = ? AND source_type = ? AND source_ref = ?
    `).get(remediation.decisionId, remediation.sourceType, remediation.sourceRef) as SqlRow
    return this.mapDecisionRemediation(row)
  }

  listRuns(): AgentRun[] {
    const rows = this.database
      .prepare('SELECT * FROM agent_runs WHERE archived_at IS NULL ORDER BY COALESCE(updated_at, started_at, created_at) DESC')
      .all() as SqlRow[]

    return rows.map((row) => this.mapAgentRun(row))
  }

  getAgentRun(id: string): AgentRun {
    const row = this.database.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as SqlRow | undefined
    if (!row) throw new Error(`Agent run not found: ${id}`)
    return this.mapAgentRun(row)
  }

  getAgentRunDetail(id: string): AgentRunDetail {
    return {
      run: this.getAgentRun(id),
      messages: this.listAgentRunMessages(id),
      artifacts: this.listAgentRunArtifacts(id)
    }
  }

  renameAgentRun(id: string, title: string): AgentRun {
    return this.companionTransaction(() => {
    const normalizedTitle = title.trim()
    if (!normalizedTitle) throw new Error('Session 标题不能为空。')
    const result = this.database.prepare(`
      UPDATE agent_runs SET title = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL
    `).run(normalizedTitle, new Date().toISOString(), id)
    if (Number(result.changes) === 0) throw new Error(`Agent run not found: ${id}`)
    const run = this.getAgentRun(id)
    this.enqueueCompanionEvent('agent-run.updated', 'agent-run', run.id, run)
    return run
    })
  }

  updateAgentRunDraftPrompt(id: string, draftPrompt: string): AgentRun {
    return this.companionTransaction(() => {
      const run = this.getAgentRun(id)
      if (run.status !== 'draft' || this.listAgentRunMessages(id).length > 0) {
        throw new Error('只有尚未发送首条消息的草稿 Run 可以修改预填内容。')
      }
      const updatedAt = new Date().toISOString()
      this.database.prepare(`
        UPDATE agent_runs SET draft_prompt = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL
      `).run(draftPrompt.trim() || null, updatedAt, id)
      const updated = this.getAgentRun(id)
      this.enqueueCompanionEvent('agent-run.updated', 'agent-run', updated.id, updated)
      return updated
    })
  }

  archiveAgentRun(id: string): void {
    return this.companionTransaction(() => {
    const run = this.getAgentRun(id)
    if (run.status === 'running' || run.status === 'queued') {
      throw new Error('正在运行的 Session 不能归档，请等待本轮结束。')
    }
    const archivedAt = new Date().toISOString()
    this.database.prepare(`
      UPDATE agent_runs SET archived_at = ?, updated_at = ? WHERE id = ?
    `).run(archivedAt, archivedAt, id)
    this.enqueueCompanionEvent('agent-run.archived', 'agent-run', id, { id, archivedAt })
    })
  }

  listAgentRunMessages(runId: string): AgentRunMessage[] {
    const rows = this.database
      .prepare('SELECT * FROM agent_run_messages WHERE run_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(runId) as SqlRow[]
    return rows.map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      role: row.role as AgentRunMessage['role'],
      content: String(row.content),
      eventType: row.event_type ? String(row.event_type) : null,
      toolName: row.tool_name ? String(row.tool_name) : null,
      metadata: parseJson<Record<string, unknown> | null>(row.metadata_json ? String(row.metadata_json) : null, null),
      createdAt: String(row.created_at)
    }))
  }

  listAgentRunArtifacts(runId: string): AgentRunArtifact[] {
    const rows = this.database
      .prepare('SELECT * FROM agent_run_artifacts WHERE run_id = ? ORDER BY created_at DESC')
      .all(runId) as SqlRow[]
    return rows.map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      projectId: row.project_id ? String(row.project_id) : null,
      relativePath: String(row.relative_path),
      label: String(row.label),
      mimeType: row.mime_type ? String(row.mime_type) : null,
      createdAt: String(row.created_at)
    }))
  }

  getAgentRunArtifact(id: string): AgentRunArtifact | null {
    const row = this.database.prepare('SELECT * FROM agent_run_artifacts WHERE id = ?').get(id) as SqlRow | undefined
    if (!row) return null
    return {
      id: String(row.id),
      runId: String(row.run_id),
      projectId: row.project_id ? String(row.project_id) : null,
      relativePath: String(row.relative_path),
      label: String(row.label),
      mimeType: row.mime_type ? String(row.mime_type) : null,
      createdAt: String(row.created_at)
    }
  }

  listConnectors(): ConnectorInstance[] {
    const rows = this.database
      .prepare('SELECT * FROM connector_instances ORDER BY sort_order ASC, name ASC')
      .all() as SqlRow[]

    return rows.map((row) => this.mapConnector(row))
  }

  getConnector(id: string): ConnectorInstance {
    const row = this.database
      .prepare('SELECT * FROM connector_instances WHERE id = ?')
      .get(id) as SqlRow | undefined

    if (!row) throw new Error(`Connector not found: ${id}`)
    return this.mapConnector(row)
  }

  listConnectorRuns(): ConnectorRun[] {
    const rows = this.database
      .prepare('SELECT * FROM connector_runs ORDER BY started_at DESC LIMIT 50')
      .all() as SqlRow[]

    return rows.map((row) => ({
      id: String(row.id),
      connectorId: String(row.connector_id),
      projectId: String(row.project_id),
      status: row.status as ConnectorRunStatus,
      startedAt: String(row.started_at),
      completedAt: String(row.completed_at),
      summary: String(row.summary),
      evidenceRefs: parseJson<EvidenceRef[]>(String(row.evidence_refs_json), []),
      decisionId: row.decision_id ? String(row.decision_id) : null,
      data: parseJson<Record<string, unknown> | null>(
        row.data_json ? String(row.data_json) : null,
        null
      )
    }))
  }

  listDailyBriefings(): DailyBriefing[] {
    const rows = this.database
      .prepare('SELECT * FROM daily_briefings ORDER BY report_date DESC, generated_at DESC LIMIT 30')
      .all() as SqlRow[]
    return rows.map((row) => this.mapDailyBriefing(row))
  }

  getDailyBriefing(projectId: string, reportDate: string): DailyBriefing | null {
    const row = this.database
      .prepare('SELECT * FROM daily_briefings WHERE project_id = ? AND report_date = ?')
      .get(projectId, reportDate) as SqlRow | undefined
    return row ? this.mapDailyBriefing(row) : null
  }

  upsertDailyBriefing(briefing: DailyBriefing): DailyBriefing {
    this.database.prepare(`
      INSERT INTO daily_briefings (
        id, project_id, report_date, timezone, status, headline, body,
        metrics_json, signal_ids_json, generated_at, error, generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, report_date) DO UPDATE SET
        status = excluded.status,
        headline = excluded.headline,
        body = excluded.body,
        metrics_json = excluded.metrics_json,
        signal_ids_json = excluded.signal_ids_json,
        generated_at = excluded.generated_at,
        error = excluded.error,
        generation = excluded.generation
    `).run(
      briefing.id,
      briefing.projectId,
      briefing.reportDate,
      briefing.timezone,
      briefing.status,
      briefing.headline,
      briefing.body,
      briefing.metrics ? JSON.stringify(briefing.metrics) : null,
      JSON.stringify(briefing.signalIds),
      briefing.generatedAt,
      briefing.error,
      briefing.generation
    )
    return this.getDailyBriefing(briefing.projectId, briefing.reportDate) as DailyBriefing
  }

  listMorningBriefings(): MorningBriefing[] {
    const rows = this.database
      .prepare('SELECT * FROM morning_briefings ORDER BY report_date DESC, generated_at DESC LIMIT 30')
      .all() as SqlRow[]
    return rows.map((row) => this.mapMorningBriefing(row))
  }

  getMorningBriefing(reportDate: string): MorningBriefing | null {
    const row = this.database
      .prepare('SELECT * FROM morning_briefings WHERE report_date = ?')
      .get(reportDate) as SqlRow | undefined
    return row ? this.mapMorningBriefing(row) : null
  }

  getMorningBriefingById(id: string): MorningBriefing | null {
    const row = this.database
      .prepare('SELECT * FROM morning_briefings WHERE id = ?')
      .get(id) as SqlRow | undefined
    return row ? this.mapMorningBriefing(row) : null
  }

  upsertMorningBriefing(briefing: MorningBriefing): MorningBriefing {
    return this.companionTransaction(() => {
      this.database.prepare(`
        INSERT INTO morning_briefings (
          id, report_date, timezone, status, headline, body, narration,
          estimated_duration_seconds, source_briefing_ids_json, signal_ids_json,
          generated_at, error, generation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(report_date) DO UPDATE SET
          status = excluded.status,
          headline = excluded.headline,
          body = excluded.body,
          narration = excluded.narration,
          estimated_duration_seconds = excluded.estimated_duration_seconds,
          source_briefing_ids_json = excluded.source_briefing_ids_json,
          signal_ids_json = excluded.signal_ids_json,
          generated_at = excluded.generated_at,
          error = excluded.error,
          generation = excluded.generation
      `).run(
        briefing.id,
        briefing.reportDate,
        briefing.timezone,
        briefing.status,
        briefing.headline,
        briefing.body,
        briefing.narration,
        briefing.estimatedDurationSeconds,
        JSON.stringify(briefing.sourceBriefingIds),
        JSON.stringify(briefing.signalIds),
        briefing.generatedAt,
        briefing.error,
        briefing.generation
      )
      const updated = this.getMorningBriefing(briefing.reportDate) as MorningBriefing
      this.enqueueCompanionEvent('morning-briefing.updated', 'morning-briefing', updated.id, updated)
      return updated
    })
  }

  listBriefingMessages(briefingId?: string): BriefingMessage[] {
    const rows = briefingId
      ? this.database
          .prepare('SELECT * FROM work_assistant_messages WHERE source_briefing_id = ? ORDER BY created_at ASC')
          .all(briefingId) as SqlRow[]
      : this.database
          .prepare('SELECT * FROM work_assistant_messages ORDER BY created_at ASC LIMIT 200')
          .all() as SqlRow[]
    return rows.map((row) => ({
      id: String(row.id),
      briefingId: row.source_briefing_id ? String(row.source_briefing_id) : null,
      role: row.role as BriefingMessage['role'],
      content: String(row.content),
      attachments: parseJson<BriefingMessage['attachments']>(
        row.attachments_json ? String(row.attachments_json) : null,
        []
      ),
      taskContext: parseJson<WorkAssistantTaskContext | null>(
        row.task_context_json ? String(row.task_context_json) : null,
        null
      ),
      linkedRunId: row.linked_run_id ? String(row.linked_run_id) : null,
      actions: parseJson<WorkAssistantActionProposal[]>(row.actions_json ? String(row.actions_json) : null, []),
      createdAt: String(row.created_at)
    }))
  }

  createBriefingMessage(message: BriefingMessage): BriefingMessage {
    return this.companionTransaction(() => {
    this.database.prepare(`
      INSERT INTO work_assistant_messages (
        id, source_briefing_id, role, content, attachments_json, task_context_json, linked_run_id, actions_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.briefingId,
      message.role,
      message.content,
      JSON.stringify(message.attachments),
      message.taskContext ? JSON.stringify(message.taskContext) : null,
      message.linkedRunId ?? null,
      JSON.stringify(message.actions ?? []),
      message.createdAt
    )
    this.enqueueCompanionEvent('work-assistant-message.created', 'work-assistant-message', message.id, message)
    return message
    })
  }

  updateBriefingMessageActions(
    messageId: string,
    actions: WorkAssistantActionProposal[],
    linkedRunId?: string | null
  ): BriefingMessage {
    return this.companionTransaction(() => {
      const result = this.database.prepare(`
        UPDATE work_assistant_messages
        SET actions_json = ?, linked_run_id = COALESCE(?, linked_run_id)
        WHERE id = ?
      `).run(JSON.stringify(actions), linkedRunId ?? null, messageId)
      if (Number(result.changes) === 0) throw new Error('没有找到这条工作助理消息。')
      const message = this.listBriefingMessages().find((item) => item.id === messageId)
      if (!message) throw new Error('没有找到这条工作助理消息。')
      this.enqueueCompanionEvent('work-assistant-message.updated', 'work-assistant-message', message.id, message)
      return message
    })
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.database.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as
      | SqlRow
      | undefined
    return row ? parseJson<T>(String(row.value_json), fallback) : fallback
  }

  setSetting<T>(key: string, value: T): void {
    this.database.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), new Date().toISOString())
  }

  listAutomations(): AutomationJob[] {
    const rows = this.database
      .prepare('SELECT * FROM automation_jobs ORDER BY created_at ASC')
      .all() as SqlRow[]
    return rows.map((row) => this.mapAutomation(row))
  }

  getAutomation(id: string): AutomationJob {
    const row = this.database.prepare('SELECT * FROM automation_jobs WHERE id = ?').get(id) as SqlRow | undefined
    if (!row) throw new Error(`Automation not found: ${id}`)
    return this.mapAutomation(row)
  }

  saveAutomation(job: AutomationJob): AutomationJob {
    this.database.prepare(`
      INSERT INTO automation_jobs (
        id, project_id, name, schedule_description, cron_expression, timezone,
        action, prompt, agent_kind, agent_provider, enabled, requires_confirmation,
        max_retries, retry_delay_seconds, status, last_run_at, next_run_at,
        last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        name = excluded.name,
        schedule_description = excluded.schedule_description,
        cron_expression = excluded.cron_expression,
        timezone = excluded.timezone,
        action = excluded.action,
        prompt = excluded.prompt,
        agent_kind = excluded.agent_kind,
        agent_provider = excluded.agent_provider,
        enabled = excluded.enabled,
        requires_confirmation = excluded.requires_confirmation,
        max_retries = excluded.max_retries,
        retry_delay_seconds = excluded.retry_delay_seconds,
        status = excluded.status,
        next_run_at = excluded.next_run_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      job.id,
      job.projectId,
      job.name,
      job.scheduleDescription,
      job.cronExpression,
      job.timezone,
      job.action,
      job.prompt,
      job.agentProvider === 'pi' ? 'general' : 'coding',
      job.agentProvider,
      job.enabled ? 1 : 0,
      job.requiresConfirmation ? 1 : 0,
      job.maxRetries,
      job.retryDelaySeconds,
      job.status,
      job.lastRunAt,
      job.nextRunAt,
      job.lastError,
      job.createdAt,
      job.updatedAt
    )
    return this.getAutomation(job.id)
  }

  setAutomationEnabled(id: string, enabled: boolean, nextRunAt: string | null): AutomationJob {
    this.database.prepare(`
      UPDATE automation_jobs
      SET enabled = ?, status = ?, next_run_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(enabled ? 1 : 0, enabled ? 'idle' : 'paused', nextRunAt, new Date().toISOString(), id)
    return this.getAutomation(id)
  }

  updateAutomationRuntime(
    id: string,
    input: Pick<AutomationJob, 'status' | 'lastRunAt' | 'nextRunAt' | 'lastError'>
  ): AutomationJob {
    this.database.prepare(`
      UPDATE automation_jobs
      SET status = ?, last_run_at = ?, next_run_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.status,
      input.lastRunAt,
      input.nextRunAt,
      input.lastError,
      new Date().toISOString(),
      id
    )
    return this.getAutomation(id)
  }

  listAutomationRuns(automationId?: string): AutomationRun[] {
    const rows = automationId
      ? this.database.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 100').all(automationId) as SqlRow[]
      : this.database.prepare('SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT 200').all() as SqlRow[]
    return rows.map((row) => this.mapAutomationRun(row))
  }

  getAutomationRun(id: string): AutomationRun {
    const row = this.database.prepare('SELECT * FROM automation_runs WHERE id = ?').get(id) as SqlRow | undefined
    if (!row) throw new Error(`Automation run not found: ${id}`)
    return this.mapAutomationRun(row)
  }

  saveAutomationRun(run: AutomationRun): AutomationRun {
    this.database.prepare(`
      INSERT INTO automation_runs (
        id, automation_id, status, trigger, attempt, started_at, completed_at,
        summary, error, agent_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        attempt = excluded.attempt,
        completed_at = excluded.completed_at,
        summary = excluded.summary,
        error = excluded.error,
        agent_run_id = excluded.agent_run_id
    `).run(
      run.id,
      run.automationId,
      run.status,
      run.trigger,
      run.attempt,
      run.startedAt,
      run.completedAt,
      run.summary,
      run.error,
      run.agentRunId
    )
    return this.getAutomationRun(run.id)
  }

  recoverInterruptedAutomations(recoveredAt: string): void {
    this.database.prepare(`
      UPDATE automation_runs
      SET status = 'failed', completed_at = ?, summary = '应用退出时运行尚未完成。',
          error = '运行被应用退出中断。'
      WHERE status = 'running'
    `).run(recoveredAt)
    this.database.prepare(`
      UPDATE automation_jobs
      SET status = 'error', last_error = '上一次运行被应用退出中断。', updated_at = ?
      WHERE status = 'running'
    `).run(recoveredAt)
  }

  setConnectorEnabled(id: string, enabled: boolean): ConnectorInstance {
    this.database.prepare(`
      UPDATE connector_instances
      SET enabled = ?, status = ?
      WHERE id = ?
    `).run(enabled ? 1 : 0, enabled ? 'needs-setup' : 'disabled', id)
    return this.getConnector(id)
  }

  upsertConnector(input: {
    id: string
    projectId: string
    kind: ConnectorInstance['kind']
    name: string
    config: Record<string, string | number | boolean>
    credentialRef: string | null
    capabilities: string[]
    sortOrder: number
  }): ConnectorInstance {
    this.database.prepare(`
      INSERT INTO connector_instances (
        id, project_id, kind, name, enabled, status, config_json,
        credential_ref, capabilities_json, sort_order
      ) VALUES (?, ?, ?, ?, 1, 'needs-setup', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        kind = excluded.kind,
        name = excluded.name,
        enabled = 1,
        status = 'needs-setup',
        config_json = excluded.config_json,
        credential_ref = excluded.credential_ref,
        capabilities_json = excluded.capabilities_json,
        last_error = NULL,
        sort_order = excluded.sort_order
    `).run(
      input.id,
      input.projectId,
      input.kind,
      input.name,
      JSON.stringify(input.config),
      input.credentialRef,
      JSON.stringify(input.capabilities),
      input.sortOrder
    )
    return this.getConnector(input.id)
  }

  markConnectorRunning(id: string, checkedAt: string): ConnectorInstance {
    this.database.prepare(`
      UPDATE connector_instances
      SET status = 'running', last_checked_at = ?, last_error = NULL
      WHERE id = ?
    `).run(checkedAt, id)
    return this.getConnector(id)
  }

  completeConnector(
    id: string,
    status: 'connected' | 'error',
    completedAt: string,
    error: string | null
  ): ConnectorInstance {
    this.database.prepare(`
      UPDATE connector_instances
      SET status = ?, last_sync_at = ?, last_error = ?
      WHERE id = ?
    `).run(status, completedAt, error, id)
    return this.getConnector(id)
  }

  createConnectorRun(run: ConnectorRun): void {
    this.database.prepare(`
      INSERT INTO connector_runs (
        id, connector_id, project_id, status, started_at, completed_at,
        summary, evidence_refs_json, decision_id, data_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.connectorId,
      run.projectId,
      run.status,
      run.startedAt,
      run.completedAt,
      run.summary,
      JSON.stringify(run.evidenceRefs),
      run.decisionId,
      run.data ? JSON.stringify(run.data) : null
    )
  }

  insertDecisionIfAbsent(item: DecisionItem): DecisionItem | null {
    const existing = this.database
      .prepare('SELECT id FROM decision_items WHERE id = ?')
      .get(item.id)
    if (existing) return null
    this.insertDecision(item)
    return item
  }

  upsertOpenDecisionSignal(item: DecisionItem): { decision: DecisionItem; created: boolean } {
    const result = this.applyDecisionInspection({
      projectId: item.projectId,
      dedupeKey: item.dedupeKey ?? `legacy:${item.projectId ?? 'all'}:${item.title}`,
      observationKey: `legacy:${item.id}`,
      state: 'active',
      observedAt: item.createdAt,
      summary: item.summary,
      evidenceRefs: item.evidenceRefs,
      decision: item
    })
    if (!result.decision) throw new Error('Active inspection did not produce a decision item.')
    return { decision: result.decision, created: result.created }
  }

  applyDecisionInspection(input: DecisionInspectionInput): DecisionInspectionResult {
    return this.companionTransaction(() => {
      const result = this.applyDecisionInspectionMutation(input)
      if (result.decision) {
        this.enqueueCompanionEvent(
          result.created ? 'decision.created' : 'decision.updated',
          'decision',
          result.decision.id,
          result.decision
        )
      }
      return result
    })
  }

  private applyDecisionInspectionMutation(input: DecisionInspectionInput): DecisionInspectionResult {
    const existing = this.database.prepare(`
      SELECT * FROM decision_items
      WHERE project_id IS ? AND dedupe_key = ?
      ORDER BY first_seen_at ASC, created_at ASC
      LIMIT 1
    `).get(input.projectId, input.dedupeKey) as SqlRow | undefined

    if (input.state === 'resolved') {
      if (!existing) return { decision: null, created: false, updated: false, resolved: false }
      const id = String(existing.id)
      const current = this.mapDecision(existing)
      const isNewObservation = this.recordDecisionObservation(id, input)
      const mergedEvidence = [...current.evidenceRefs]
      for (const evidence of input.evidenceRefs) {
        if (!mergedEvidence.some((item) => item.uri === evidence.uri)) mergedEvidence.push(evidence)
      }
      if (current.status === 'ignored') {
        this.database.prepare(`
          UPDATE decision_items
          SET last_seen_at = ?, evidence_refs_json = ?, occurrence_count = occurrence_count + ?
          WHERE id = ?
        `).run(input.observedAt, JSON.stringify(mergedEvidence), isNewObservation ? 1 : 0, id)
        return { decision: this.getDecision(id), created: false, updated: isNewObservation, resolved: false }
      }
      this.database.prepare(`
        UPDATE decision_items
        SET status = 'resolved', waiting_reason = NULL, status_summary = ?, status_updated_at = ?,
            last_seen_at = ?, resolved_at = ?, resolution_summary = ?,
            evidence_refs_json = ?, occurrence_count = occurrence_count + ?
        WHERE id = ?
      `).run(
        input.summary,
        input.observedAt,
        input.observedAt,
        input.observedAt,
        input.summary,
        JSON.stringify(mergedEvidence),
        isNewObservation ? 1 : 0,
        id
      )
      if (current.status !== 'resolved') {
        this.recordDecisionStatusEvent(id, current.status, 'resolved', {
          actor: 'system',
          reason: input.summary,
          evidenceRefs: input.evidenceRefs,
          occurredAt: input.observedAt
        })
      }
      return {
        decision: this.getDecision(id),
        created: false,
        updated: true,
        resolved: true
      }
    }

    if (!input.decision) throw new Error('Active inspection requires a decision payload.')
    if (!existing) {
      const idCollision = this.database.prepare('SELECT 1 FROM decision_items WHERE id = ?').get(input.decision.id)
      const decision = {
        ...input.decision,
        id: idCollision ? `${input.decision.id}-${randomUUID().slice(0, 8)}` : input.decision.id,
        dedupeKey: input.dedupeKey,
        firstSeenAt: input.observedAt,
        lastSeenAt: input.observedAt,
        occurrenceCount: 1,
        resolvedAt: null,
        resolutionSummary: null
      }
      this.insertDecision(decision)
      this.recordDecisionObservation(decision.id, input)
      return { decision: this.getDecision(decision.id), created: true, updated: false, resolved: false }
    }

    const id = String(existing.id)
    const current = this.mapDecision(existing)
    const isNewObservation = this.recordDecisionObservation(id, input)
    const item = input.decision
    if (current.status === 'ignored') {
      this.database.prepare(`
        UPDATE decision_items
        SET summary = ?, evidence_refs_json = ?, last_seen_at = ?,
            occurrence_count = occurrence_count + ?
        WHERE id = ?
      `).run(
        item.summary,
        JSON.stringify(item.evidenceRefs),
        input.observedAt,
        isNewObservation ? 1 : 0,
        id
      )
      return { decision: this.getDecision(id), created: false, updated: true, resolved: false }
    }
    const newerThanResolution = current.status !== 'resolved'
      || !current.resolvedAt
      || input.observedAt > current.resolvedAt
    if (current.status === 'resolved' && !newerThanResolution) {
      return { decision: current, created: false, updated: isNewObservation, resolved: true }
    }
    const reopened = current.status === 'resolved'
    const verificationFailed = current.status === 'waiting'
      && current.waitingReason === 'verification'
      && input.observedAt > (current.statusUpdatedAt ?? current.createdAt)
    const nextStatus: DecisionStatus = reopened ? 'inbox' : verificationFailed ? 'in_progress' : current.status
    const nextStatusSummary = reopened
      ? `最新巡检重新打开：${input.summary}`
      : verificationFailed
        ? `生产验证失败：${input.summary}`
        : current.statusSummary ?? null
    const statusChanged = reopened || verificationFailed
    this.database.prepare(`
      UPDATE decision_items
      SET goal_id = ?, dedupe_key = ?, kind = ?, title = ?, summary = ?, impact = ?, urgency = ?,
          confidence = ?, suggested_actions_json = ?, evidence_refs_json = ?, source = ?,
          last_seen_at = ?, occurrence_count = occurrence_count + ?, resolved_at = NULL,
          resolution_summary = NULL, status = ?, waiting_reason = ?, status_summary = ?,
          status_updated_at = CASE WHEN ? THEN ? ELSE status_updated_at END,
          reopen_count = reopen_count + CASE WHEN ? THEN 1 ELSE 0 END,
          auto_completion_key = CASE WHEN ? THEN NULL ELSE auto_completion_key END
      WHERE id = ?
    `).run(
      item.goalId ?? null,
      input.dedupeKey,
      item.kind,
      item.title,
      item.summary,
      item.impact,
      item.urgency,
      item.confidence,
      JSON.stringify(item.suggestedActions),
      JSON.stringify(item.evidenceRefs),
      item.source,
      input.observedAt,
      isNewObservation ? 1 : 0,
      nextStatus,
      statusChanged ? null : current.waitingReason ?? null,
      nextStatusSummary,
      statusChanged ? 1 : 0,
      input.observedAt,
      reopened ? 1 : 0,
      reopened ? 1 : 0,
      id
    )
    if (statusChanged) {
      this.recordDecisionStatusEvent(id, current.status, nextStatus, {
        actor: 'system',
        reason: nextStatusSummary ?? input.summary,
        evidenceRefs: input.evidenceRefs,
        occurredAt: input.observedAt
      })
    }
    return { decision: this.getDecision(id), created: false, updated: true, resolved: false }
  }

  createDecision(input: CreateDecisionInput): DecisionItem {
    return this.companionTransaction(() => {
    const item: DecisionItem = {
      id: randomUUID(),
      projectId: input.projectId,
      goalId: input.goalId ?? null,
      kind: 'decision',
      title: input.title,
      summary: input.summary ?? '由用户投递，等待助理分析并建议下一步。',
      impact: '待分析',
      urgency: 'medium',
      confidence: 1,
      suggestedActions: ['交给助理分析', '稍后处理'],
      evidenceRefs: input.evidenceRefs ?? [],
      status: 'inbox',
      source: '用户投递',
      createdAt: new Date().toISOString()
    }

    this.insertDecision(item)
    this.enqueueCompanionEvent('decision.created', 'decision', item.id, item)
    return item
    })
  }

  updateDecisionStatus(
    id: string,
    status: DecisionStatus,
    transition: DecisionStatusTransitionInput = { actor: 'user' }
  ): DecisionItem {
    return this.companionTransaction(() => {
      const current = this.getDecision(id)
      const occurredAt = transition.occurredAt ?? new Date().toISOString()
      const waitingReason = status === 'waiting'
        ? transition.waitingReason ?? current.waitingReason ?? 'user'
        : null
      const reason = transition.reason ?? (
        status === 'inbox' ? '事项恢复为待处理。'
          : status === 'in_progress' ? '事项开始处理。'
            : status === 'waiting' ? '事项正在等待下一项外部条件。'
              : status === 'resolved' ? '事项已解决。'
                : '由用户忽略。'
      )
      const mergedEvidence = [...current.evidenceRefs]
      for (const evidence of transition.evidenceRefs ?? []) {
        if (!mergedEvidence.some((item) => item.uri === evidence.uri)) mergedEvidence.push(evidence)
      }
      this.database.prepare(`
        UPDATE decision_items
        SET status = ?, waiting_reason = ?, status_summary = ?, status_updated_at = ?,
            evidence_refs_json = ?,
            reopen_count = reopen_count + CASE
              WHEN status = 'resolved' AND ? IN ('inbox', 'in_progress', 'waiting') THEN 1 ELSE 0 END,
            resolved_at = CASE WHEN ? IN ('resolved', 'ignored') THEN COALESCE(resolved_at, ?) ELSE NULL END,
            resolution_summary = CASE
              WHEN ? = 'resolved' THEN ?
              WHEN ? = 'ignored' THEN '由用户忽略。'
              ELSE NULL
            END,
            auto_completion_suppressed_key = CASE
              WHEN ? IN ('inbox', 'in_progress', 'waiting') AND status = 'resolved' AND auto_completion_key IS NOT NULL THEN auto_completion_key
              ELSE auto_completion_suppressed_key
            END,
            auto_completion_key = CASE WHEN ? = 'resolved' THEN NULL ELSE auto_completion_key END
        WHERE id = ?
      `).run(
        status,
        waitingReason,
        reason,
        occurredAt,
        JSON.stringify(mergedEvidence),
        status,
        status,
        occurredAt,
        status,
        reason,
        status,
        status,
        status,
        id
      )
      if (current.status !== status || current.waitingReason !== waitingReason || current.statusSummary !== reason) {
        this.recordDecisionStatusEvent(id, current.status, status, {
          ...transition,
          reason,
          waitingReason,
          occurredAt
        })
      }
      const decision = this.getDecision(id)
      this.enqueueCompanionEvent('decision.updated', 'decision', decision.id, decision)
      return decision
    })
  }

  completeDecisionWithEvidence(
    id: string,
    resolutionSummary: string,
    evidenceRefs: EvidenceRef[],
    completionKey: string,
    resolvedAt = new Date().toISOString()
  ): DecisionItem {
    return this.companionTransaction(() => {
      const lifecycle = this.database.prepare(`
        SELECT status, auto_completion_key, auto_completion_suppressed_key
        FROM decision_items WHERE id = ?
      `).get(id) as SqlRow | undefined
      if (!lifecycle) throw new Error(`Decision item not found: ${id}`)
      const current = this.getDecision(id)
      if (current.status === 'ignored') return current
      if (lifecycle.auto_completion_suppressed_key === completionKey) return current
      if (current.status === 'resolved' && lifecycle.auto_completion_key === completionKey) return current
      const mergedEvidence = [...current.evidenceRefs]
      for (const evidence of evidenceRefs) {
        if (!mergedEvidence.some((item) => item.uri === evidence.uri)) mergedEvidence.push(evidence)
      }
      this.database.prepare(`
        UPDATE decision_items
        SET status = 'resolved', waiting_reason = NULL, status_summary = ?, status_updated_at = ?,
            resolved_at = ?, resolution_summary = ?, evidence_refs_json = ?, auto_completion_key = ?
        WHERE id = ?
      `).run(resolutionSummary, resolvedAt, resolvedAt, resolutionSummary, JSON.stringify(mergedEvidence), completionKey, id)
      if (current.status !== 'resolved') {
        this.recordDecisionStatusEvent(id, current.status, 'resolved', {
          actor: 'system',
          reason: resolutionSummary,
          evidenceRefs,
          occurredAt: resolvedAt
        })
      }
      const decision = this.getDecision(id)
      this.enqueueCompanionEvent('decision.updated', 'decision', decision.id, decision)
      return decision
    })
  }

  createAgentRun(run: AgentRun): AgentRun {
    return this.companionTransaction(() => {
    this.database.prepare(`
      INSERT INTO agent_runs (
        id, project_id, decision_id, goal_id, milestone_id, agent, kind, provider, title, status,
        session_id, working_directory, started_at, completed_at, summary, draft_prompt, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.projectId,
      run.decisionId ?? null,
      run.goalId ?? null,
      run.milestoneId ?? null,
      run.provider,
      run.provider === 'pi' ? 'general' : 'coding',
      run.provider,
      run.title,
      run.status,
      run.sessionId,
      run.workingDirectory,
      run.startedAt,
      run.completedAt,
      run.summary,
      run.draftPrompt,
      run.createdAt,
      run.updatedAt
    )
    const created = this.getAgentRun(run.id)
    this.enqueueCompanionEvent('agent-run.created', 'agent-run', created.id, created)
    return created
    })
  }

  updateAgentRun(run: AgentRun): AgentRun {
    return this.companionTransaction(() => {
    this.database.prepare(`
      UPDATE agent_runs
      SET project_id = ?, decision_id = ?, goal_id = ?, milestone_id = ?, agent = ?, kind = ?, provider = ?,
          title = ?, status = ?, session_id = ?, working_directory = ?, started_at = ?,
          completed_at = ?, summary = ?, draft_prompt = ?, updated_at = ?
      WHERE id = ?
    `).run(
      run.projectId,
      run.decisionId ?? null,
      run.goalId ?? null,
      run.milestoneId ?? null,
      run.provider,
      run.provider === 'pi' ? 'general' : 'coding',
      run.provider,
      run.title,
      run.status,
      run.sessionId,
      run.workingDirectory,
      run.startedAt,
      run.completedAt,
      run.summary,
      run.draftPrompt,
      run.updatedAt,
      run.id
    )
    const updated = this.getAgentRun(run.id)
    this.enqueueCompanionEvent('agent-run.updated', 'agent-run', updated.id, updated)
    return updated
    })
  }

  recoverInterruptedAgentRuns(recoveredAt: string): number {
    const rows = this.database.prepare(`
      SELECT id FROM agent_runs WHERE status IN ('queued', 'running')
    `).all() as SqlRow[]
    if (rows.length === 0) return 0
    return this.companionTransaction(() => {
    this.database.prepare(`
      UPDATE agent_runs
      SET status = 'failed', completed_at = ?,
          summary = '上一次运行被应用退出或重启中断，可以发送新消息继续这个 Session。',
          updated_at = ?
      WHERE status IN ('queued', 'running')
    `).run(recoveredAt, recoveredAt)
    const insertMessage = this.database.prepare(`
      INSERT INTO agent_run_messages (
        id, run_id, role, content, event_type, tool_name, metadata_json, created_at
      ) VALUES (?, ?, 'system', ?, 'error', NULL, NULL, ?)
    `)
    for (const row of rows) {
      const runId = String(row.id)
      const messageId = randomUUID()
      const content = '上一次运行被应用退出或重启中断。这个 Session 已停止，你可以发送新消息继续。'
      insertMessage.run(
        messageId,
        runId,
        content,
        recoveredAt
      )
      this.enqueueCompanionEvent('agent-message.created', 'agent-message', messageId, {
        id: messageId,
        runId,
        role: 'system',
        content,
        eventType: 'error',
        toolName: null,
        metadata: null,
        createdAt: recoveredAt
      } satisfies AgentRunMessage)
      const run = this.getAgentRun(runId)
      this.enqueueCompanionEvent('agent-run.updated', 'agent-run', runId, run)
    }
    return rows.length
    })
  }

  createAgentRunMessage(message: AgentRunMessage): AgentRunMessage {
    return this.companionTransaction(() => {
    this.database.prepare(`
      INSERT INTO agent_run_messages (
        id, run_id, role, content, event_type, tool_name, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.runId,
      message.role,
      message.content,
      message.eventType,
      message.toolName,
      message.metadata ? JSON.stringify(message.metadata) : null,
      message.createdAt
    )
    this.enqueueCompanionEvent('agent-message.created', 'agent-message', message.id, message)
    return message
    })
  }

  upsertAgentRunArtifact(artifact: AgentRunArtifact): AgentRunArtifact {
    return this.companionTransaction(() => {
    this.database.prepare(`
      INSERT INTO agent_run_artifacts (
        id, run_id, project_id, relative_path, label, mime_type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, relative_path) DO UPDATE SET
        label = excluded.label,
        mime_type = excluded.mime_type,
        created_at = excluded.created_at
    `).run(
      artifact.id,
      artifact.runId,
      artifact.projectId,
      artifact.relativePath,
      artifact.label,
      artifact.mimeType,
      artifact.createdAt
    )
    const row = this.database.prepare(`
      SELECT id FROM agent_run_artifacts WHERE run_id = ? AND relative_path = ?
    `).get(artifact.runId, artifact.relativePath) as { id: string }
    const persisted = this.getAgentRunArtifact(row.id) as AgentRunArtifact
    this.enqueueCompanionEvent('artifact.updated', 'artifact', persisted.id, persisted)
    return persisted
    })
  }

  enqueueCompanionSnapshot(modelLabels: AgentModelLabels = emptyAgentModelLabels): CompanionOutboxEvent {
    const snapshot: CompanionSnapshotPayload = {
      generatedAt: new Date().toISOString(),
      modelLabels,
      projects: this.listProjects(),
      goals: this.listGoals(),
      decisions: this.listDecisions(),
      morningBriefings: this.listMorningBriefings(),
      workAssistantMessages: this.listBriefingMessages(),
      attachments: [],
      runs: this.listRuns().map((run) => this.getAgentRunDetail(run.id))
    }
    return this.enqueueCompanionEvent('snapshot.created', 'snapshot', 'current', snapshot)
  }

  enqueueAgentTurnSettled(payload: AgentTurnSettledPayload): CompanionOutboxEvent {
    return this.enqueueCompanionEvent('agent-turn.settled', 'agent-run', payload.runId, payload)
  }

  enqueueCompanionModelLabels(modelLabels: AgentModelLabels): CompanionOutboxEvent {
    return this.enqueueCompanionEvent('model-labels.updated', 'settings', 'models', modelLabels)
  }

  enqueueCompanionPairingSnapshot(modelLabels: AgentModelLabels = emptyAgentModelLabels): CompanionOutboxEvent {
    return this.companionTransaction(() => {
      this.database.prepare('DELETE FROM companion_sync_outbox WHERE published_at IS NULL').run()
      return this.enqueueCompanionSnapshot(modelLabels)
    })
  }

  listPendingCompanionEvents(limit = 100): CompanionOutboxEvent[] {
    const rows = this.database.prepare(`
      SELECT * FROM companion_sync_outbox
      WHERE published_at IS NULL
      ORDER BY rowid ASC
      LIMIT ?
    `).all(limit) as SqlRow[]
    return rows.map((row) => ({
      eventId: String(row.event_id),
      protocolVersion: Number(row.protocol_version),
      type: String(row.type) as CompanionEventType,
      entityType: row.entity_type as CompanionEntityType,
      entityId: String(row.entity_id),
      revision: Number(row.revision),
      payload: parseJson<unknown>(String(row.payload_json), null),
      occurredAt: String(row.occurred_at),
      attempts: Number(row.attempts),
      lastError: row.last_error ? String(row.last_error) : null
    } as unknown as CompanionOutboxEvent))
  }

  countPendingCompanionEvents(): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM companion_sync_outbox WHERE published_at IS NULL
    `).get() as SqlRow
    return Number(row.count)
  }

  markCompanionEventPublished(eventId: string, publishedAt: string): void {
    this.database.prepare(`
      UPDATE companion_sync_outbox SET published_at = ?, last_error = NULL WHERE event_id = ?
    `).run(publishedAt, eventId)
  }

  prunePublishedCompanionEvents(retentionDays = 30, batchSize = 1_000): number {
    if (!Number.isFinite(retentionDays) || retentionDays < 1) throw new Error('Retention days must be at least 1.')
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new Error('Companion event cleanup batch size must be between 1 and 10000.')
    }
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
    const result = this.database.prepare(`
      DELETE FROM companion_sync_outbox
      WHERE event_id IN (
        SELECT event_id FROM companion_sync_outbox
        WHERE published_at IS NOT NULL AND published_at < ?
        ORDER BY published_at ASC
        LIMIT ?
      )
    `).run(cutoff, batchSize)
    return Number(result.changes)
  }

  markCompanionEventFailed(eventId: string, error: string): void {
    this.database.prepare(`
      UPDATE companion_sync_outbox
      SET attempts = attempts + 1, last_error = ?
      WHERE event_id = ?
    `).run(error.slice(0, 2_000), eventId)
  }

  getCompanionCommand(commandId: string): CompanionCommand | null {
    const row = this.database.prepare(`
      SELECT * FROM companion_remote_commands WHERE command_id = ?
    `).get(commandId) as SqlRow | undefined
    if (!row) return null
    return {
      commandId: String(row.command_id),
      protocolVersion: Number(row.protocol_version),
      type: String(row.type) as CompanionCommand['type'],
      payload: parseJson<unknown>(String(row.payload_json), null),
      sourceDeviceId: String(row.source_device_id),
      status: String(row.status) as CompanionCommandStatus,
      result: parseJson<unknown>(row.result_json ? String(row.result_json) : null, null),
      error: row.error ? String(row.error) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    } as unknown as CompanionCommand
  }

  upsertCompanionCommand(command: CompanionCommand): CompanionCommand {
    this.database.prepare(`
      INSERT INTO companion_remote_commands (
        command_id, protocol_version, type, payload_json, source_device_id,
        status, result_json, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(command_id) DO UPDATE SET
        status = excluded.status,
        result_json = excluded.result_json,
        error = excluded.error,
        updated_at = excluded.updated_at
    `).run(
      command.commandId,
      command.protocolVersion,
      command.type,
      JSON.stringify(command.payload),
      command.sourceDeviceId,
      command.status,
      command.result == null ? null : JSON.stringify(command.result),
      command.error,
      command.createdAt,
      command.updatedAt
    )
    return this.getCompanionCommand(command.commandId) as CompanionCommand
  }

  updateCompanionCommand(
    commandId: string,
    status: CompanionCommandStatus,
    result: unknown = null,
    error: string | null = null
  ): CompanionCommand {
    this.database.prepare(`
      UPDATE companion_remote_commands
      SET status = ?, result_json = ?, error = ?, updated_at = ?
      WHERE command_id = ?
    `).run(status, result == null ? null : JSON.stringify(result), error, new Date().toISOString(), commandId)
    const command = this.getCompanionCommand(commandId)
    if (!command) throw new Error(`Companion command not found: ${commandId}`)
    return command
  }

  private companionTransaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private enqueueCompanionEvent<TType extends CompanionEventType>(
    type: TType,
    entityType: (typeof companionEventDefinitions)[TType],
    entityId: string,
    payload: CompanionEventPayloadMap[TType]
  ): CompanionOutboxEvent<TType> {
    const occurredAt = new Date().toISOString()
    const event = {
      eventId: randomUUID(),
      protocolVersion: companionProtocolVersion,
      type,
      entityType,
      entityId,
      revision: Date.now(),
      payload,
      occurredAt,
      attempts: 0,
      lastError: null
    } as unknown as CompanionOutboxEvent<TType>
    this.database.prepare(`
      INSERT INTO companion_sync_outbox (
        event_id, protocol_version, type, entity_type, entity_id, revision,
        payload_json, occurred_at, published_at, attempts, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL)
    `).run(
      event.eventId,
      event.protocolVersion,
      event.type,
      event.entityType,
      event.entityId,
      event.revision,
      JSON.stringify(event.payload),
      event.occurredAt
    )
    queueMicrotask(() => {
      for (const listener of this.companionEventListeners) listener()
    })
    return event
  }

  recordPermissionEvaluation(
    intent: PermissionIntent,
    evaluation: PermissionEvaluation
  ): AuditEntry {
    const entry: AuditEntry = {
      id: randomUUID(),
      intent,
      evaluation,
      outcome: evaluation.decision === 'auto-approved' ? 'approved' : 'pending',
      createdAt: new Date().toISOString()
    }

    this.database.prepare(`
      INSERT INTO audit_entries (id, intent_json, evaluation_json, outcome, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      entry.id,
      JSON.stringify(entry.intent),
      JSON.stringify(entry.evaluation),
      entry.outcome,
      entry.createdAt
    )

    return entry
  }

  updateAuditOutcome(id: string, outcome: AuditEntry['outcome']): void {
    const result = this.database.prepare('UPDATE audit_entries SET outcome = ? WHERE id = ?').run(outcome, id)
    if (result.changes === 0) throw new Error(`Audit entry not found: ${id}`)
  }

  private ensureCurrentSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        icon TEXT,
        summary TEXT NOT NULL,
        focus TEXT NOT NULL,
        status TEXT NOT NULL,
        accent TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        profile_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS project_goals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'P1',
        metric_json TEXT NOT NULL DEFAULT '{}',
        deadline TEXT,
        next_check_in_at TEXT,
        progress REAL NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 0.5,
        agent_summary TEXT NOT NULL DEFAULT '',
        monitoring_sources_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS goal_milestones (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES project_goals(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        due_at TEXT,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS goal_checkins (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES project_goals(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        progress REAL NOT NULL,
        summary TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        generation TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS decision_items (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id),
        goal_id TEXT REFERENCES project_goals(id),
        dedupe_key TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        impact TEXT NOT NULL,
        urgency TEXT NOT NULL,
        confidence REAL NOT NULL,
        suggested_actions_json TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        first_seen_at TEXT,
        last_seen_at TEXT,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        resolved_at TEXT,
        resolution_summary TEXT,
        auto_completion_key TEXT,
        auto_completion_suppressed_key TEXT,
        waiting_reason TEXT,
        status_summary TEXT,
        status_updated_at TEXT,
        reopen_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS decision_observations (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL REFERENCES decision_items(id) ON DELETE CASCADE,
        observation_key TEXT NOT NULL,
        state TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(decision_id, observation_key)
      );

      CREATE TABLE IF NOT EXISTS decision_status_events (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL REFERENCES decision_items(id) ON DELETE CASCADE,
        from_status TEXT,
        to_status TEXT NOT NULL,
        waiting_reason TEXT,
        reason TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        actor_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS decision_status_events_decision_idx
      ON decision_status_events(decision_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS decision_remediations (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL REFERENCES decision_items(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        state TEXT NOT NULL,
        summary TEXT NOT NULL,
        next_action TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(decision_id, source_type, source_ref)
      );

      CREATE INDEX IF NOT EXISTS decision_remediations_decision_idx
      ON decision_remediations(decision_id, last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id),
        goal_id TEXT REFERENCES project_goals(id),
        agent TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        summary TEXT NOT NULL,
        draft_prompt TEXT,
        created_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_run_messages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        event_type TEXT,
        tool_name TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_run_messages_run
      ON agent_run_messages(run_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS agent_run_artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id),
        relative_path TEXT NOT NULL,
        label TEXT NOT NULL,
        mime_type TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, relative_path)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_run_artifacts_run
      ON agent_run_artifacts(run_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS audit_entries (
        id TEXT PRIMARY KEY,
        intent_json TEXT NOT NULL,
        evaluation_json TEXT NOT NULL,
        outcome TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS companion_sync_outbox (
        event_id TEXT PRIMARY KEY,
        protocol_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        published_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS companion_sync_outbox_pending_idx
      ON companion_sync_outbox(published_at, occurred_at);

      CREATE TABLE IF NOT EXISTS companion_remote_commands (
        command_id TEXT PRIMARY KEY,
        protocol_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        source_device_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS connector_instances (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        credential_ref TEXT,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        last_checked_at TEXT,
        last_sync_at TEXT,
        last_error TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS connector_runs (
        id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL REFERENCES connector_instances(id),
        project_id TEXT NOT NULL REFERENCES projects(id),
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        decision_id TEXT REFERENCES decision_items(id),
        data_json TEXT
      );

      CREATE TABLE IF NOT EXISTS daily_briefings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        report_date TEXT NOT NULL,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL,
        headline TEXT NOT NULL,
        body TEXT NOT NULL,
        metrics_json TEXT,
        signal_ids_json TEXT NOT NULL DEFAULT '[]',
        generated_at TEXT NOT NULL,
        error TEXT,
        generation TEXT NOT NULL,
        UNIQUE(project_id, report_date)
      );

      CREATE TABLE IF NOT EXISTS morning_briefings (
        id TEXT PRIMARY KEY,
        report_date TEXT NOT NULL UNIQUE,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL,
        headline TEXT NOT NULL,
        body TEXT NOT NULL,
        narration TEXT NOT NULL,
        estimated_duration_seconds INTEGER NOT NULL,
        source_briefing_ids_json TEXT NOT NULL DEFAULT '[]',
        signal_ids_json TEXT NOT NULL DEFAULT '[]',
        generated_at TEXT NOT NULL,
        error TEXT,
        generation TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS briefing_messages (
        id TEXT PRIMARY KEY,
        briefing_id TEXT NOT NULL REFERENCES morning_briefings(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS work_assistant_messages (
        id TEXT PRIMARY KEY,
        source_briefing_id TEXT REFERENCES morning_briefings(id) ON DELETE SET NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        task_context_json TEXT,
        linked_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        actions_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        schedule_description TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        timezone TEXT NOT NULL,
        action TEXT NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        agent_kind TEXT NOT NULL DEFAULT 'general',
        agent_provider TEXT NOT NULL DEFAULT 'pi',
        enabled INTEGER NOT NULL DEFAULT 1,
        requires_confirmation INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 0,
        retry_delay_seconds INTEGER NOT NULL DEFAULT 30,
        status TEXT NOT NULL DEFAULT 'idle',
        last_run_at TEXT,
        next_run_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        summary TEXT NOT NULL,
        error TEXT,
        agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS decision_status_created_idx
      ON decision_items(status, created_at DESC);

      CREATE INDEX IF NOT EXISTS decision_observations_decision_idx
      ON decision_observations(decision_id, observed_at DESC);

      CREATE INDEX IF NOT EXISTS project_goals_status_checkin_idx
      ON project_goals(project_id, status, next_check_in_at);

      CREATE INDEX IF NOT EXISTS goal_milestones_goal_idx
      ON goal_milestones(goal_id, sort_order);

      CREATE INDEX IF NOT EXISTS goal_checkins_goal_created_idx
      ON goal_checkins(goal_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS connector_runs_started_idx
      ON connector_runs(connector_id, started_at DESC);

      CREATE INDEX IF NOT EXISTS daily_briefings_report_idx
      ON daily_briefings(project_id, report_date DESC);

      CREATE INDEX IF NOT EXISTS briefing_messages_created_idx
      ON briefing_messages(briefing_id, created_at ASC);

      CREATE INDEX IF NOT EXISTS work_assistant_messages_created_idx
      ON work_assistant_messages(created_at ASC);

      CREATE INDEX IF NOT EXISTS automation_jobs_schedule_idx
      ON automation_jobs(enabled, next_run_at);

      CREATE INDEX IF NOT EXISTS automation_runs_job_idx
      ON automation_runs(automation_id, started_at DESC);
    `)

    this.database.exec(`
      INSERT OR IGNORE INTO work_assistant_messages (
        id, source_briefing_id, role, content, task_context_json, created_at
      )
      SELECT id, briefing_id, role, content, NULL, created_at
      FROM briefing_messages;
    `)

    const projectColumns = this.database.prepare('PRAGMA table_info(projects)').all() as Array<{
      name: string
    }>
    if (!projectColumns.some((column) => column.name === 'profile_json')) {
      this.database.exec("ALTER TABLE projects ADD COLUMN profile_json TEXT NOT NULL DEFAULT '{}'")
    }
    if (!projectColumns.some((column) => column.name === 'icon')) {
      this.database.exec('ALTER TABLE projects ADD COLUMN icon TEXT')
    }

    const workAssistantMessageColumns = this.database.prepare('PRAGMA table_info(work_assistant_messages)').all() as Array<{
      name: string
    }>
    if (!workAssistantMessageColumns.some((column) => column.name === 'attachments_json')) {
      this.database.exec("ALTER TABLE work_assistant_messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'")
    }
    if (!workAssistantMessageColumns.some((column) => column.name === 'linked_run_id')) {
      this.database.exec('ALTER TABLE work_assistant_messages ADD COLUMN linked_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL')
    }
    if (!workAssistantMessageColumns.some((column) => column.name === 'actions_json')) {
      this.database.exec("ALTER TABLE work_assistant_messages ADD COLUMN actions_json TEXT NOT NULL DEFAULT '[]'")
    }

    const connectorRunColumns = this.database.prepare('PRAGMA table_info(connector_runs)').all() as Array<{
      name: string
    }>
    if (!connectorRunColumns.some((column) => column.name === 'data_json')) {
      this.database.exec('ALTER TABLE connector_runs ADD COLUMN data_json TEXT')
    }

    const goalColumns = this.database.prepare('PRAGMA table_info(project_goals)').all() as Array<{
      name: string
    }>
    if (!goalColumns.some((column) => column.name === 'priority')) {
      this.database.exec("ALTER TABLE project_goals ADD COLUMN priority TEXT NOT NULL DEFAULT 'P1'")
    }

    const decisionColumns = this.database.prepare('PRAGMA table_info(decision_items)').all() as Array<{
      name: string
    }>
    if (!decisionColumns.some((column) => column.name === 'goal_id')) {
      this.database.exec('ALTER TABLE decision_items ADD COLUMN goal_id TEXT REFERENCES project_goals(id)')
    }
    if (!decisionColumns.some((column) => column.name === 'dedupe_key')) {
      this.database.exec('ALTER TABLE decision_items ADD COLUMN dedupe_key TEXT')
    }
    if (!decisionColumns.some((column) => column.name === 'first_seen_at')) {
      this.database.exec('ALTER TABLE decision_items ADD COLUMN first_seen_at TEXT')
    }
    if (!decisionColumns.some((column) => column.name === 'last_seen_at')) {
      this.database.exec('ALTER TABLE decision_items ADD COLUMN last_seen_at TEXT')
    }
    if (!decisionColumns.some((column) => column.name === 'occurrence_count')) {
      this.database.exec('ALTER TABLE decision_items ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1')
    }
    if (!decisionColumns.some((column) => column.name === 'resolved_at')) {
      this.database.exec('ALTER TABLE decision_items ADD COLUMN resolved_at TEXT')
    }
    if (!decisionColumns.some((column) => column.name === 'resolution_summary')) {
      this.database.exec('ALTER TABLE decision_items ADD COLUMN resolution_summary TEXT')
    }
    if (!decisionColumns.some((column) => column.name === 'auto_completion_key')) {
      this.database.exec('ALTER TABLE decision_items ADD COLUMN auto_completion_key TEXT')
    }
    if (!decisionColumns.some((column) => column.name === 'auto_completion_suppressed_key')) {
      this.database.exec('ALTER TABLE decision_items ADD COLUMN auto_completion_suppressed_key TEXT')
    }
    if (!decisionColumns.some((column) => column.name === 'waiting_reason')) {
      this.database.exec('ALTER TABLE decision_items ADD COLUMN waiting_reason TEXT')
    }
    if (!decisionColumns.some((column) => column.name === 'status_summary')) {
      this.database.exec('ALTER TABLE decision_items ADD COLUMN status_summary TEXT')
    }
    if (!decisionColumns.some((column) => column.name === 'status_updated_at')) {
      this.database.exec('ALTER TABLE decision_items ADD COLUMN status_updated_at TEXT')
    }
    if (!decisionColumns.some((column) => column.name === 'reopen_count')) {
      this.database.exec('ALTER TABLE decision_items ADD COLUMN reopen_count INTEGER NOT NULL DEFAULT 0')
    }
    this.database.exec(`
      UPDATE decision_items
      SET first_seen_at = COALESCE(first_seen_at, created_at),
          last_seen_at = COALESCE(last_seen_at, created_at),
          occurrence_count = COALESCE(occurrence_count, 1),
          status = CASE WHEN status = 'later' THEN 'waiting' ELSE status END,
          waiting_reason = CASE WHEN status = 'later' THEN 'user' ELSE waiting_reason END,
          status_summary = CASE WHEN status = 'later' THEN COALESCE(status_summary, '等待用户稍后处理。') ELSE status_summary END,
          status_updated_at = COALESCE(status_updated_at, resolved_at, last_seen_at, created_at),
          reopen_count = COALESCE(reopen_count, 0)
    `)
    this.database.exec(`
      INSERT INTO decision_status_events (
        id, decision_id, from_status, to_status, waiting_reason, reason,
        evidence_refs_json, actor_type, created_at
      )
      SELECT lower(hex(randomblob(16))), id, NULL, status, waiting_reason,
        COALESCE(status_summary, '迁移现有事项状态。'), evidence_refs_json, 'system',
        COALESCE(status_updated_at, created_at)
      FROM decision_items
      WHERE NOT EXISTS (
        SELECT 1 FROM decision_status_events WHERE decision_status_events.decision_id = decision_items.id
      )
    `)
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS decision_lifecycle_idx
      ON decision_items(project_id, dedupe_key, status)
    `)

    const agentRunColumns = this.database.prepare('PRAGMA table_info(agent_runs)').all() as Array<{
      name: string
    }>
    if (!agentRunColumns.some((column) => column.name === 'goal_id')) {
      this.database.exec('ALTER TABLE agent_runs ADD COLUMN goal_id TEXT REFERENCES project_goals(id)')
    }
    if (!agentRunColumns.some((column) => column.name === 'decision_id')) {
      this.database.exec('ALTER TABLE agent_runs ADD COLUMN decision_id TEXT REFERENCES decision_items(id)')
    }
    if (!agentRunColumns.some((column) => column.name === 'milestone_id')) {
      this.database.exec('ALTER TABLE agent_runs ADD COLUMN milestone_id TEXT REFERENCES goal_milestones(id)')
    }
    if (!agentRunColumns.some((column) => column.name === 'kind')) {
      this.database.exec("ALTER TABLE agent_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'general'")
    }
    if (!agentRunColumns.some((column) => column.name === 'provider')) {
      this.database.exec("ALTER TABLE agent_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'pi'")
    }
    if (!agentRunColumns.some((column) => column.name === 'session_id')) {
      this.database.exec('ALTER TABLE agent_runs ADD COLUMN session_id TEXT')
    }
    if (!agentRunColumns.some((column) => column.name === 'working_directory')) {
      this.database.exec('ALTER TABLE agent_runs ADD COLUMN working_directory TEXT')
    }
    if (!agentRunColumns.some((column) => column.name === 'updated_at')) {
      this.database.exec('ALTER TABLE agent_runs ADD COLUMN updated_at TEXT')
    }
    if (!agentRunColumns.some((column) => column.name === 'archived_at')) {
      this.database.exec('ALTER TABLE agent_runs ADD COLUMN archived_at TEXT')
    }
    if (!agentRunColumns.some((column) => column.name === 'draft_prompt')) {
      this.database.exec('ALTER TABLE agent_runs ADD COLUMN draft_prompt TEXT')
    }
    this.database.exec(`
      UPDATE agent_runs
      SET provider = CASE agent
        WHEN 'assistant' THEN 'pi'
        WHEN 'codex' THEN 'codex'
        WHEN 'claude' THEN 'claude'
        ELSE COALESCE(NULLIF(provider, ''), 'pi')
      END,
      kind = CASE
        WHEN CASE agent
          WHEN 'assistant' THEN 'pi'
          WHEN 'codex' THEN 'codex'
          WHEN 'claude' THEN 'claude'
          ELSE COALESCE(NULLIF(provider, ''), 'pi')
        END = 'pi' THEN 'general'
        ELSE 'coding'
      END,
      updated_at = COALESCE(updated_at, started_at, created_at)
    `)
    this.database.exec(`
      UPDATE agent_runs
      SET decision_id = (
        SELECT decision_items.id
        FROM decision_items
        WHERE decision_items.project_id IS agent_runs.project_id
          AND agent_runs.title = '处理 · ' || decision_items.title
        ORDER BY decision_items.first_seen_at ASC, decision_items.created_at ASC
        LIMIT 1
      )
      WHERE decision_id IS NULL
        AND title LIKE '处理 · %'
    `)
  }

  private migrateAgentRunWorkspaces(): void {
    const runs = this.database.prepare(`
      SELECT id, project_id, provider, session_id, working_directory
      FROM agent_runs
      WHERE project_id IS NOT NULL AND provider = 'pi'
    `).all() as SqlRow[]
    const projects = this.listProjects()
    for (const run of runs) {
      const projectId = String(run.project_id)
      const project = projects.find((item) => item.id === projectId)
      if (!project) continue
      const primary = normalizeWorkspaceRoots(project.profile).repoPath
      if (!primary) continue
      const current = run.working_directory ? String(run.working_directory) : ''
      const isLegacyFilesDirectory = current.includes('/project-files/')
      if (!current || isLegacyFilesDirectory) {
        this.database.prepare(`
          UPDATE agent_runs
          SET kind = 'general', working_directory = ?, session_id = NULL, updated_at = COALESCE(updated_at, created_at)
          WHERE id = ?
        `).run(primary, String(run.id))
      }
    }
  }

  private migrateProjectWorkspaceProfiles(): void {
    const update = this.database.prepare('UPDATE projects SET profile_json = ? WHERE id = ?')
    for (const project of this.listProjects()) {
      update.run(JSON.stringify(project.profile), project.id)
    }
  }

  private seed(): void {
    const projects: Project[] = [
      {
        id: 'roombase',
        name: 'Roombase',
        summary: '面向自习室及多行业门店的经营小程序',
        focus: 'Growth / Data / Operations',
        status: 'active',
        accent: '#e45f55',
        profile: {
          productType: '多行业门店 · 小程序',
          stage: '运营与增长',
          mission: '建立可复用的获客与转化体系，找到能持续拉新的宣传渠道。',
          vision: '成为多行业线下门店可以持续依赖的数字化经营与增长平台。',
          repoPath: '/Users/kai/Code/shopmy',
          workspaceRoots: [{ id: 'primary', label: 'shopmy', path: '/Users/kai/Code/shopmy' }],
          primaryWorkspaceRootId: 'primary',
          defaultAgent: 'codex',
          websiteUrl: 'https://roombase.cn',
          surfaces: ['微信小程序', '官网'],
          focusAreas: ['数据分析', 'Marketing', '拉新转化', '客服洞察'],
          dataSources: ['小程序业务数据', 'Google Analytics', 'Cloudflare', '渠道投放'],
          nextMoves: ['建立获客漏斗基线', '梳理行业细分卖点', '设计首轮渠道实验'],
          currentState: {
            summary: '正在建立可复用的获客、转化与运营数据闭环。',
            facts: [],
            source: 'agent',
            updatedAt: null
          }
        }
      },
      {
        id: 'vows',
        name: 'Vows',
        summary: '婚礼与活动邀请、宾客管理工具',
        focus: 'Growth / Product / Delivery',
        status: 'active',
        accent: '#8d6fd1',
        profile: {
          productType: '活动工具 · 小程序 / H5',
          stage: '验证与扩展',
          mission: '先验证婚礼场景的增长闭环，再扩展为多种活动的邀请和管理工具。',
          vision: '让每一种值得纪念的活动，都能轻松完成邀请、分享和宾客管理。',
          repoPath: '/Users/kai/Code/wedding-app',
          workspaceRoots: [{ id: 'primary', label: 'wedding-app', path: '/Users/kai/Code/wedding-app' }],
          primaryWorkspaceRootId: 'primary',
          defaultAgent: 'codex',
          websiteUrl: null,
          surfaces: ['微信小程序', 'H5（规划）'],
          focusAreas: ['营销推广', '邀请转化', '模板内容', 'H5 扩展'],
          dataSources: ['小程序行为数据', '活动创建漏斗', '分享与访问数据', '营销 Agent 输出'],
          nextMoves: ['接入现有营销 Agent', '定义邀请传播漏斗', '评估 H5 最小范围'],
          currentState: {
            summary: '婚礼 Event 创建流程已可用，正在转向获客和场景扩展。',
            facts: [],
            source: 'agent',
            updatedAt: null
          }
        }
      },
      {
        id: 'ai-marketing',
        name: 'AI Marketing',
        summary: '品牌图片与带货视频的自动化素材工作台',
        focus: 'Product / Customer Validation',
        status: 'active',
        accent: '#327bd6',
        profile: {
          productType: 'To B · AI 内容工作台',
          stage: 'Active Development',
          mission: '用真实品牌试点跑通从商品信息到可投放图片、视频素材的自动化产线。',
          vision: '让品牌以更低的成本持续获得可直接投放的高质量营销素材。',
          repoPath: '/Users/kai/Code/marketing-tool',
          workspaceRoots: [{ id: 'primary', label: 'marketing-tool', path: '/Users/kai/Code/marketing-tool' }],
          primaryWorkspaceRootId: 'primary',
          defaultAgent: 'codex',
          websiteUrl: null,
          surfaces: ['Web 工作台', '自动化产线'],
          focusAreas: ['产品开发', '品牌工作流', '素材质量', '交付效率'],
          dataSources: ['牙刷品牌试点', '婴儿睡袋品牌试点', '生成任务记录', '品牌反馈'],
          nextMoves: ['定义试点验收指标', '固化品牌素材工作流', '测量单条素材成本与耗时'],
          currentState: {
            summary: '正在用两个真实品牌验证素材自动化工作流。',
            facts: [],
            source: 'agent',
            updatedAt: null
          }
        }
      }
    ]

    const insertProject = this.database.prepare(`
      INSERT INTO projects (id, name, summary, focus, status, accent, sort_order, profile_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `)

    this.database.prepare("DELETE FROM decision_items WHERE project_id IN ('vault', 'trading')").run()
    this.database.prepare("DELETE FROM agent_runs WHERE project_id IN ('vault', 'trading')").run()
    this.database.prepare("DELETE FROM projects WHERE id IN ('vault', 'trading')").run()
    this.database
      .prepare("DELETE FROM decision_items WHERE id IN ('decision-roombase-growth', 'decision-nightly-complete')")
      .run()
    this.database.prepare("DELETE FROM agent_runs WHERE id IN ('run-nightly', 'run-vault-review')").run()
    this.database.prepare(`
      UPDATE connector_runs
      SET decision_id = NULL
      WHERE decision_id IN (
        SELECT id FROM decision_items
        WHERE source = 'Repo Connector'
      )
    `).run()
    this.database.prepare(`
      DELETE FROM decision_items
      WHERE source = 'Repo Connector'
    `).run()

    projects.forEach((project, index) => {
      insertProject.run(
        project.id,
        project.name,
        project.summary,
        project.focus,
        project.status,
        project.accent,
        index,
        JSON.stringify(project.profile)
      )
    })

    // Remove the static goal examples used before goals were backed by live project analysis.
    const legacyGoalIds = [
      'goal-roombase-growth',
      'goal-vows-growth-loop',
      'goal-ai-marketing-pilots'
    ]
    const placeholders = legacyGoalIds.map(() => '?').join(', ')
    this.database.prepare(`UPDATE decision_items SET goal_id = NULL WHERE goal_id IN (${placeholders})`).run(...legacyGoalIds)
    this.database.prepare(`UPDATE agent_runs SET goal_id = NULL WHERE goal_id IN (${placeholders})`).run(...legacyGoalIds)
    this.database.prepare(`DELETE FROM project_goals WHERE id IN (${placeholders})`).run(...legacyGoalIds)

    this.database.prepare(`
      INSERT INTO connector_instances (
        id, project_id, kind, name, enabled, status, config_json,
        credential_ref, capabilities_json, sort_order
      ) VALUES (?, ?, 'postgres', ?, 1, 'needs-setup', ?, NULL, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      'postgres-roombase',
      'roombase',
      'Roombase Production Analytics',
      JSON.stringify({
        credentialSource: 'env-file',
        envFilePath: '/Users/kai/Code/shopmy/packages/api/.env',
        envKey: 'DATABASE_URL',
        analyticsProfile: 'roombase-daily-v0'
      }),
      JSON.stringify(['health', 'collect', 'analytics-profile', 'evidence']),
      100
    )

    const insertConnector = this.database.prepare(`
      INSERT INTO connector_instances (
        id, project_id, kind, name, enabled, status, config_json,
        credential_ref, capabilities_json, sort_order
      ) VALUES (?, ?, 'repo', ?, 1, 'needs-setup', ?, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        name = excluded.name,
        config_json = excluded.config_json,
        capabilities_json = excluded.capabilities_json,
        sort_order = excluded.sort_order
    `)

    this.listProjects().forEach((project, index) => {
      insertConnector.run(
        `repo-${project.id}`,
        project.id,
        `${project.name} Repo`,
        JSON.stringify({ repoPath: project.profile.repoPath }),
        JSON.stringify(['health', 'collect', 'evidence']),
        index
      )
    })

    // Old static inbox items and Agent Run examples are removed once live Connectors are available.
    this.database.prepare(`
      UPDATE connector_runs
      SET decision_id = NULL
      WHERE decision_id IN (
        'decision-roombase-acquisition-baseline',
        'decision-vows-growth',
        'decision-ai-marketing-pilots',
        'decision-projects-onboarded'
      )
    `).run()
    this.database.prepare(`
      DELETE FROM decision_items
      WHERE id IN (
        'decision-roombase-acquisition-baseline',
        'decision-vows-growth',
        'decision-ai-marketing-pilots',
        'decision-projects-onboarded'
      )
    `).run()
    this.database.prepare(`
      DELETE FROM agent_runs
      WHERE id IN ('run-portfolio-briefing', 'run-vows-marketing-audit')
    `).run()
  }

  private insertDecision(item: DecisionItem): void {
    this.database.prepare(`
      INSERT INTO decision_items (
        id, project_id, goal_id, dedupe_key, kind, title, summary, impact, urgency, confidence,
        suggested_actions_json, evidence_refs_json, status, source, created_at,
        first_seen_at, last_seen_at, occurrence_count, resolved_at, resolution_summary,
        waiting_reason, status_summary, status_updated_at, reopen_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id,
      item.projectId,
      item.goalId ?? null,
      item.dedupeKey ?? null,
      item.kind,
      item.title,
      item.summary,
      item.impact,
      item.urgency,
      item.confidence,
      JSON.stringify(item.suggestedActions),
      JSON.stringify(item.evidenceRefs),
      item.status,
      item.source,
      item.createdAt,
      item.firstSeenAt ?? item.createdAt,
      item.lastSeenAt ?? item.createdAt,
      item.occurrenceCount ?? 1,
      item.resolvedAt ?? null,
      item.resolutionSummary ?? null,
      item.waitingReason ?? null,
      item.statusSummary ?? null,
      item.statusUpdatedAt ?? item.createdAt,
      item.reopenCount ?? 0
    )
    this.recordDecisionStatusEvent(item.id, null, item.status, {
      actor: 'system',
      reason: item.statusSummary ?? '事项已创建。',
      waitingReason: item.waitingReason ?? null,
      evidenceRefs: item.evidenceRefs,
      occurredAt: item.statusUpdatedAt ?? item.createdAt
    })
  }

  private getDecision(id: string): DecisionItem {
    const row = this.database.prepare('SELECT * FROM decision_items WHERE id = ?').get(id) as SqlRow | undefined
    if (!row) throw new Error(`Decision item not found: ${id}`)
    return this.mapDecision(row)
  }

  private recordDecisionStatusEvent(
    decisionId: string,
    fromStatus: DecisionStatus | null,
    toStatus: DecisionStatus,
    input: DecisionStatusTransitionInput
  ): void {
    this.database.prepare(`
      INSERT INTO decision_status_events (
        id, decision_id, from_status, to_status, waiting_reason, reason,
        evidence_refs_json, actor_type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      decisionId,
      fromStatus,
      toStatus,
      input.waitingReason ?? null,
      input.reason ?? '事项状态已更新。',
      JSON.stringify(input.evidenceRefs ?? []),
      input.actor,
      input.occurredAt ?? new Date().toISOString()
    )
  }

  private recordDecisionObservation(decisionId: string, input: DecisionInspectionInput): boolean {
    const existing = this.database.prepare(`
      SELECT id FROM decision_observations
      WHERE decision_id = ? AND observation_key = ?
    `).get(decisionId, input.observationKey) as SqlRow | undefined
    const now = new Date().toISOString()
    if (existing) {
      this.database.prepare(`
        UPDATE decision_observations
        SET state = ?, summary = ?, evidence_refs_json = ?, observed_at = ?, created_at = ?
        WHERE id = ?
      `).run(
        input.state,
        input.summary,
        JSON.stringify(input.evidenceRefs),
        input.observedAt,
        now,
        String(existing.id)
      )
      return false
    }
    this.database.prepare(`
      INSERT INTO decision_observations (
        id, decision_id, observation_key, state, summary, evidence_refs_json, observed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      decisionId,
      input.observationKey,
      input.state,
      input.summary,
      JSON.stringify(input.evidenceRefs),
      input.observedAt,
      now
    )
    return true
  }

  private migrateDecisionLifecycle(): void {
    const legacyRows = this.database.prepare(`
      SELECT * FROM decision_items
      WHERE source = '每日项目总结' AND dedupe_key IS NULL
      ORDER BY project_id, title, created_at ASC, id ASC
    `).all() as SqlRow[]
    const groups = new Map<string, SqlRow[]>()
    for (const row of legacyRows) {
      const key = `${String(row.project_id ?? '')}\u0000${String(row.title)}`
      groups.set(key, [...(groups.get(key) ?? []), row])
    }

    for (const rows of groups.values()) {
      const keeper = rows[0]
      const keeperId = String(keeper.id)
      const projectId = keeper.project_id ? String(keeper.project_id) : null
      const title = String(keeper.title)
      const dedupeKey = projectId === 'roombase' && title === 'Roombase 有长期等待平台处理的入驻事项'
        ? 'roombase:onboarding:waiting-platform'
        : projectId === 'roombase' && title === 'Roombase 首次预订用户低于 7 日基线'
          ? 'roombase:activation:first-booking-below-7d'
          : `daily:${projectId ?? 'all'}:${title}`
      const latest = rows[rows.length - 1]
      const open = rows.find((row) => row.status === 'inbox' || row.status === 'in_progress' || row.status === 'waiting' || row.status === 'later')
      const finalStatus = open ? String(open.status) : 'resolved'

      for (const row of rows) {
        this.recordDecisionObservation(keeperId, {
          projectId,
          dedupeKey,
          observationKey: `legacy:${String(row.id)}`,
          state: 'active',
          observedAt: String(row.created_at),
          summary: String(row.summary),
          evidenceRefs: parseJson<EvidenceRef[]>(String(row.evidence_refs_json), [])
        })
      }

      const duplicateIds = rows.slice(1).map((row) => String(row.id))
      for (const duplicateId of duplicateIds) {
        this.database.prepare('UPDATE connector_runs SET decision_id = ? WHERE decision_id = ?').run(keeperId, duplicateId)
        this.database.prepare('UPDATE agent_runs SET decision_id = ? WHERE decision_id = ?').run(keeperId, duplicateId)
        this.database.prepare('UPDATE decision_remediations SET decision_id = ? WHERE decision_id = ?').run(keeperId, duplicateId)
        this.replaceBriefingSignalId('daily_briefings', duplicateId, keeperId)
        this.replaceBriefingSignalId('morning_briefings', duplicateId, keeperId)
        this.database.prepare('DELETE FROM decision_items WHERE id = ?').run(duplicateId)
      }

      this.database.prepare(`
        UPDATE decision_items
        SET dedupe_key = ?, summary = ?, impact = ?, urgency = ?, confidence = ?,
            suggested_actions_json = ?, evidence_refs_json = ?, status = ?,
            first_seen_at = ?, last_seen_at = ?, occurrence_count = ?,
            resolved_at = CASE WHEN ? = 'resolved' THEN COALESCE(resolved_at, ?) ELSE NULL END,
            resolution_summary = CASE WHEN ? = 'resolved' THEN resolution_summary ELSE NULL END
        WHERE id = ?
      `).run(
        dedupeKey,
        String(latest.summary),
        String(latest.impact),
        String(latest.urgency),
        Number(latest.confidence),
        String(latest.suggested_actions_json),
        String(latest.evidence_refs_json),
        finalStatus,
        String(rows[0].created_at),
        String(latest.created_at),
        rows.length,
        finalStatus,
        String(latest.created_at),
        finalStatus,
        keeperId
      )
    }

    this.database.prepare(`
      UPDATE decision_items
      SET suggested_actions_json = ?
      WHERE dedupe_key = 'roombase:onboarding:waiting-platform'
    `).run(JSON.stringify(['检查最老入驻事项的阻塞原因']))
  }

  private replaceBriefingSignalId(table: 'daily_briefings' | 'morning_briefings', oldId: string, newId: string): void {
    const rows = this.database.prepare(`SELECT id, signal_ids_json FROM ${table}`).all() as SqlRow[]
    const update = this.database.prepare(`UPDATE ${table} SET signal_ids_json = ? WHERE id = ?`)
    for (const row of rows) {
      const ids = parseJson<string[]>(String(row.signal_ids_json), [])
      if (!ids.includes(oldId)) continue
      update.run(JSON.stringify([...new Set(ids.map((id) => id === oldId ? newId : id))]), String(row.id))
    }
  }

  private mapAgentRun(row: SqlRow): AgentRun {
    const legacyAgent = row.agent ? String(row.agent) : 'assistant'
    const provider = row.provider
      ? String(row.provider)
      : legacyAgent === 'assistant'
        ? 'pi'
        : legacyAgent
    const createdAt = row.created_at ? String(row.created_at) : new Date().toISOString()
    return {
      id: String(row.id),
      projectId: row.project_id ? String(row.project_id) : null,
      decisionId: row.decision_id ? String(row.decision_id) : null,
      goalId: row.goal_id ? String(row.goal_id) : null,
      milestoneId: row.milestone_id ? String(row.milestone_id) : null,
      provider: provider as AgentRun['provider'],
      title: String(row.title),
      status: row.status as AgentRun['status'],
      sessionId: row.session_id ? String(row.session_id) : null,
      workingDirectory: row.working_directory ? String(row.working_directory) : null,
      startedAt: row.started_at ? String(row.started_at) : null,
      completedAt: row.completed_at ? String(row.completed_at) : null,
      summary: String(row.summary),
      draftPrompt: row.draft_prompt ? String(row.draft_prompt) : null,
      createdAt,
      updatedAt: row.updated_at ? String(row.updated_at) : createdAt
    }
  }

  private mapDecision(row: SqlRow): DecisionItem {
    return {
      id: String(row.id),
      projectId: row.project_id ? String(row.project_id) : null,
      goalId: row.goal_id ? String(row.goal_id) : null,
      dedupeKey: row.dedupe_key ? String(row.dedupe_key) : null,
      kind: row.kind as DecisionItem['kind'],
      title: String(row.title),
      summary: String(row.summary),
      impact: String(row.impact),
      urgency: row.urgency as DecisionItem['urgency'],
      confidence: Number(row.confidence),
      suggestedActions: parseJson<string[]>(String(row.suggested_actions_json), []),
      evidenceRefs: parseJson<EvidenceRef[]>(String(row.evidence_refs_json), []),
      status: (row.status === 'later' ? 'waiting' : row.status) as DecisionItem['status'],
      waitingReason: row.waiting_reason ? String(row.waiting_reason) as DecisionWaitingReason : null,
      statusSummary: row.status_summary ? String(row.status_summary) : null,
      statusUpdatedAt: row.status_updated_at ? String(row.status_updated_at) : String(row.created_at),
      reopenCount: row.reopen_count === null ? 0 : Number(row.reopen_count),
      source: String(row.source),
      createdAt: String(row.created_at),
      firstSeenAt: row.first_seen_at ? String(row.first_seen_at) : String(row.created_at),
      lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : String(row.created_at),
      occurrenceCount: row.occurrence_count === null ? 1 : Number(row.occurrence_count),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
      resolutionSummary: row.resolution_summary ? String(row.resolution_summary) : null
    }
  }

  private mapDecisionRemediation(row: SqlRow): DecisionRemediation {
    return {
      id: String(row.id),
      decisionId: String(row.decision_id),
      sourceType: row.source_type as DecisionRemediation['sourceType'],
      sourceRef: String(row.source_ref),
      state: row.state as DecisionRemediation['state'],
      summary: String(row.summary),
      nextAction: String(row.next_action),
      evidenceRefs: parseJson<EvidenceRef[]>(String(row.evidence_refs_json), []),
      metadata: parseJson<Record<string, unknown>>(String(row.metadata_json), {}),
      firstSeenAt: String(row.first_seen_at),
      lastSeenAt: String(row.last_seen_at)
    }
  }

  private mapGoal(
    row: SqlRow,
    milestoneRows: SqlRow[],
    checkInRows: SqlRow[]
  ): ProjectGoal {
    const milestones: GoalMilestone[] = milestoneRows.map((item) => ({
      id: String(item.id),
      goalId: String(item.goal_id),
      title: String(item.title),
      status: item.status as GoalMilestone['status'],
      dueAt: item.due_at ? String(item.due_at) : null,
      evidenceRefs: parseJson<EvidenceRef[]>(String(item.evidence_refs_json), []),
      sortOrder: Number(item.sort_order),
      createdAt: String(item.created_at),
      updatedAt: String(item.updated_at),
      completedAt: item.completed_at ? String(item.completed_at) : null
    }))
    const checkIns: GoalCheckIn[] = checkInRows.map((item) => ({
      id: String(item.id),
      goalId: String(item.goal_id),
      status: item.status as GoalCheckIn['status'],
      progress: Number(item.progress),
      summary: String(item.summary),
      evidenceRefs: parseJson<EvidenceRef[]>(String(item.evidence_refs_json), []),
      generation: item.generation as GoalCheckIn['generation'],
      createdAt: String(item.created_at)
    }))
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      title: String(row.title),
      description: String(row.description),
      status: row.status as ProjectGoal['status'],
      priority: (row.priority ? String(row.priority) : 'P1') as ProjectGoal['priority'],
      metric: parseJson<ProjectGoal['metric']>(String(row.metric_json), {
        label: '完成度',
        unit: '%',
        baseline: 0,
        current: 0,
        target: 100
      }),
      deadline: row.deadline ? String(row.deadline) : null,
      nextCheckInAt: row.next_check_in_at ? String(row.next_check_in_at) : null,
      progress: Number(row.progress),
      confidence: Number(row.confidence),
      agentSummary: String(row.agent_summary),
      monitoringSources: parseJson<string[]>(String(row.monitoring_sources_json), []),
      milestones,
      checkIns,
      createdBy: row.created_by as ProjectGoal['createdBy'],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at ? String(row.completed_at) : null
    }
  }

  private mapConnector(row: SqlRow): ConnectorInstance {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      kind: row.kind as ConnectorInstance['kind'],
      name: String(row.name),
      enabled: Number(row.enabled) === 1,
      status: row.status as ConnectorInstance['status'],
      config: parseJson<Record<string, string | number | boolean>>(String(row.config_json), {}),
      credentialRef: row.credential_ref ? String(row.credential_ref) : null,
      capabilities: parseJson<string[]>(String(row.capabilities_json), []),
      lastCheckedAt: row.last_checked_at ? String(row.last_checked_at) : null,
      lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null,
      lastError: row.last_error ? String(row.last_error) : null
    }
  }

  private mapAutomation(row: SqlRow): AutomationJob {
    return {
      id: String(row.id),
      projectId: row.project_id ? String(row.project_id) : null,
      name: String(row.name),
      scheduleDescription: String(row.schedule_description),
      cronExpression: String(row.cron_expression),
      timezone: String(row.timezone),
      action: row.action as AutomationJob['action'],
      prompt: String(row.prompt),
      agentProvider: row.agent_provider as AutomationJob['agentProvider'],
      enabled: Number(row.enabled) === 1,
      requiresConfirmation: Number(row.requires_confirmation) === 1,
      maxRetries: Number(row.max_retries),
      retryDelaySeconds: Number(row.retry_delay_seconds),
      status: row.status as AutomationJob['status'],
      lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
      nextRunAt: row.next_run_at ? String(row.next_run_at) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }
  }

  private mapAutomationRun(row: SqlRow): AutomationRun {
    return {
      id: String(row.id),
      automationId: String(row.automation_id),
      status: row.status as AutomationRun['status'],
      trigger: row.trigger as AutomationRun['trigger'],
      attempt: Number(row.attempt),
      startedAt: String(row.started_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
      summary: String(row.summary),
      error: row.error ? String(row.error) : null,
      agentRunId: row.agent_run_id ? String(row.agent_run_id) : null
    }
  }

  private mapDailyBriefing(row: SqlRow): DailyBriefing {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      reportDate: String(row.report_date),
      timezone: String(row.timezone),
      status: row.status as DailyBriefing['status'],
      headline: String(row.headline),
      body: String(row.body),
      metrics: parseJson<Record<string, unknown> | null>(
        row.metrics_json ? String(row.metrics_json) : null,
        null
      ),
      signalIds: parseJson<string[]>(String(row.signal_ids_json), []),
      generatedAt: String(row.generated_at),
      error: row.error ? String(row.error) : null,
      generation: row.generation as DailyBriefing['generation']
    }
  }

  private mapMorningBriefing(row: SqlRow): MorningBriefing {
    return {
      id: String(row.id),
      reportDate: String(row.report_date),
      timezone: String(row.timezone),
      status: row.status as MorningBriefing['status'],
      headline: String(row.headline),
      body: String(row.body),
      narration: String(row.narration),
      estimatedDurationSeconds: Number(row.estimated_duration_seconds),
      sourceBriefingIds: parseJson<string[]>(String(row.source_briefing_ids_json), []),
      signalIds: parseJson<string[]>(String(row.signal_ids_json), []),
      generatedAt: String(row.generated_at),
      error: row.error ? String(row.error) : null,
      generation: row.generation as MorningBriefing['generation']
    }
  }
}
