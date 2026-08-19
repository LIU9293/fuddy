import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialStorageStatus, ProviderSettings } from '../../shared/contracts'
import { companionProtocolVersion } from '../../shared/companion-sync'
import { AppDatabase } from './database'

const temporaryDirectories: string[] = []

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'project-agent-database-'))
  temporaryDirectories.push(directory)
  return join(directory, 'app.sqlite')
}

afterEach(() => {
  vi.useRealTimers()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('AppDatabase lifecycle', () => {
  it('records and preserves the current schema version across restarts', () => {
    const path = temporaryDatabasePath()
    new AppDatabase(path).close()

    const database = new DatabaseSync(path)
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 })
    database.close()

    new AppDatabase(path).close()
    const reopened = new DatabaseSync(path)
    expect(reopened.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 })
    reopened.close()
  })

  it('adds per-session model settings when upgrading a version 3 database', () => {
    const path = temporaryDatabasePath()
    new AppDatabase(path).close()

    const legacy = new DatabaseSync(path)
    legacy.exec(`
      ALTER TABLE agent_runs DROP COLUMN model;
      ALTER TABLE agent_runs DROP COLUMN reasoning_effort;
      PRAGMA user_version = 3;
    `)
    legacy.close()

    new AppDatabase(path).close()
    const upgraded = new DatabaseSync(path)
    const columns = upgraded.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(['model', 'reasoning_effort']))
    expect(upgraded.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 })
    upgraded.close()
  })

  it('repairs and upgrades pending legacy events while adding outbox isolation columns', () => {
    const path = temporaryDatabasePath()
    new AppDatabase(path).close()
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      DROP INDEX companion_sync_outbox_pending_idx;
      ALTER TABLE companion_sync_outbox DROP COLUMN dead_lettered_at;
      ALTER TABLE companion_sync_outbox DROP COLUMN dead_letter_reason;
      PRAGMA user_version = 5;
    `)
    const now = new Date().toISOString()
    legacy.prepare(`
      INSERT INTO companion_sync_outbox (
        event_id, protocol_version, type, entity_type, entity_id, revision,
        payload_json, occurred_at, published_at, attempts, last_error
      ) VALUES (?, 3, 'command.updated', 'command', ?, 1, ?, ?, NULL, 42, 'Internal relay error.')
    `).run('legacy-poison', 'legacy-command', JSON.stringify({
      commandId: 'legacy-command',
      protocolVersion: 3,
      type: 'agent.send-message',
      payload: { runId: 'run-1', prompt: 'continue' },
      sourceDeviceId: 'ios-1',
      status: 'completed',
      result: { detail: 'x'.repeat(600_000) },
      error: null,
      createdAt: now,
      updatedAt: now
    }), now)
    legacy.prepare(`
      INSERT INTO companion_sync_outbox (
        event_id, protocol_version, type, entity_type, entity_id, revision,
        payload_json, occurred_at, published_at, attempts, last_error
      ) VALUES (?, 3, 'project.updated', 'project', ?, 2, ?, ?, NULL, 7, 'Network error.')
    `).run('legacy-project-event', 'legacy-project', JSON.stringify({ id: 'legacy-project' }), now)
    legacy.prepare(`
      INSERT INTO companion_remote_commands (
        command_id, protocol_version, type, payload_json, source_device_id,
        status, result_json, error, created_at, updated_at
      ) VALUES (?, 3, 'agent.send-message', ?, 'ios-1', 'executing', NULL, NULL, ?, ?)
    `).run('legacy-executing-command', JSON.stringify({ runId: 'run-1', prompt: 'continue' }), now, now)
    legacy.close()

    new AppDatabase(path).close()

    const upgraded = new DatabaseSync(path)
    const columns = upgraded.prepare('PRAGMA table_info(companion_sync_outbox)').all() as Array<{ name: string }>
    const repaired = upgraded.prepare(`
      SELECT protocol_version, payload_json, attempts, last_error
      FROM companion_sync_outbox WHERE event_id = 'legacy-poison'
    `).get() as { protocol_version: number; payload_json: string; attempts: number; last_error: string | null }
    const upgradedProjectEvent = upgraded.prepare(`
      SELECT protocol_version, payload_json, attempts, last_error
      FROM companion_sync_outbox WHERE event_id = 'legacy-project-event'
    `).get() as { protocol_version: number; payload_json: string; attempts: number; last_error: string | null }
    const upgradedRemoteCommand = upgraded.prepare(`
      SELECT protocol_version, status
      FROM companion_remote_commands WHERE command_id = 'legacy-executing-command'
    `).get() as { protocol_version: number; status: string }
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'dead_lettered_at',
      'dead_letter_reason'
    ]))
    expect(JSON.parse(repaired.payload_json)).toMatchObject({
      protocolVersion: companionProtocolVersion,
      payload: {},
      result: null
    })
    expect(repaired).toMatchObject({ protocol_version: companionProtocolVersion, attempts: 0, last_error: null })
    expect(JSON.parse(upgradedProjectEvent.payload_json)).toEqual({ id: 'legacy-project' })
    expect(upgradedProjectEvent).toMatchObject({
      protocol_version: companionProtocolVersion,
      attempts: 0,
      last_error: null
    })
    expect(upgradedRemoteCommand).toEqual({ protocol_version: companionProtocolVersion, status: 'executing' })
    expect(upgraded.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 })
    upgraded.close()
  })

  it('starts a clean install without private or sample projects', () => {
    const database = new AppDatabase(temporaryDatabasePath())
    expect(database.listProjects()).toEqual([])
    expect(database.listConnectors()).toEqual([])
    database.close()
  })

  it('loads only requested bootstrap domains for renderer event refreshes', () => {
    const database = new AppDatabase(temporaryDatabasePath())
    const patch = database.getBootstrapPatch(
      ['projects', 'permissionMode'],
      [],
      [],
      [],
      {} as CredentialStorageStatus,
      {} as ProviderSettings
    )

    expect(patch).toEqual({ projects: [], permissionMode: 'full-access' })
    expect(patch).not.toHaveProperty('runs')
    database.close()
  })

  it('rejects a newer database before seed or schema writes occur', () => {
    const path = temporaryDatabasePath()
    const future = new DatabaseSync(path)
    future.exec('PRAGMA user_version = 99')
    future.close()

    expect(() => new AppDatabase(path)).toThrow('newer than this app supports')
    const unchanged = new DatabaseSync(path)
    expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([])
    expect(unchanged.prepare('PRAGMA user_version').get()).toEqual({ user_version: 99 })
    unchanged.close()
  })

  it('prunes only published outbox events older than the retention window', () => {
    const database = new AppDatabase(temporaryDatabasePath())
    const expired = database.enqueueAgentTurnSettled({
      runId: 'expired-run', turnId: 'expired-turn', title: 'Expired', outcome: 'completed', summary: '', settledAt: new Date().toISOString()
    })
    const recent = database.enqueueAgentTurnSettled({
      runId: 'recent-run', turnId: 'recent-turn', title: 'Recent', outcome: 'completed', summary: '', settledAt: new Date().toISOString()
    })
    const pending = database.enqueueAgentTurnSettled({
      runId: 'pending-run', turnId: 'pending-turn', title: 'Pending', outcome: 'completed', summary: '', settledAt: new Date().toISOString()
    })
    database.markCompanionEventPublished(expired.eventId, new Date(Date.now() - 45 * 86_400_000).toISOString())
    database.markCompanionEventPublished(recent.eventId, new Date().toISOString())

    expect(database.prunePublishedCompanionEvents(30)).toBe(1)
    expect(database.listPendingCompanionEvents().map((event) => event.eventId)).toContain(pending.eventId)
    expect(database.prunePublishedCompanionEvents(30)).toBe(0)
    database.close()
  })

  it('drains more than one expired outbox batch on startup', () => {
    const path = temporaryDatabasePath()
    const database = new AppDatabase(path)
    for (let index = 0; index < 1_005; index += 1) {
      database.enqueueAgentTurnSettled({
        runId: `run-${index}`,
        turnId: `turn-${index}`,
        title: 'Expired',
        outcome: 'completed',
        summary: '',
        settledAt: new Date().toISOString()
      })
    }
    database.close()

    const published = new DatabaseSync(path)
    published.prepare('UPDATE companion_sync_outbox SET published_at = ?')
      .run(new Date(Date.now() - 45 * 86_400_000).toISOString())
    published.close()

    new AppDatabase(path).close()
    const reopened = new DatabaseSync(path)
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM companion_sync_outbox').get()).toEqual({ count: 0 })
    reopened.close()
  })

  it('repeats retention cleanup while the app remains open', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const path = temporaryDatabasePath()
    const database = new AppDatabase(path)
    const expired = database.enqueueAgentTurnSettled({
      runId: 'expired-run', turnId: 'expired-turn', title: 'Expired', outcome: 'completed', summary: '', settledAt: new Date().toISOString()
    })
    database.markCompanionEventPublished(expired.eventId, '2025-11-01T00:00:00.000Z')

    vi.advanceTimersByTime(25 * 60 * 60 * 1_000)
    const trigger = database.enqueueAgentTurnSettled({
      runId: 'trigger-run', turnId: 'trigger-turn', title: 'Trigger', outcome: 'completed', summary: '', settledAt: new Date().toISOString()
    })
    database.markCompanionEventPublished(trigger.eventId, new Date().toISOString())
    database.close()

    const reopened = new DatabaseSync(path)
    expect(reopened.prepare('SELECT event_id FROM companion_sync_outbox WHERE event_id = ?').get(expired.eventId)).toBeUndefined()
    expect(reopened.prepare('SELECT event_id FROM companion_sync_outbox WHERE event_id = ?').get(trigger.eventId)).toEqual({ event_id: trigger.eventId })
    reopened.close()
  })
})
