import { env } from 'cloudflare:test'
import { beforeEach } from 'vitest'

declare const __ACCOUNT_MIGRATION_SQL__: string

for (const statement of __ACCOUNT_MIGRATION_SQL__
  .split(';')
  .map((value) => value.trim())
  .filter(Boolean)) {
  await env.ACCOUNT_DB.prepare(statement).run()
}

beforeEach(async () => {
  await env.ACCOUNT_DB.exec('PRAGMA foreign_keys = OFF')
  for (const table of [
    'auth_email_cooldowns',
    'relay_binding_attempts',
    'relay_revocation_jobs',
    'email_suppressions',
    'resend_webhook_events',
    'security_events',
    'auth_rate_limits',
    'device_grants',
    'space_memberships',
    'sync_spaces',
    'hosts',
    'auth_refresh_history',
    'auth_sessions',
    'devices',
    'auth_challenges',
    'auth_identities',
    'users'
  ]) {
    await env.ACCOUNT_DB.prepare(`DELETE FROM ${table}`).run()
  }
  await env.ACCOUNT_DB.exec('PRAGMA foreign_keys = ON')
})
