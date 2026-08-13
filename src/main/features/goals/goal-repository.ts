import type { DatabaseSync } from 'node:sqlite'
import type {
  EvidenceRef,
  GoalCheckIn,
  GoalMilestone,
  GoalMilestoneStatus,
  GoalPriority,
  GoalStatus,
  ProjectGoal
} from '../../../shared/contracts'

type SqlRow = Record<string, string | number | null>

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export class GoalRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly transaction: <T>(operation: () => T) => T,
    private readonly publish: (type: 'goal.created' | 'goal.updated', goal: ProjectGoal) => void,
    private readonly publishLinkedRun: (runId: string) => void
  ) {}

  list(projectId?: string): ProjectGoal[] {
    const rows = projectId
      ? (this.database
          .prepare(
            "SELECT * FROM project_goals WHERE project_id = ? ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END, updated_at DESC"
          )
          .all(projectId) as SqlRow[])
      : (this.database
          .prepare(
            "SELECT * FROM project_goals ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END, updated_at DESC"
          )
          .all() as SqlRow[])
    const milestones = this.database
      .prepare('SELECT * FROM goal_milestones ORDER BY goal_id, sort_order ASC, created_at ASC')
      .all() as SqlRow[]
    const checkIns = this.database.prepare('SELECT * FROM goal_checkins ORDER BY created_at DESC').all() as SqlRow[]
    return rows.map((row) =>
      this.map(
        row,
        milestones.filter((item) => String(item.goal_id) === String(row.id)),
        checkIns.filter((item) => String(item.goal_id) === String(row.id)).slice(0, 8)
      )
    )
  }

  get(id: string): ProjectGoal {
    const goal = this.list().find((item) => item.id === id)
    if (!goal) throw new Error(`Goal not found: ${id}`)
    return goal
  }

  create(goal: ProjectGoal): ProjectGoal {
    return this.transaction(() => {
      this.database
        .prepare(
          `
        INSERT INTO project_goals (
          id, project_id, title, description, status, priority, metric_json, deadline,
          next_check_in_at, progress, confidence, agent_summary,
          monitoring_sources_json, created_by, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
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
      for (const milestone of goal.milestones) {
        insertMilestone.run(
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
        )
      }
      for (const checkIn of goal.checkIns) this.createCheckIn(checkIn)
      const created = this.get(goal.id)
      this.publish('goal.created', created)
      return created
    })
  }

  updateTracking(input: {
    id: string
    status: GoalStatus
    progress: number
    metric: ProjectGoal['metric']
    confidence: number
    agentSummary: string
    nextCheckInAt: string | null
  }): ProjectGoal {
    return this.transaction(() => {
      const now = new Date().toISOString()
      this.database
        .prepare(
          `
        UPDATE project_goals
        SET status = ?, progress = ?, metric_json = ?, confidence = ?, agent_summary = ?,
            next_check_in_at = ?, updated_at = ?,
            completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, ?) ELSE NULL END
        WHERE id = ?
      `
        )
        .run(
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
      const updated = this.get(input.id)
      this.publish('goal.updated', updated)
      return updated
    })
  }

  updateStatus(id: string, status: GoalStatus): ProjectGoal {
    const goal = this.get(id)
    return this.updateTracking({
      id,
      status,
      progress: status === 'completed' ? 1 : goal.progress,
      metric: goal.metric,
      confidence: goal.confidence,
      agentSummary:
        status === 'planned'
          ? '目标已加入 Roadmap，激活后 Agent 才会开始例行检查。'
          : status === 'paused'
            ? '目标已暂停，恢复后 Agent 才会继续例行检查。'
            : status === 'completed'
              ? '目标已由用户标记为完成。'
              : goal.agentSummary,
      nextCheckInAt:
        status === 'planned' || status === 'paused' || status === 'completed'
          ? null
          : (goal.nextCheckInAt ?? new Date(Date.now() + 7 * 86_400_000).toISOString())
    })
  }

  updatePriority(id: string, priority: GoalPriority): ProjectGoal {
    return this.transaction(() => {
      const result = this.database
        .prepare('UPDATE project_goals SET priority = ?, updated_at = ? WHERE id = ?')
        .run(priority, new Date().toISOString(), id)
      if (result.changes === 0) throw new Error(`Goal not found: ${id}`)
      const updated = this.get(id)
      this.publish('goal.updated', updated)
      return updated
    })
  }

  updateMilestones(goalId: string, updates: Array<{ title: string; status: GoalMilestoneStatus }>): void {
    this.transaction(() => {
      const now = new Date().toISOString()
      const update = this.database.prepare(`
        UPDATE goal_milestones SET status = ?, updated_at = ?,
          completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, ?) ELSE NULL END
        WHERE goal_id = ? AND title = ?
      `)
      for (const item of updates) update.run(item.status, now, item.status, now, goalId, item.title)
      this.publish('goal.updated', this.get(goalId))
    })
  }

  completeMilestone(goalId: string, milestoneId: string): ProjectGoal {
    return this.transaction(() => {
      const now = new Date().toISOString()
      const result = this.database
        .prepare(
          `
        UPDATE goal_milestones SET status = 'completed', updated_at = ?, completed_at = COALESCE(completed_at, ?)
        WHERE id = ? AND goal_id = ?
      `
        )
        .run(now, now, milestoneId, goalId)
      if (result.changes === 0) throw new Error(`Milestone not found: ${milestoneId}`)
      this.refreshProgress(goalId, now)
      const goal = this.get(goalId)
      this.publish('goal.updated', goal)
      return goal
    })
  }

  deleteMilestone(goalId: string, milestoneId: string): ProjectGoal {
    return this.transaction(() => {
      if (
        !this.database.prepare('SELECT id FROM goal_milestones WHERE id = ? AND goal_id = ?').get(milestoneId, goalId)
      ) {
        throw new Error(`Milestone not found: ${milestoneId}`)
      }
      const linkedRunIds = (
        this.database.prepare('SELECT id FROM agent_runs WHERE milestone_id = ?').all(milestoneId) as SqlRow[]
      ).map((row) => String(row.id))
      const now = new Date().toISOString()
      this.database
        .prepare('UPDATE agent_runs SET milestone_id = NULL, updated_at = ? WHERE milestone_id = ?')
        .run(now, milestoneId)
      this.database.prepare('DELETE FROM goal_milestones WHERE id = ? AND goal_id = ?').run(milestoneId, goalId)
      this.refreshProgress(goalId, now)
      for (const runId of linkedRunIds) this.publishLinkedRun(runId)
      const goal = this.get(goalId)
      this.publish('goal.updated', goal)
      return goal
    })
  }

  createCheckIn(checkIn: GoalCheckIn): GoalCheckIn {
    this.database
      .prepare(
        `
      INSERT INTO goal_checkins (id, goal_id, status, progress, summary, evidence_refs_json, generation, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
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

  private refreshProgress(goalId: string, updatedAt: string): void {
    const goal = this.get(goalId)
    const metric = goal.metric
    const progress =
      metric.current !== null && metric.target !== null && metric.baseline !== metric.target
        ? Math.max(0, Math.min(1, (metric.current - (metric.baseline ?? 0)) / (metric.target - (metric.baseline ?? 0))))
        : goal.milestones.length === 0
          ? 0
          : goal.milestones.filter((milestone) => milestone.status === 'completed').length / goal.milestones.length
    this.database
      .prepare('UPDATE project_goals SET progress = ?, updated_at = ? WHERE id = ?')
      .run(progress, updatedAt, goalId)
  }

  private map(row: SqlRow, milestoneRows: SqlRow[], checkInRows: SqlRow[]): ProjectGoal {
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
}
