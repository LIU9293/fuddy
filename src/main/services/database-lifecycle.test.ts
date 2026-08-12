import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './database'

const temporaryDirectories: string[] = []

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'project-agent-database-'))
  temporaryDirectories.push(directory)
  return join(directory, 'app.sqlite')
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('AppDatabase lifecycle', () => {
  it('records and preserves the current schema version across restarts', () => {
    const path = temporaryDatabasePath()
    new AppDatabase(path).close()

    const database = new DatabaseSync(path)
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 })
    database.close()

    new AppDatabase(path).close()
    const reopened = new DatabaseSync(path)
    expect(reopened.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 })
    reopened.close()
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
})
