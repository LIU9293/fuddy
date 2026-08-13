import type { DatabaseSync } from 'node:sqlite'
import type { ConnectorInstance, ConnectorRun, ConnectorRunStatus, EvidenceRef } from '../../../shared/contracts'

type SqlRow = Record<string, string | number | null>

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export class ConnectorRepository {
  constructor(private readonly database: DatabaseSync) {}

  list(): ConnectorInstance[] {
    return (
      this.database.prepare('SELECT * FROM connector_instances ORDER BY sort_order ASC, name ASC').all() as SqlRow[]
    ).map((row) => this.map(row))
  }

  get(id: string): ConnectorInstance {
    const row = this.database.prepare('SELECT * FROM connector_instances WHERE id = ?').get(id) as SqlRow | undefined
    if (!row) throw new Error(`Connector not found: ${id}`)
    return this.map(row)
  }

  listRuns(): ConnectorRun[] {
    return (
      this.database.prepare('SELECT * FROM connector_runs ORDER BY started_at DESC LIMIT 50').all() as SqlRow[]
    ).map((row) => ({
      id: String(row.id),
      connectorId: String(row.connector_id),
      projectId: String(row.project_id),
      status: row.status as ConnectorRunStatus,
      startedAt: String(row.started_at),
      completedAt: String(row.completed_at),
      summary: String(row.summary),
      evidenceRefs: parseJson<EvidenceRef[]>(String(row.evidence_refs_json), []),
      decisionId: row.decision_id ? String(row.decision_id) : null,
      data: parseJson<Record<string, unknown> | null>(row.data_json ? String(row.data_json) : null, null)
    }))
  }

  setEnabled(id: string, enabled: boolean): ConnectorInstance {
    this.database
      .prepare('UPDATE connector_instances SET enabled = ?, status = ? WHERE id = ?')
      .run(enabled ? 1 : 0, enabled ? 'needs-setup' : 'disabled', id)
    return this.get(id)
  }

  upsert(input: {
    id: string
    projectId: string
    kind: ConnectorInstance['kind']
    name: string
    config: Record<string, string | number | boolean>
    credentialRef: string | null
    capabilities: string[]
    sortOrder: number
  }): ConnectorInstance {
    this.database
      .prepare(
        `
      INSERT INTO connector_instances (
        id, project_id, kind, name, enabled, status, config_json,
        credential_ref, capabilities_json, sort_order
      ) VALUES (?, ?, ?, ?, 1, 'needs-setup', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id, kind = excluded.kind, name = excluded.name,
        enabled = 1, status = 'needs-setup', config_json = excluded.config_json,
        credential_ref = excluded.credential_ref, capabilities_json = excluded.capabilities_json,
        last_error = NULL, sort_order = excluded.sort_order
    `
      )
      .run(
        input.id,
        input.projectId,
        input.kind,
        input.name,
        JSON.stringify(input.config),
        input.credentialRef,
        JSON.stringify(input.capabilities),
        input.sortOrder
      )
    return this.get(input.id)
  }

  markRunning(id: string, checkedAt: string): ConnectorInstance {
    this.database
      .prepare("UPDATE connector_instances SET status = 'running', last_checked_at = ?, last_error = NULL WHERE id = ?")
      .run(checkedAt, id)
    return this.get(id)
  }

  complete(id: string, status: 'connected' | 'error', completedAt: string, error: string | null): ConnectorInstance {
    this.database
      .prepare('UPDATE connector_instances SET status = ?, last_sync_at = ?, last_error = ? WHERE id = ?')
      .run(status, completedAt, error, id)
    return this.get(id)
  }

  createRun(run: ConnectorRun): void {
    this.database
      .prepare(
        `
      INSERT INTO connector_runs (
        id, connector_id, project_id, status, started_at, completed_at,
        summary, evidence_refs_json, decision_id, data_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
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

  private map(row: SqlRow): ConnectorInstance {
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
}
