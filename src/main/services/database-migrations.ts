import type { DatabaseSync } from 'node:sqlite'

export interface DatabaseMigration {
  version: number
  name: string
  apply: () => void
}

export interface DatabaseMigrationResult {
  fromVersion: number
  toVersion: number
  applied: Array<Pick<DatabaseMigration, 'version' | 'name'>>
}

export function databaseSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as { user_version: number }
  return Number(row.user_version)
}

function validateMigrations(migrations: DatabaseMigration[]): void {
  let previous = 0
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= previous) {
      throw new Error('Database migrations must use unique, ascending positive integer versions.')
    }
    previous = migration.version
  }
}

/**
 * Applies every outstanding migration in its own SQLite transaction. The
 * version is persisted in the same transaction as the schema/data change, so
 * a crash can never leave a migration marked as complete before its writes.
 */
export function runDatabaseMigrations(
  database: DatabaseSync,
  migrations: DatabaseMigration[]
): DatabaseMigrationResult {
  validateMigrations(migrations)
  const fromVersion = databaseSchemaVersion(database)
  const latestVersion = migrations.at(-1)?.version ?? 0
  if (fromVersion > latestVersion) {
    throw new Error(`Database schema version ${fromVersion} is newer than this app supports (${latestVersion}).`)
  }

  const applied: DatabaseMigrationResult['applied'] = []
  for (const migration of migrations) {
    if (migration.version <= fromVersion) continue
    database.exec('BEGIN IMMEDIATE')
    try {
      migration.apply()
      database.exec(`PRAGMA user_version = ${migration.version}`)
      database.exec('COMMIT')
      applied.push({ version: migration.version, name: migration.name })
    } catch (error) {
      database.exec('ROLLBACK')
      throw new Error(`Database migration ${migration.version} (${migration.name}) failed.`, { cause: error })
    }
  }

  return { fromVersion, toVersion: databaseSchemaVersion(database), applied }
}
