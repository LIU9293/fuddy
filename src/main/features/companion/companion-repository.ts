import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { companionEventDefinitions, companionProtocolVersion } from '../../../shared/companion-sync'
import type {
  CompanionCommand,
  CompanionCommandRecord,
  CompanionCommandStatus,
  CompanionEntityType,
  CompanionOutboxPayloadMap,
  CompanionEventType,
  CompanionOutboxEvent
} from '../../../shared/companion-sync'

type SqlRow = Record<string, string | number | null>
const pruneIntervalMs = 24 * 60 * 60 * 1_000
const companionCommandResultEventTypes = new Set<CompanionCommand['type']>([
  'chat.load-history',
  'artifact.request-upload'
])
const companionCommandErrorMaximumCharacters = 2_000

export function companionCommandResultRequiredOnIos(type: CompanionCommand['type']): boolean {
  return companionCommandResultEventTypes.has(type)
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function companionCommandForOutbox(command: CompanionCommand): CompanionCommandRecord {
  return {
    commandId: command.commandId,
    protocolVersion: command.protocolVersion,
    type: command.type,
    // iOS correlates command updates by commandId and does not read the original
    // command input from this event. Avoid echoing prompts or project payloads.
    payload: {},
    sourceDeviceId: command.sourceDeviceId,
    status: command.status,
    result: companionCommandResultRequiredOnIos(command.type) ? command.result : null,
    error: command.error?.slice(0, companionCommandErrorMaximumCharacters) ?? null,
    createdAt: command.createdAt,
    updatedAt: command.updatedAt
  }
}

export function compactPersistedCompanionCommandEvent(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload
  const record = payload as Partial<CompanionCommandRecord>
  if (typeof record.type !== 'string') return payload
  return {
    commandId: record.commandId,
    protocolVersion: record.protocolVersion,
    type: record.type,
    payload: {},
    sourceDeviceId: record.sourceDeviceId,
    status: record.status,
    result: companionCommandResultRequiredOnIos(record.type as CompanionCommand['type'])
      ? record.result ?? null
      : null,
    error: typeof record.error === 'string'
      ? record.error.slice(0, companionCommandErrorMaximumCharacters)
      : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
}

export class CompanionRepository {
  private readonly listeners = new Set<() => void>()
  private nextPruneAt = 0

  constructor(private readonly database: DatabaseSync) {
    this.pruneAllPublished()
    this.nextPruneAt = Date.now() + pruneIntervalMs
  }

  close(): void {
    this.listeners.clear()
  }

  onEnqueued(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  enqueue<TType extends CompanionEventType>(
    type: TType,
    entityType: (typeof companionEventDefinitions)[TType],
    entityId: string,
    payload: CompanionOutboxPayloadMap[TType]
  ): CompanionOutboxEvent<TType> {
    const event = {
      eventId: randomUUID(),
      protocolVersion: companionProtocolVersion,
      type,
      entityType,
      entityId,
      revision: Date.now(),
      payload,
      occurredAt: new Date().toISOString(),
      attempts: 0,
      lastError: null
    } as unknown as CompanionOutboxEvent<TType>
    this.database
      .prepare(
        `
      INSERT INTO companion_sync_outbox (
        event_id, protocol_version, type, entity_type, entity_id, revision,
        payload_json, occurred_at, published_at, attempts, last_error,
        dead_lettered_at, dead_letter_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, NULL)
    `
      )
      .run(
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
      for (const listener of this.listeners) listener()
    })
    return event
  }

  listPending(limit = 100): CompanionOutboxEvent[] {
    return (
      this.database
        .prepare(
          `
      SELECT * FROM companion_sync_outbox
      WHERE published_at IS NULL AND dead_lettered_at IS NULL
      ORDER BY rowid ASC LIMIT ?
    `
        )
        .all(limit) as SqlRow[]
    ).map(
      (row) =>
        ({
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
        }) as unknown as CompanionOutboxEvent
    )
  }

  countPending(): number {
    return Number(
      (
        this.database
          .prepare(`
            SELECT COUNT(*) AS count FROM companion_sync_outbox
            WHERE published_at IS NULL AND dead_lettered_at IS NULL
          `)
          .get() as SqlRow
      ).count
    )
  }

  countDeadLetters(): number {
    return Number(
      (
        this.database
          .prepare('SELECT COUNT(*) AS count FROM companion_sync_outbox WHERE dead_lettered_at IS NOT NULL')
          .get() as SqlRow
      ).count
    )
  }

  markPublished(eventId: string, publishedAt: string): void {
    this.database
      .prepare('UPDATE companion_sync_outbox SET published_at = ?, last_error = NULL WHERE event_id = ?')
      .run(publishedAt, eventId)
    if (Date.now() >= this.nextPruneAt) {
      this.pruneAllPublished()
      this.nextPruneAt = Date.now() + pruneIntervalMs
    }
  }

  prunePublished(retentionDays = 30, batchSize = 1_000): number {
    if (!Number.isFinite(retentionDays) || retentionDays < 1) throw new Error('Retention days must be at least 1.')
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new Error('Companion event cleanup batch size must be between 1 and 10000.')
    }
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
    return Number(
      this.database
        .prepare(
          `
      DELETE FROM companion_sync_outbox WHERE event_id IN (
        SELECT event_id FROM companion_sync_outbox
        WHERE published_at IS NOT NULL AND published_at < ? ORDER BY published_at ASC LIMIT ?
      )
    `
        )
        .run(cutoff, batchSize).changes
    )
  }

  markFailed(eventId: string, error: string): void {
    this.database
      .prepare(
        `
      UPDATE companion_sync_outbox SET attempts = attempts + 1, last_error = ? WHERE event_id = ?
    `
      )
      .run(error.slice(0, 2_000), eventId)
  }

  markDeadLettered(eventId: string, reason: string): void {
    const normalizedReason = reason.slice(0, 2_000)
    this.database
      .prepare(
        `
      UPDATE companion_sync_outbox
      SET dead_lettered_at = ?, dead_letter_reason = ?, attempts = attempts + 1, last_error = ?
      WHERE event_id = ? AND published_at IS NULL AND dead_lettered_at IS NULL
    `
      )
      .run(new Date().toISOString(), normalizedReason, normalizedReason, eventId)
  }

  getCommand(commandId: string): CompanionCommand | null {
    const row = this.database.prepare('SELECT * FROM companion_remote_commands WHERE command_id = ?').get(commandId) as
      SqlRow | undefined
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

  upsertCommand(command: CompanionCommand): CompanionCommand {
    this.database
      .prepare(
        `
      INSERT INTO companion_remote_commands (
        command_id, protocol_version, type, payload_json, source_device_id,
        status, result_json, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(command_id) DO UPDATE SET
        status = excluded.status, result_json = excluded.result_json,
        error = excluded.error, updated_at = excluded.updated_at
    `
      )
      .run(
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
    return this.getCommand(command.commandId) as CompanionCommand
  }

  updateCommand(
    commandId: string,
    status: CompanionCommandStatus,
    result: unknown = null,
    error: string | null = null
  ): CompanionCommand {
    this.database
      .prepare(
        `
      UPDATE companion_remote_commands SET status = ?, result_json = ?, error = ?, updated_at = ? WHERE command_id = ?
    `
      )
      .run(status, result == null ? null : JSON.stringify(result), error, new Date().toISOString(), commandId)
    const command = this.getCommand(commandId)
    if (!command) throw new Error(`Companion command not found: ${commandId}`)
    return command
  }

  private pruneAllPublished(retentionDays = 30, batchSize = 1_000): number {
    let total = 0
    while (true) {
      const deleted = this.prunePublished(retentionDays, batchSize)
      total += deleted
      if (deleted < batchSize) return total
    }
  }
}
