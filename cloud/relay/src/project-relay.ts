import { DurableObject } from 'cloudflare:workers'
import type {
  SharedProjectBaseline, SharedProjectBaselineChunk, SharedProjectEncryptedEvent
} from '../../../src/shared/project-sharing-events'

interface StoredEvent extends Record<string, SqlStorageValue> {
  sequence: number
  event_id: string
  key_epoch: number
  kind: string
  envelope: string
  actor_user_id: string
  source_device_id: string
  created_at: string
}
export const maximumProjectEvents = 10_000

/** Access is deliberately available only through RelayAdministration's service binding. */
export class ProjectRelay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS project_identity (id INTEGER PRIMARY KEY CHECK (id = 1), project_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        key_epoch INTEGER NOT NULL,
        kind TEXT NOT NULL,
        envelope TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        source_device_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_baselines (
        baseline_id TEXT PRIMARY KEY,
        source_device_id TEXT NOT NULL,
        key_epoch INTEGER NOT NULL,
        watermark INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'committed')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_baseline_chunks (
        baseline_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        envelope TEXT NOT NULL,
        PRIMARY KEY (baseline_id, chunk_index)
      );
    `)
  }

  private bindProject(projectId: string): void {
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO project_identity (id, project_id) VALUES (1, ?)', projectId)
    const row = this.ctx.storage.sql.exec<{ project_id: string }>(
      'SELECT project_id FROM project_identity WHERE id = 1'
    ).one()
    if (row.project_id !== projectId) throw new Error('Project relay identity mismatch.')
  }

  async appendEvent(
    projectId: string,
    input: Omit<SharedProjectEncryptedEvent, 'projectId' | 'sequence' | 'createdAt'>
  ): Promise<SharedProjectEncryptedEvent | 'conflict' | 'snapshot-required'> {
    this.bindProject(projectId)
    const encoded = JSON.stringify(input.envelope)
    const existing = this.ctx.storage.sql.exec<{
      sequence: number; key_epoch: number; kind: string; envelope: string
      actor_user_id: string; source_device_id: string; created_at: string
    }>('SELECT * FROM project_events WHERE event_id = ?', input.eventId).toArray()[0]
    if (existing) {
      if (existing.key_epoch !== input.keyEpoch || existing.kind !== input.kind
        || existing.envelope !== encoded || existing.actor_user_id !== input.actorUserId
        || existing.source_device_id !== input.sourceDeviceId) return 'conflict'
      return { ...input, projectId, sequence: existing.sequence, createdAt: existing.created_at }
    }
    const count = this.ctx.storage.sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM project_events WHERE source_device_id = ?', input.sourceDeviceId
    ).one().count
    if (count >= maximumProjectEvents) return 'snapshot-required'
    const createdAt = new Date().toISOString()
    this.ctx.storage.sql.exec(
      `INSERT INTO project_events
       (event_id, key_epoch, kind, envelope, actor_user_id, source_device_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.eventId, input.keyEpoch, input.kind, encoded,
      input.actorUserId, input.sourceDeviceId, createdAt
    )
    const sequence = this.ctx.storage.sql.exec<{ sequence: number }>(
      'SELECT sequence FROM project_events WHERE event_id = ?', input.eventId
    ).one().sequence
    return { ...input, projectId, sequence, createdAt }
  }

  async listEvents(projectId: string, after: number, limit: number, keyEpoch?: number): Promise<SharedProjectEncryptedEvent[]> {
    this.bindProject(projectId)
    const rows = keyEpoch === undefined
      ? this.ctx.storage.sql.exec<StoredEvent>(
        'SELECT * FROM project_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?', after, limit
      ).toArray()
      : this.ctx.storage.sql.exec<StoredEvent>(
        'SELECT * FROM project_events WHERE sequence > ? AND key_epoch = ? ORDER BY sequence ASC LIMIT ?',
        after, keyEpoch, limit
      ).toArray()
    return rows.map((row) => ({
      eventId: row.event_id, projectId, keyEpoch: row.key_epoch,
      kind: row.kind as SharedProjectEncryptedEvent['kind'],
      envelope: JSON.parse(row.envelope) as SharedProjectEncryptedEvent['envelope'],
      actorUserId: row.actor_user_id, sourceDeviceId: row.source_device_id,
      sequence: row.sequence, createdAt: row.created_at
    }))
  }

  async beginBaseline(
    projectId: string, baselineId: string, sourceDeviceId: string, keyEpoch: number, chunkCount: number
  ): Promise<SharedProjectBaseline | 'conflict'> {
    this.bindProject(projectId)
    const existing = this.ctx.storage.sql.exec<{
      source_device_id: string; key_epoch: number; chunk_count: number; watermark: number; created_at: string
    }>('SELECT * FROM project_baselines WHERE baseline_id = ?', baselineId).toArray()[0]
    if (existing) {
      if (existing.source_device_id !== sourceDeviceId || existing.key_epoch !== keyEpoch
        || existing.chunk_count !== chunkCount) return 'conflict'
      return { baselineId, projectId, sourceDeviceId, keyEpoch,
        chunkCount, watermark: existing.watermark, createdAt: existing.created_at }
    }
    const pending = this.ctx.storage.sql.exec<{ baseline_id: string; key_epoch: number }>(
      "SELECT baseline_id, key_epoch FROM project_baselines WHERE source_device_id = ? AND status = 'pending'",
      sourceDeviceId
    ).toArray()[0]
    if (pending) {
      this.ctx.storage.sql.exec('DELETE FROM project_baseline_chunks WHERE baseline_id = ?', pending.baseline_id)
      this.ctx.storage.sql.exec('DELETE FROM project_baselines WHERE baseline_id = ?', pending.baseline_id)
    }
    const watermark = this.ctx.storage.sql.exec<{ watermark: number }>(
      'SELECT COALESCE(MAX(sequence), 0) AS watermark FROM project_events WHERE source_device_id = ?',
      sourceDeviceId
    ).one().watermark
    const createdAt = new Date().toISOString()
    this.ctx.storage.sql.exec(
      `INSERT INTO project_baselines
       (baseline_id, source_device_id, key_epoch, watermark, chunk_count, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      baselineId, sourceDeviceId, keyEpoch, watermark, chunkCount, createdAt
    )
    return { baselineId, projectId, sourceDeviceId, keyEpoch, watermark, chunkCount, createdAt }
  }

  async putBaselineChunk(
    projectId: string, sourceDeviceId: string, keyEpoch: number, chunk: SharedProjectBaselineChunk
  ): Promise<'ok' | 'conflict' | 'not-found'> {
    this.bindProject(projectId)
    const baseline = this.ctx.storage.sql.exec<{ chunk_count: number; status: string; key_epoch: number }>(
      'SELECT chunk_count, status, key_epoch FROM project_baselines WHERE baseline_id = ? AND source_device_id = ?',
      chunk.baselineId, sourceDeviceId
    ).toArray()[0]
    if (!baseline || baseline.status !== 'pending' || baseline.key_epoch !== keyEpoch
      || chunk.index < 0 || chunk.index >= baseline.chunk_count) {
      return 'not-found'
    }
    const encoded = JSON.stringify(chunk.envelope)
    const existing = this.ctx.storage.sql.exec<{ envelope: string }>(
      'SELECT envelope FROM project_baseline_chunks WHERE baseline_id = ? AND chunk_index = ?',
      chunk.baselineId, chunk.index
    ).toArray()[0]
    if (existing) return existing.envelope === encoded ? 'ok' : 'conflict'
    this.ctx.storage.sql.exec(
      'INSERT INTO project_baseline_chunks (baseline_id, chunk_index, envelope) VALUES (?, ?, ?)',
      chunk.baselineId, chunk.index, encoded
    )
    return 'ok'
  }

  async commitBaseline(
    projectId: string, baselineId: string, sourceDeviceId: string, keyEpoch: number
  ): Promise<'ok' | 'incomplete' | 'not-found'> {
    this.bindProject(projectId)
    const baseline = this.ctx.storage.sql.exec<{
      watermark: number; chunk_count: number; status: string; key_epoch: number
    }>('SELECT * FROM project_baselines WHERE baseline_id = ? AND source_device_id = ?',
      baselineId, sourceDeviceId).toArray()[0]
    if (!baseline || baseline.key_epoch !== keyEpoch) return 'not-found'
    if (baseline.status === 'committed') return 'ok'
    const count = this.ctx.storage.sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM project_baseline_chunks WHERE baseline_id = ?', baselineId
    ).one().count
    if (count !== baseline.chunk_count) return 'incomplete'
    await this.ctx.storage.transaction(async () => {
      this.ctx.storage.sql.exec(
        `DELETE FROM project_baseline_chunks WHERE baseline_id IN
         (SELECT baseline_id FROM project_baselines WHERE source_device_id = ? AND status = 'committed')`,
        sourceDeviceId
      )
      this.ctx.storage.sql.exec(
        "DELETE FROM project_baselines WHERE source_device_id = ? AND status = 'committed'",
        sourceDeviceId
      )
      this.ctx.storage.sql.exec(
        "UPDATE project_baselines SET status = 'committed' WHERE baseline_id = ?", baselineId
      )
      this.ctx.storage.sql.exec(
        'DELETE FROM project_events WHERE source_device_id = ? AND sequence <= ?',
        sourceDeviceId, baseline.watermark
      )
    })
    return 'ok'
  }

  async listBaselines(projectId: string): Promise<SharedProjectBaseline[]> {
    this.bindProject(projectId)
    const rows = this.ctx.storage.sql.exec<{
      baseline_id: string; source_device_id: string; key_epoch: number
      watermark: number; chunk_count: number; created_at: string
    }>("SELECT * FROM project_baselines WHERE status = 'committed' ORDER BY source_device_id").toArray()
    return rows.map((row) => ({
      baselineId: row.baseline_id, projectId, sourceDeviceId: row.source_device_id,
      keyEpoch: row.key_epoch, watermark: row.watermark,
      chunkCount: row.chunk_count, createdAt: row.created_at
    }))
  }

  async listBaselineChunks(
    projectId: string, baselineId: string, afterIndex: number, limit: number
  ): Promise<SharedProjectBaselineChunk[]> {
    this.bindProject(projectId)
    const baseline = this.ctx.storage.sql.exec<{ status: string }>(
      'SELECT status FROM project_baselines WHERE baseline_id = ?', baselineId
    ).toArray()[0]
    if (baseline?.status !== 'committed') return []
    const rows = this.ctx.storage.sql.exec<{ chunk_index: number; envelope: string }>(
      `SELECT chunk_index, envelope FROM project_baseline_chunks
       WHERE baseline_id = ? AND chunk_index > ? ORDER BY chunk_index LIMIT ?`,
      baselineId, afterIndex, limit
    ).toArray()
    return rows.map((row) => ({ baselineId, index: row.chunk_index,
      envelope: JSON.parse(row.envelope) as SharedProjectBaselineChunk['envelope'] }))
  }
}
