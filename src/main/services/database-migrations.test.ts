import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { runDatabaseMigrations } from './database-migrations'

describe('database migrations', () => {
  it('applies migrations once and records their version transactionally', () => {
    const database = new DatabaseSync(':memory:')
    const migrations = [
      { version: 1, name: 'create records', apply: () => database.exec('CREATE TABLE records (id TEXT PRIMARY KEY)') },
      { version: 2, name: 'add label', apply: () => database.exec('ALTER TABLE records ADD COLUMN label TEXT') }
    ]

    expect(runDatabaseMigrations(database, migrations)).toEqual({
      fromVersion: 0,
      toVersion: 2,
      applied: [
        { version: 1, name: 'create records' },
        { version: 2, name: 'add label' }
      ]
    })
    expect(runDatabaseMigrations(database, migrations).applied).toEqual([])
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
    database.close()
  })

  it('rolls back a failed migration without advancing the version', () => {
    const database = new DatabaseSync(':memory:')
    expect(() => runDatabaseMigrations(database, [
      {
        version: 1,
        name: 'broken migration',
        apply: () => {
          database.exec('CREATE TABLE transient_record (id TEXT PRIMARY KEY)')
          throw new Error('boom')
        }
      }
    ])).toThrow('Database migration 1 (broken migration) failed.')

    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'transient_record'").get()).toBeUndefined()
    database.close()
  })

  it('refuses to open a database created by a newer app version', () => {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA user_version = 3')
    expect(() => runDatabaseMigrations(database, [
      { version: 1, name: 'baseline', apply: () => undefined },
      { version: 2, name: 'next', apply: () => undefined }
    ])).toThrow('newer than this app supports')
    database.close()
  })
})
