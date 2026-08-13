import type { DatabaseSync } from 'node:sqlite'
import type { AutomationJob, AutomationRun } from '../../../shared/contracts'

type SqlRow = Record<string, string | number | null>

export class AutomationRepository {
  constructor(private readonly database: DatabaseSync) {}

  list(): AutomationJob[] {
    return (this.database.prepare('SELECT * FROM automation_jobs ORDER BY created_at ASC').all() as SqlRow[]).map(
      (row) => this.map(row)
    )
  }

  get(id: string): AutomationJob {
    const row = this.database.prepare('SELECT * FROM automation_jobs WHERE id = ?').get(id) as SqlRow | undefined
    if (!row) throw new Error(`Automation not found: ${id}`)
    return this.map(row)
  }

  save(job: AutomationJob): AutomationJob {
    this.database
      .prepare(
        `
      INSERT INTO automation_jobs (
        id, project_id, name, schedule_description, cron_expression, timezone,
        action, prompt, agent_kind, agent_provider, enabled, requires_confirmation,
        max_retries, retry_delay_seconds, status, last_run_at, next_run_at,
        last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id, name = excluded.name,
        schedule_description = excluded.schedule_description, cron_expression = excluded.cron_expression,
        timezone = excluded.timezone, action = excluded.action, prompt = excluded.prompt,
        agent_kind = excluded.agent_kind, agent_provider = excluded.agent_provider,
        enabled = excluded.enabled, requires_confirmation = excluded.requires_confirmation,
        max_retries = excluded.max_retries, retry_delay_seconds = excluded.retry_delay_seconds,
        status = excluded.status, next_run_at = excluded.next_run_at,
        last_error = excluded.last_error, updated_at = excluded.updated_at
    `
      )
      .run(
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
    return this.get(job.id)
  }

  setEnabled(id: string, enabled: boolean, nextRunAt: string | null): AutomationJob {
    this.database
      .prepare(
        `
      UPDATE automation_jobs SET enabled = ?, status = ?, next_run_at = ?, last_error = NULL, updated_at = ? WHERE id = ?
    `
      )
      .run(enabled ? 1 : 0, enabled ? 'idle' : 'paused', nextRunAt, new Date().toISOString(), id)
    return this.get(id)
  }

  updateRuntime(
    id: string,
    input: Pick<AutomationJob, 'status' | 'lastRunAt' | 'nextRunAt' | 'lastError'>
  ): AutomationJob {
    this.database
      .prepare(
        `
      UPDATE automation_jobs SET status = ?, last_run_at = ?, next_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?
    `
      )
      .run(input.status, input.lastRunAt, input.nextRunAt, input.lastError, new Date().toISOString(), id)
    return this.get(id)
  }

  listRuns(automationId?: string): AutomationRun[] {
    const rows = automationId
      ? (this.database
          .prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 100')
          .all(automationId) as SqlRow[])
      : (this.database.prepare('SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT 200').all() as SqlRow[])
    return rows.map((row) => this.mapRun(row))
  }

  getRun(id: string): AutomationRun {
    const row = this.database.prepare('SELECT * FROM automation_runs WHERE id = ?').get(id) as SqlRow | undefined
    if (!row) throw new Error(`Automation run not found: ${id}`)
    return this.mapRun(row)
  }

  saveRun(run: AutomationRun): AutomationRun {
    this.database
      .prepare(
        `
      INSERT INTO automation_runs (
        id, automation_id, status, trigger, attempt, started_at, completed_at, summary, error, agent_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, attempt = excluded.attempt, completed_at = excluded.completed_at,
        summary = excluded.summary, error = excluded.error, agent_run_id = excluded.agent_run_id
    `
      )
      .run(
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
    return this.getRun(run.id)
  }

  recoverInterrupted(recoveredAt: string): void {
    this.database
      .prepare(
        `
      UPDATE automation_runs SET status = 'failed', completed_at = ?, summary = '应用退出时运行尚未完成。',
        error = '运行被应用退出中断。' WHERE status = 'running'
    `
      )
      .run(recoveredAt)
    this.database
      .prepare(
        `
      UPDATE automation_jobs SET status = 'error', last_error = '上一次运行被应用退出中断。', updated_at = ?
      WHERE status = 'running'
    `
      )
      .run(recoveredAt)
  }

  private map(row: SqlRow): AutomationJob {
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

  private mapRun(row: SqlRow): AutomationRun {
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
}
