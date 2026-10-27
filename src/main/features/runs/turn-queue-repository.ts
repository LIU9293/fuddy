import type { DatabaseSync } from 'node:sqlite'
import type { AgentTurnQueueItem, AgentTurnQueueStatus } from '../../../shared/agent-turn-queue'

interface TurnRow extends Record<string, string | number | null> {
  request_id: string
  run_id: string
  prompt: string
  attachments_json: string
  requested_by_user_id: string | null
  author_snapshot_json: string | null
  status: string
  enqueued_at: string
  started_at: string | null
  settled_at: string | null
}

function mapTurn(row: TurnRow): AgentTurnQueueItem {
  return {
    requestId: row.request_id,
    runId: row.run_id,
    prompt: row.prompt,
    attachments: JSON.parse(row.attachments_json) as AgentTurnQueueItem['attachments'],
    requestedByUserId: row.requested_by_user_id,
    authorSnapshot: row.author_snapshot_json
      ? JSON.parse(row.author_snapshot_json) as AgentTurnQueueItem['authorSnapshot'] : null,
    status: row.status as AgentTurnQueueStatus,
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at,
    settledAt: row.settled_at
  }
}

export class TurnQueueRepository {
  constructor(private readonly database: DatabaseSync) {}

  enqueue(input: Pick<AgentTurnQueueItem,
    'requestId' | 'runId' | 'prompt' | 'attachments' | 'requestedByUserId' | 'authorSnapshot'>
  ): AgentTurnQueueItem {
    const now = new Date().toISOString()
    this.database.prepare(`
      INSERT OR IGNORE INTO agent_turn_queue
        (request_id, run_id, prompt, attachments_json, requested_by_user_id, author_snapshot_json, status, enqueued_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
    `).run(input.requestId, input.runId, input.prompt, JSON.stringify(input.attachments),
      input.requestedByUserId, input.authorSnapshot ? JSON.stringify(input.authorSnapshot) : null, now)
    const existing = this.get(input.requestId)!
    if (existing.runId !== input.runId || existing.prompt !== input.prompt
      || JSON.stringify(existing.attachments) !== JSON.stringify(input.attachments)
      || existing.requestedByUserId !== input.requestedByUserId) {
      throw new Error('请求 ID 已用于另一条消息。')
    }
    return existing
  }

  get(requestId: string): AgentTurnQueueItem | null {
    const row = this.database.prepare('SELECT * FROM agent_turn_queue WHERE request_id = ?')
      .get(requestId) as TurnRow | undefined
    return row ? mapTurn(row) : null
  }

  listQueued(): AgentTurnQueueItem[] {
    return (this.database.prepare(
      "SELECT * FROM agent_turn_queue WHERE status = 'queued' ORDER BY enqueued_at, rowid"
    ).all() as TurnRow[]).map(mapTurn)
  }

  listForRun(runId: string): AgentTurnQueueItem[] {
    return (this.database.prepare(
      `SELECT * FROM agent_turn_queue WHERE run_id = ? AND status IN ('queued', 'running')
       ORDER BY enqueued_at, rowid`
    ).all(runId) as TurnRow[]).map(mapTurn)
  }

  claim(requestId: string): boolean {
    const result = this.database.prepare(`
      UPDATE agent_turn_queue SET status = 'running', started_at = ?
      WHERE request_id = ? AND status = 'queued'
    `).run(new Date().toISOString(), requestId)
    return Number(result.changes) === 1
  }

  retryFailed(requestId: string): boolean {
    const result = this.database.prepare(`
      UPDATE agent_turn_queue SET status = 'queued', started_at = NULL, settled_at = NULL
      WHERE request_id = ? AND status = 'failed'
    `).run(requestId)
    return Number(result.changes) === 1
  }

  claimForSteer(requestId: string): boolean {
    const result = this.database.prepare(`
      UPDATE agent_turn_queue SET status = 'running', started_at = ?
      WHERE request_id = ? AND status = 'queued'
    `).run(new Date().toISOString(), requestId)
    return Number(result.changes) === 1
  }

  finishSteer(requestId: string): void {
    this.database.prepare(`
      UPDATE agent_turn_queue SET status = 'completed', settled_at = ?
      WHERE request_id = ? AND status = 'running'
    `).run(new Date().toISOString(), requestId)
  }

  releaseSteer(requestId: string): void {
    this.database.prepare(`
      UPDATE agent_turn_queue SET status = 'queued', started_at = NULL
      WHERE request_id = ? AND status = 'running'
    `).run(requestId)
  }

  settle(requestId: string, status: Extract<AgentTurnQueueStatus, 'completed' | 'failed' | 'cancelled'>): void {
    this.database.prepare(`
      UPDATE agent_turn_queue SET status = ?, settled_at = ?
      WHERE request_id = ? AND status = 'running'
    `).run(status, new Date().toISOString(), requestId)
  }

  cancelQueued(requestId: string): boolean {
    const result = this.database.prepare(`
      UPDATE agent_turn_queue SET status = 'cancelled', settled_at = ?
      WHERE request_id = ? AND status = 'queued'
    `).run(new Date().toISOString(), requestId)
    return Number(result.changes) === 1
  }

  recoverInterrupted(): number {
    const result = this.database.prepare(`
      UPDATE agent_turn_queue SET status = 'interrupted', settled_at = ? WHERE status = 'running'
    `).run(new Date().toISOString())
    return Number(result.changes)
  }
}
