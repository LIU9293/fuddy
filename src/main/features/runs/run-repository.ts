import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentRun, AgentRunArtifact, AgentRunDetail, AgentRunMessage } from '../../../shared/contracts'

type SqlRow = Record<string, string | number | null>
type RunEvent =
  | {
      type: 'agent-run.created' | 'agent-run.updated'
      entityType: 'agent-run'
      entityId: string
      payload: AgentRun
    }
  | {
      type: 'agent-run.archived'
      entityType: 'agent-run'
      entityId: string
      payload: { id: string; archivedAt: string }
    }
  | {
      type: 'agent-message.created'
      entityType: 'agent-message'
      entityId: string
      payload: AgentRunMessage
    }
  | {
      type: 'artifact.updated'
      entityType: 'artifact'
      entityId: string
      payload: AgentRunArtifact
    }

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export class RunRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly transaction: <T>(operation: () => T) => T,
    private readonly publish: (event: RunEvent) => void
  ) {}

  list(): AgentRun[] {
    const rows = this.database
      .prepare(
        'SELECT * FROM agent_runs WHERE archived_at IS NULL ORDER BY COALESCE(updated_at, started_at, created_at) DESC'
      )
      .all() as SqlRow[]
    return rows.map((row) => this.map(row))
  }

  get(id: string): AgentRun {
    const row = this.database.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as SqlRow | undefined
    if (!row) throw new Error(`Agent run not found: ${id}`)
    return this.map(row)
  }

  getDetail(id: string): AgentRunDetail {
    return {
      run: this.get(id),
      messages: this.listMessages(id),
      artifacts: this.listArtifacts(id)
    }
  }

  rename(id: string, title: string): AgentRun {
    return this.transaction(() => {
      const normalizedTitle = title.trim()
      if (!normalizedTitle) throw new Error('Session 标题不能为空。')
      const result = this.database
        .prepare('UPDATE agent_runs SET title = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL')
        .run(normalizedTitle, new Date().toISOString(), id)
      if (Number(result.changes) === 0) throw new Error(`Agent run not found: ${id}`)
      const run = this.get(id)
      this.publish({
        type: 'agent-run.updated',
        entityType: 'agent-run',
        entityId: id,
        payload: run
      })
      return run
    })
  }

  updateDraftPrompt(id: string, draftPrompt: string): AgentRun {
    return this.transaction(() => {
      const run = this.get(id)
      if (run.status !== 'draft' || this.listMessages(id).length > 0) {
        throw new Error('只有尚未发送首条消息的草稿 Run 可以修改预填内容。')
      }
      this.database
        .prepare('UPDATE agent_runs SET draft_prompt = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL')
        .run(draftPrompt.trim() || null, new Date().toISOString(), id)
      const updated = this.get(id)
      this.publish({
        type: 'agent-run.updated',
        entityType: 'agent-run',
        entityId: id,
        payload: updated
      })
      return updated
    })
  }

  archive(id: string): void {
    this.transaction(() => {
      const run = this.get(id)
      if (run.status === 'running' || run.status === 'queued') {
        throw new Error('正在运行的 Session 不能归档，请等待本轮结束。')
      }
      const archivedAt = new Date().toISOString()
      this.database
        .prepare('UPDATE agent_runs SET archived_at = ?, updated_at = ? WHERE id = ?')
        .run(archivedAt, archivedAt, id)
      this.publish({
        type: 'agent-run.archived',
        entityType: 'agent-run',
        entityId: id,
        payload: { id, archivedAt }
      })
    })
  }

  listMessages(runId: string): AgentRunMessage[] {
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

  listArtifacts(runId: string): AgentRunArtifact[] {
    return (
      this.database
        .prepare('SELECT * FROM agent_run_artifacts WHERE run_id = ? ORDER BY created_at DESC')
        .all(runId) as SqlRow[]
    ).map((row) => this.mapArtifact(row))
  }

  getArtifact(id: string): AgentRunArtifact | null {
    const row = this.database.prepare('SELECT * FROM agent_run_artifacts WHERE id = ?').get(id) as SqlRow | undefined
    return row ? this.mapArtifact(row) : null
  }

  create(run: AgentRun): AgentRun {
    return this.transaction(() => {
      this.database
        .prepare(
          `
        INSERT INTO agent_runs (
          id, project_id, decision_id, goal_id, milestone_id, agent, kind, provider, title, status,
          session_id, working_directory, started_at, completed_at, summary, draft_prompt, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
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
      const created = this.get(run.id)
      this.publish({
        type: 'agent-run.created',
        entityType: 'agent-run',
        entityId: created.id,
        payload: created
      })
      return created
    })
  }

  update(run: AgentRun): AgentRun {
    return this.transaction(() => {
      this.database
        .prepare(
          `
        UPDATE agent_runs
        SET project_id = ?, decision_id = ?, goal_id = ?, milestone_id = ?, agent = ?, kind = ?, provider = ?,
            title = ?, status = ?, session_id = ?, working_directory = ?, started_at = ?,
            completed_at = ?, summary = ?, draft_prompt = ?, updated_at = ?
        WHERE id = ?
      `
        )
        .run(
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
      const updated = this.get(run.id)
      this.publish({
        type: 'agent-run.updated',
        entityType: 'agent-run',
        entityId: updated.id,
        payload: updated
      })
      return updated
    })
  }

  recoverInterrupted(recoveredAt: string): number {
    const rows = this.database
      .prepare("SELECT id FROM agent_runs WHERE status IN ('queued', 'running')")
      .all() as SqlRow[]
    if (rows.length === 0) return 0
    return this.transaction(() => {
      this.database
        .prepare(
          `
        UPDATE agent_runs SET status = 'failed', completed_at = ?,
          summary = '上一次运行被应用退出或重启中断，可以发送新消息继续这个 Session。', updated_at = ?
        WHERE status IN ('queued', 'running')
      `
        )
        .run(recoveredAt, recoveredAt)
      const insertMessage = this.database.prepare(`
        INSERT INTO agent_run_messages (id, run_id, role, content, event_type, tool_name, metadata_json, created_at)
        VALUES (?, ?, 'system', ?, 'error', NULL, NULL, ?)
      `)
      for (const row of rows) {
        const runId = String(row.id)
        const message: AgentRunMessage = {
          id: randomUUID(),
          runId,
          role: 'system',
          content: '上一次运行被应用退出或重启中断。这个 Session 已停止，你可以发送新消息继续。',
          eventType: 'error',
          toolName: null,
          metadata: null,
          createdAt: recoveredAt
        }
        insertMessage.run(message.id, runId, message.content, recoveredAt)
        this.publish({
          type: 'agent-message.created',
          entityType: 'agent-message',
          entityId: message.id,
          payload: message
        })
        this.publish({
          type: 'agent-run.updated',
          entityType: 'agent-run',
          entityId: runId,
          payload: this.get(runId)
        })
      }
      return rows.length
    })
  }

  createMessage(message: AgentRunMessage): AgentRunMessage {
    return this.transaction(() => {
      this.database
        .prepare(
          `
        INSERT INTO agent_run_messages (id, run_id, role, content, event_type, tool_name, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          message.id,
          message.runId,
          message.role,
          message.content,
          message.eventType,
          message.toolName,
          message.metadata ? JSON.stringify(message.metadata) : null,
          message.createdAt
        )
      this.publish({
        type: 'agent-message.created',
        entityType: 'agent-message',
        entityId: message.id,
        payload: message
      })
      return message
    })
  }

  upsertArtifact(artifact: AgentRunArtifact): AgentRunArtifact {
    return this.transaction(() => {
      this.database
        .prepare(
          `
        INSERT INTO agent_run_artifacts (id, run_id, project_id, relative_path, label, mime_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, relative_path) DO UPDATE SET
          label = excluded.label, mime_type = excluded.mime_type, created_at = excluded.created_at
      `
        )
        .run(
          artifact.id,
          artifact.runId,
          artifact.projectId,
          artifact.relativePath,
          artifact.label,
          artifact.mimeType,
          artifact.createdAt
        )
      const row = this.database
        .prepare('SELECT id FROM agent_run_artifacts WHERE run_id = ? AND relative_path = ?')
        .get(artifact.runId, artifact.relativePath) as { id: string }
      const persisted = this.getArtifact(row.id) as AgentRunArtifact
      this.publish({
        type: 'artifact.updated',
        entityType: 'artifact',
        entityId: persisted.id,
        payload: persisted
      })
      return persisted
    })
  }

  private map(row: SqlRow): AgentRun {
    const legacyAgent = row.agent ? String(row.agent) : 'assistant'
    const provider = row.provider ? String(row.provider) : legacyAgent === 'assistant' ? 'pi' : legacyAgent
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

  private mapArtifact(row: SqlRow): AgentRunArtifact {
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
}
