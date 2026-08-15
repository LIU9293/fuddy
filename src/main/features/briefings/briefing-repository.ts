import type { DatabaseSync } from 'node:sqlite'
import type {
  BriefingMessage,
  DailyBriefing,
  MorningBriefing,
  WorkAssistantActionProposal,
  WorkAssistantTaskContext
} from '../../../shared/contracts'

type SqlRow = Record<string, string | number | null>
const workAssistantHistoryCte = `
  WITH history(record_id, kind, entity_id, created_at) AS (
    SELECT 'assistant-message-' || id, 'message', id, created_at
    FROM work_assistant_messages
    UNION ALL
    SELECT 'morning-briefing-' || id, 'briefing', id, generated_at
    FROM morning_briefings
    WHERE status = 'completed'
  )
`
type BriefingEvent =
  | {
      type: 'morning-briefing.updated'
      entityType: 'morning-briefing'
      entityId: string
      payload: MorningBriefing
    }
  | {
      type: 'work-assistant-message.created' | 'work-assistant-message.updated'
      entityType: 'work-assistant-message'
      entityId: string
      payload: BriefingMessage
    }

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export class BriefingRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly transaction: <T>(operation: () => T) => T,
    private readonly publish: (event: BriefingEvent) => void
  ) {}

  listDaily(): DailyBriefing[] {
    return (
      this.database
        .prepare('SELECT * FROM daily_briefings ORDER BY report_date DESC, generated_at DESC LIMIT 30')
        .all() as SqlRow[]
    ).map((row) => this.mapDaily(row))
  }

  getDaily(projectId: string, reportDate: string): DailyBriefing | null {
    const row = this.database
      .prepare('SELECT * FROM daily_briefings WHERE project_id = ? AND report_date = ?')
      .get(projectId, reportDate) as SqlRow | undefined
    return row ? this.mapDaily(row) : null
  }

  upsertDaily(briefing: DailyBriefing): DailyBriefing {
    this.database
      .prepare(
        `
      INSERT INTO daily_briefings (
        id, project_id, report_date, timezone, status, headline, body,
        metrics_json, signal_ids_json, generated_at, error, generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, report_date) DO UPDATE SET
        status = excluded.status, headline = excluded.headline, body = excluded.body,
        metrics_json = excluded.metrics_json, signal_ids_json = excluded.signal_ids_json,
        generated_at = excluded.generated_at, error = excluded.error, generation = excluded.generation
    `
      )
      .run(
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
    return this.getDaily(briefing.projectId, briefing.reportDate) as DailyBriefing
  }

  listMorning(): MorningBriefing[] {
    return (
      this.database
        .prepare('SELECT * FROM morning_briefings ORDER BY report_date DESC, generated_at DESC LIMIT 30')
        .all() as SqlRow[]
    ).map((row) => this.mapMorning(row))
  }

  getMorning(reportDate: string): MorningBriefing | null {
    const row = this.database.prepare('SELECT * FROM morning_briefings WHERE report_date = ?').get(reportDate) as
      SqlRow | undefined
    return row ? this.mapMorning(row) : null
  }

  getMorningById(id: string): MorningBriefing | null {
    const row = this.database.prepare('SELECT * FROM morning_briefings WHERE id = ?').get(id) as SqlRow | undefined
    return row ? this.mapMorning(row) : null
  }

  upsertMorning(briefing: MorningBriefing): MorningBriefing {
    return this.transaction(() => {
      this.database
        .prepare(
          `
        INSERT INTO morning_briefings (
          id, report_date, timezone, status, headline, body, narration,
          estimated_duration_seconds, source_briefing_ids_json, signal_ids_json,
          generated_at, error, generation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(report_date) DO UPDATE SET
          status = excluded.status, headline = excluded.headline, body = excluded.body,
          narration = excluded.narration, estimated_duration_seconds = excluded.estimated_duration_seconds,
          source_briefing_ids_json = excluded.source_briefing_ids_json,
          signal_ids_json = excluded.signal_ids_json, generated_at = excluded.generated_at,
          error = excluded.error, generation = excluded.generation
      `
        )
        .run(
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
      const updated = this.getMorning(briefing.reportDate) as MorningBriefing
      this.publish({
        type: 'morning-briefing.updated',
        entityType: 'morning-briefing',
        entityId: updated.id,
        payload: updated
      })
      return updated
    })
  }

  listMessages(briefingId?: string): BriefingMessage[] {
    const rows = briefingId
      ? (this.database
          .prepare('SELECT * FROM work_assistant_messages WHERE source_briefing_id = ? ORDER BY created_at ASC')
          .all(briefingId) as SqlRow[])
      : (this.database
          .prepare(`
            SELECT * FROM (
              SELECT *, rowid AS sort_rowid
              FROM work_assistant_messages
              ORDER BY created_at DESC, rowid DESC
              LIMIT 200
            ) ORDER BY created_at ASC, sort_rowid ASC
          `)
          .all() as SqlRow[])
    return rows.map((row) => this.mapMessage(row))
  }

  listChatWindow(beforeRecordId: string | null, limit: number): {
    messages: BriefingMessage[]
    briefings: MorningBriefing[]
    hasMore: boolean
  } {
    const cursor = beforeRecordId?.startsWith('assistant-message-')
      ? this.database.prepare(`
          SELECT created_at FROM work_assistant_messages WHERE id = ?
        `).get(beforeRecordId.slice('assistant-message-'.length)) as SqlRow | undefined
      : beforeRecordId?.startsWith('morning-briefing-')
        ? this.database.prepare(`
            SELECT generated_at AS created_at FROM morning_briefings WHERE id = ? AND status = 'completed'
          `).get(beforeRecordId.slice('morning-briefing-'.length)) as SqlRow | undefined
        : undefined
    if (beforeRecordId && !cursor) throw new Error('聊天历史游标已失效，请刷新后重试。')
    const cursorCreatedAt = cursor ? String(cursor.created_at) : null
    const rows = this.database.prepare(`${workAssistantHistoryCte}
        SELECT record_id, kind, entity_id, created_at
        FROM history
        WHERE ? IS NULL
          OR created_at < ?
          OR (created_at = ? AND record_id < ?)
        ORDER BY created_at DESC, record_id DESC
        LIMIT ?
      `).all(
        cursorCreatedAt,
        cursorCreatedAt,
        cursorCreatedAt,
        beforeRecordId,
        limit + 1
      ) as SqlRow[]
    const selected = rows.slice(0, limit).reverse()
    const messages: BriefingMessage[] = []
    const briefings: MorningBriefing[] = []
    for (const row of selected) {
      if (row.kind === 'message') {
        const message = this.getMessage(String(row.entity_id))
        if (message) messages.push(message)
      } else {
        const briefing = this.getMorningById(String(row.entity_id))
        if (briefing?.status === 'completed') briefings.push(briefing)
      }
    }
    return { messages, briefings, hasMore: rows.length > limit }
  }

  getMessage(id: string): BriefingMessage | null {
    const row = this.database.prepare('SELECT * FROM work_assistant_messages WHERE id = ?').get(id) as
      SqlRow | undefined
    return row ? this.mapMessage(row) : null
  }

  private mapMessage(row: SqlRow): BriefingMessage {
    return {
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
    }
  }

  createMessage(message: BriefingMessage): BriefingMessage {
    return this.transaction(() => {
      this.database
        .prepare(
          `
        INSERT INTO work_assistant_messages (
          id, source_briefing_id, role, content, attachments_json, task_context_json, linked_run_id, actions_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
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
      this.publish({
        type: 'work-assistant-message.created',
        entityType: 'work-assistant-message',
        entityId: message.id,
        payload: message
      })
      return message
    })
  }

  updateMessageActions(
    messageId: string,
    actions: WorkAssistantActionProposal[],
    linkedRunId?: string | null
  ): BriefingMessage {
    return this.transaction(() => {
      const result = this.database
        .prepare(
          `
        UPDATE work_assistant_messages SET actions_json = ?, linked_run_id = COALESCE(?, linked_run_id) WHERE id = ?
      `
        )
        .run(JSON.stringify(actions), linkedRunId ?? null, messageId)
      if (Number(result.changes) === 0) throw new Error('没有找到这条工作助理消息。')
      const message = this.getMessage(messageId)
      if (!message) throw new Error('没有找到这条工作助理消息。')
      this.publish({
        type: 'work-assistant-message.updated',
        entityType: 'work-assistant-message',
        entityId: message.id,
        payload: message
      })
      return message
    })
  }

  private mapDaily(row: SqlRow): DailyBriefing {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      reportDate: String(row.report_date),
      timezone: String(row.timezone),
      status: row.status as DailyBriefing['status'],
      headline: String(row.headline),
      body: String(row.body),
      metrics: parseJson<Record<string, unknown> | null>(row.metrics_json ? String(row.metrics_json) : null, null),
      signalIds: parseJson<string[]>(String(row.signal_ids_json), []),
      generatedAt: String(row.generated_at),
      error: row.error ? String(row.error) : null,
      generation: row.generation as DailyBriefing['generation']
    }
  }

  private mapMorning(row: SqlRow): MorningBriefing {
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
