import { SELF, env } from 'cloudflare:test'
import { Webhook } from 'svix'
import { describe, expect, it, vi } from 'vitest'
import type { RelayAdministrationBinding } from '../../relay/src/administration-contract'
import {
  activatePendingEnrollment,
  bindRelay,
  linkVerifiedGoogleIdentity,
  parseResendErrorDetails,
  processRelayRevocationJobs,
  reactivateRelayAccountIfNeeded,
  relayBindingUsesManagedAuthority
} from '../src/index'
import type { DeviceInput } from '../src/types'

const device: DeviceInput = {
  platform: 'macos',
  name: '测试 Mac',
  publicKey: 'test-public-key-material',
  appVersion: '0.0.3',
  protocolVersion: 1
}
const OTP_MAX_ATTEMPTS_FOR_TEST = 5

async function post(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://account.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.10' },
    body: JSON.stringify(body)
  })
}

async function signIn(email = 'kai@example.com', inputDevice = device) {
  const start = await post('/v1/auth/email/start', { email })
  const challenge = await start.json<{ challengeId: string; debugCode: string }>()
  const verify = await post('/v1/auth/email/verify', {
    challengeId: challenge.challengeId,
    code: challenge.debugCode,
    device: inputDevice
  })
  return { start, challenge, verify, payload: await verify.json<any>() }
}

describe('email authentication', () => {
  it('extracts bounded Resend errors without accepting unrelated response bodies', () => {
    expect(parseResendErrorDetails(JSON.stringify({ name: 'validation_error', message: 'Domain is not verified.' })))
      .toEqual({ name: 'validation_error', message: 'Domain is not verified.' })
    expect(parseResendErrorDetails(JSON.stringify({ unexpected: 'body' }))).toBeNull()
    expect(parseResendErrorDetails('not-json')).toBeNull()
  })

  it('serves the Account API below the canonical domain path', async () => {
    const response = await SELF.fetch('https://account.test/api/account/health')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('accepts only the administered Relay authority in production', () => {
    expect(relayBindingUsesManagedAuthority('https://fuddy.ai/api/relay', 'production')).toBe(true)
    expect(relayBindingUsesManagedAuthority('https://fuddy.ai/api/relay/', 'production')).toBe(true)
    expect(relayBindingUsesManagedAuthority('https://custom-relay.example.com', 'production')).toBe(false)
    expect(relayBindingUsesManagedAuthority('https://custom-relay.example.com', 'development')).toBe(true)
  })

  it('creates a user, Mac host, sync space, and reusable session', async () => {
    const result = await signIn()
    expect(result.start.status).toBe(202)
    expect(result.verify.status).toBe(200)
    expect(result.payload.user.email).toBe('kai@example.com')
    expect(result.payload.device.hostId).toMatch(/[0-9a-f-]{36}/u)
    expect(result.payload.device.syncSpaceId).toMatch(/[0-9a-f-]{36}/u)

    const me = await SELF.fetch('https://account.test/v1/me', {
      headers: { authorization: `Bearer ${result.payload.session.accessToken}` }
    })
    expect(me.status).toBe(200)
    await expect(me.json()).resolves.toMatchObject({ user: { email: 'kai@example.com' } })
  })

  it('atomically reserves one email cooldown under parallel starts', async () => {
    const email = 'parallel-start@example.com'
    const starts = await Promise.all(
      Array.from({ length: 20 }, () => post('/v1/auth/email/start', { email }))
    )
    expect(starts.filter((result) => result.status === 202)).toHaveLength(1)
    expect(starts.filter((result) => result.status === 429)).toHaveLength(19)
    await expect(env.ACCOUNT_DB.prepare(
      'SELECT COUNT(*) AS count FROM auth_challenges WHERE email = ?'
    ).bind(email).first()).resolves.toEqual({ count: 1 })
    await expect(env.ACCOUNT_DB.prepare(
      'SELECT COUNT(*) AS count FROM auth_email_cooldowns WHERE email = ?'
    ).bind(email).first()).resolves.toEqual({ count: 1 })
  })

  it('atomically limits parallel verification attempts for one email code', async () => {
    const started = await post('/v1/auth/email/start', { email: 'parallel-otp@example.com' })
    const challenge = await started.json<{ challengeId: string; debugCode: string }>()
    const invalidCode = challenge.debugCode === '000000' ? '111111' : '000000'
    const attempts = await Promise.all(Array.from({ length: 20 }, () => post('/v1/auth/email/verify', {
      challengeId: challenge.challengeId,
      code: invalidCode,
      device
    })))
    const statuses = attempts.map((attempt) => attempt.status)
    expect(statuses.filter((status) => status === 400)).toHaveLength(OTP_MAX_ATTEMPTS_FOR_TEST)
    expect(statuses.filter((status) => status === 429)).toHaveLength(20 - OTP_MAX_ATTEMPTS_FOR_TEST)
    await expect(env.ACCOUNT_DB.prepare(
      'SELECT attempt_count AS attemptCount FROM auth_challenges WHERE id = ?'
    ).bind(challenge.challengeId).first()).resolves.toEqual({ attemptCount: OTP_MAX_ATTEMPTS_FOR_TEST })

    const validAfterExhaustion = await post('/v1/auth/email/verify', {
      challengeId: challenge.challengeId,
      code: challenge.debugCode,
      device
    })
    expect(validAfterExhaustion.status).toBe(429)
  })

  it('keeps one installation isolated when it signs in to different accounts', async () => {
    const installation = { ...device, id: crypto.randomUUID() }
    const first = await signIn('first-account@example.com', installation)
    const second = await signIn('second-account@example.com', installation)
    expect(first.verify.status).toBe(200)
    expect(second.verify.status).toBe(200)
    expect(first.payload.device.id).not.toBe(second.payload.device.id)
  })

  it('keeps one Device, Host, and Sync Space when the same Mac signs in concurrently', async () => {
    const email = 'concurrent-mac@example.com'
    await signIn(email, { ...device, id: crypto.randomUUID() })
    await env.ACCOUNT_DB.prepare(
      `UPDATE auth_challenges SET created_at = datetime('now', '-2 minutes') WHERE email = ?`
    ).bind(email).run()
    await env.ACCOUNT_DB.prepare('DELETE FROM auth_email_cooldowns WHERE email = ?').bind(email).run()
    const leftStart = await post('/v1/auth/email/start', { email })
    const left = await leftStart.json<{ challengeId: string; debugCode: string }>()
    await env.ACCOUNT_DB.prepare(
      `UPDATE auth_challenges SET created_at = datetime('now', '-2 minutes') WHERE id = ?`
    ).bind(left.challengeId).run()
    await env.ACCOUNT_DB.prepare('DELETE FROM auth_email_cooldowns WHERE email = ?').bind(email).run()
    const rightStart = await post('/v1/auth/email/start', { email })
    const right = await rightStart.json<{ challengeId: string; debugCode: string }>()
    const installation = { ...device, id: crypto.randomUUID(), name: '并发 Mac' }
    const [leftVerify, rightVerify] = await Promise.all([
      post('/v1/auth/email/verify', { challengeId: left.challengeId, code: left.debugCode, device: installation }),
      post('/v1/auth/email/verify', { challengeId: right.challengeId, code: right.debugCode, device: installation })
    ])
    expect([leftVerify.status, rightVerify.status]).toEqual([200, 200])
    const user = await env.ACCOUNT_DB.prepare('SELECT id FROM users WHERE primary_email = ?')
      .bind(email)
      .first<{ id: string }>()
    const counts = await env.ACCOUNT_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM devices WHERE user_id = ?) AS devices,
         (SELECT COUNT(*) FROM hosts WHERE user_id = ?) AS hosts,
         (SELECT COUNT(*) FROM sync_spaces WHERE owner_user_id = ?) AS spaces`
    ).bind(user!.id, user!.id, user!.id).first<{ devices: number; hosts: number; spaces: number }>()
    expect(counts).toEqual({ devices: 2, hosts: 2, spaces: 2 })
  })

  it('rejects an incorrect code and accepts the original code afterward', async () => {
    const start = await post('/v1/auth/email/start', { email: 'retry@example.com' })
    const challenge = await start.json<{ challengeId: string; debugCode: string }>()
    const bad = await post('/v1/auth/email/verify', {
      challengeId: challenge.challengeId,
      code: challenge.debugCode === '000000' ? '000001' : '000000',
      device
    })
    expect(bad.status).toBe(400)
    await expect(bad.json()).resolves.toMatchObject({ error: { code: 'otp_invalid' } })

    const good = await post('/v1/auth/email/verify', {
      challengeId: challenge.challengeId,
      code: challenge.debugCode,
      device
    })
    expect(good.status).toBe(200)
  })

  it('consumes an email code exactly once', async () => {
    const start = await post('/v1/auth/email/start', { email: 'once@example.com' })
    const challenge = await start.json<{ challengeId: string; debugCode: string }>()
    const body = { challengeId: challenge.challengeId, code: challenge.debugCode, device }
    expect((await post('/v1/auth/email/verify', body)).status).toBe(200)
    const replay = await post('/v1/auth/email/verify', body)
    expect(replay.status).toBe(400)
    await expect(replay.json()).resolves.toMatchObject({ error: { code: 'otp_expired' } })
  })

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const { payload } = await signIn('rotation@example.com')
    const firstRefresh = payload.session.refreshToken as string
    const rotated = await post('/v1/auth/refresh', { refreshToken: firstRefresh })
    expect(rotated.status).toBe(200)
    const rotatedPayload = await rotated.json<any>()

    const reused = await post('/v1/auth/refresh', { refreshToken: firstRefresh })
    expect(reused.status).toBe(401)
    await expect(reused.json()).resolves.toMatchObject({ error: { code: 'refresh_token_reused' } })

    const revoked = await post('/v1/auth/refresh', { refreshToken: rotatedPayload.session.refreshToken })
    expect(revoked.status).toBe(401)
  })

  it('allows only one concurrent refresh and revokes the family when the old token races', async () => {
    const { payload } = await signIn('refresh-race@example.com')
    const refreshToken = payload.session.refreshToken as string
    const [left, right] = await Promise.all([
      post('/v1/auth/refresh', { refreshToken }),
      post('/v1/auth/refresh', { refreshToken })
    ])
    expect([left.status, right.status].sort()).toEqual([200, 401])
    const successful = left.status === 200 ? left : right
    const next = await successful.json<any>()
    expect((await post('/v1/auth/refresh', { refreshToken: next.session.refreshToken })).status).toBe(401)
  })

  it('detects replay of any previously rotated refresh token, not only the latest one', async () => {
    const { payload } = await signIn('refresh-history@example.com')
    const firstToken = payload.session.refreshToken as string
    const firstRotation = await post('/v1/auth/refresh', { refreshToken: firstToken })
    const firstRotationPayload = await firstRotation.json<any>()
    const secondRotation = await post('/v1/auth/refresh', {
      refreshToken: firstRotationPayload.session.refreshToken
    })
    const secondRotationPayload = await secondRotation.json<any>()

    const replay = await post('/v1/auth/refresh', { refreshToken: firstToken })
    expect(replay.status).toBe(401)
    await expect(replay.json()).resolves.toMatchObject({ error: { code: 'refresh_token_reused' } })
    expect((await post('/v1/auth/refresh', {
      refreshToken: secondRotationPayload.session.refreshToken
    })).status).toBe(401)
  })

  it('revokes one device and every session issued to it', async () => {
    const { payload } = await signIn('device-revoke@example.com')
    const revoked = await SELF.fetch(`https://account.test/v1/devices/${payload.device.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${payload.session.accessToken}` }
    })
    expect(revoked.status).toBe(204)

    const refresh = await post('/v1/auth/refresh', { refreshToken: payload.session.refreshToken })
    expect(refresh.status).toBe(401)
    const me = await SELF.fetch('https://account.test/v1/me', {
      headers: { authorization: `Bearer ${payload.session.accessToken}` }
    })
    expect(me.status).toBe(401)
  })

  it('revokes every phone grant when its Mac is removed', async () => {
    const { payload } = await signIn('remove-mac@example.com')
    const iosDeviceId = crypto.randomUUID()
    const grantId = crypto.randomUUID()
    const relayAccountId = 'relay-account-to-revoke'
    const now = new Date().toISOString()
    await env.ACCOUNT_DB.batch([
      env.ACCOUNT_DB.prepare(
        'UPDATE sync_spaces SET relay_url = ?, relay_account_id = ?, updated_at = ? WHERE id = ?'
      ).bind('https://fuddy.ai/api/relay', relayAccountId, now, payload.device.syncSpaceId),
      env.ACCOUNT_DB.prepare(
        `INSERT INTO devices
          (id, user_id, platform, name, public_key, app_version, protocol_version, created_at, updated_at, last_seen_at)
         VALUES (?, ?, 'ios', '测试 iPhone', ?, '0.0.3', 1, ?, ?, ?)`
      ).bind(iosDeviceId, payload.user.id, 'ios-key', now, now, now),
      env.ACCOUNT_DB.prepare(
        `INSERT INTO device_grants
          (id, space_id, device_id, requested_by_user_id, status, created_at, updated_at, expires_at, activated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`
      ).bind(
        grantId,
        payload.device.syncSpaceId,
        iosDeviceId,
        payload.user.id,
        now,
        now,
        new Date(Date.now() + 10 * 60_000).toISOString(),
        now
      )
    ])

    const revoked = await SELF.fetch(`https://account.test/v1/devices/${payload.device.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${payload.session.accessToken}` }
    })
    expect(revoked.status).toBe(204)
    await expect(env.ACCOUNT_DB.prepare(
      'SELECT status FROM device_grants WHERE id = ?'
    ).bind(grantId).first()).resolves.toMatchObject({ status: 'revoked' })

    const jobId = `account:${payload.device.syncSpaceId}:${relayAccountId}`
    const pendingJob = await env.ACCOUNT_DB.prepare(
      `SELECT status, attempt_count AS attemptCount
       FROM relay_revocation_jobs WHERE id = ?`
    ).bind(jobId).first<{ status: string; attemptCount: number }>()
    expect(pendingJob).toEqual({ status: 'pending', attemptCount: 0 })

    const relayAdmin = {
      revokeDevice: vi.fn(async () => true),
      claimAccountBinding: vi.fn(async () => true),
      confirmAccountBinding: vi.fn(async () => true),
      releaseAccountBinding: vi.fn(async () => true),
      setAccountGeneration: vi.fn(async () => true),
      revokeAccount: vi.fn()
        .mockRejectedValueOnce(new Error('temporary Relay outage'))
        .mockResolvedValue(true)
    } satisfies RelayAdministrationBinding
    const firstRetry = await processRelayRevocationJobs(env, {
      relayAdmin,
      now: new Date('2030-01-01T00:00:00.000Z')
    })
    expect(firstRetry).toEqual({ attempted: 1, completed: 0 })
    await expect(env.ACCOUNT_DB.prepare(
      `SELECT status, attempt_count AS attemptCount, last_error AS lastError
       FROM relay_revocation_jobs WHERE id = ?`
    ).bind(jobId).first()).resolves.toMatchObject({
      status: 'pending',
      attemptCount: 1,
      lastError: 'temporary Relay outage'
    })

    const secondRetry = await processRelayRevocationJobs(env, {
      relayAdmin,
      now: new Date('2030-01-01T00:01:00.000Z')
    })
    expect(secondRetry).toEqual({ attempted: 1, completed: 1 })
    expect(relayAdmin.revokeAccount).toHaveBeenCalledTimes(2)
    await expect(env.ACCOUNT_DB.prepare(
      'SELECT status FROM relay_revocation_jobs WHERE id = ?'
    ).bind(jobId).first()).resolves.toMatchObject({ status: 'completed' })
    await expect(env.ACCOUNT_DB.prepare(
      'SELECT relay_revoked_at AS relayRevokedAt FROM device_grants WHERE id = ?'
    ).bind(grantId).first<{ relayRevokedAt: string | null }>()).resolves.toMatchObject({
      relayRevokedAt: expect.any(String)
    })
  })

  it('retries Relay-generation activation before completing an old account revocation', async () => {
    const email = 'relay-reactivation@example.com'
    const installation = { ...device, id: crypto.randomUUID() }
    const first = await signIn(email, installation)
    const spaceId = first.payload.device.syncSpaceId as string
    const relayAccountId = 'relay-account-reactivated'
    const revokedDeviceId = crypto.randomUUID()
    const revokedGrantId = crypto.randomUUID()
    const timestamp = new Date().toISOString()
    await env.ACCOUNT_DB.batch([
      env.ACCOUNT_DB.prepare(
        'UPDATE sync_spaces SET relay_account_id = ?, updated_at = ? WHERE id = ?'
      ).bind(relayAccountId, timestamp, spaceId),
      env.ACCOUNT_DB.prepare(
        `INSERT INTO relay_revocation_jobs
          (id, operation, source_id, relay_account_id, device_id, source_generation,
           status, attempt_count, next_attempt_at, created_at, updated_at)
         VALUES (?, 'account', ?, ?, NULL, 1, 'pending', 1, ?, ?, ?)`
      ).bind(
        `account:${spaceId}:${relayAccountId}`,
        spaceId,
        relayAccountId,
        timestamp,
        timestamp,
        timestamp
      ),
      env.ACCOUNT_DB.prepare(
        `INSERT INTO devices
          (id, user_id, platform, name, public_key, app_version, protocol_version,
           created_at, updated_at, last_seen_at, revoked_at)
         VALUES (?, ?, 'ios', '已撤销的 iPhone', 'revoked-public-key', '0.0.3', 1, ?, ?, ?, ?)`
      ).bind(
        revokedDeviceId,
        first.payload.user.id,
        timestamp,
        timestamp,
        timestamp,
        timestamp
      ),
      env.ACCOUNT_DB.prepare(
        `INSERT INTO device_grants
          (id, space_id, device_id, requested_by_user_id, status, created_at, updated_at,
           expires_at, revoked_at)
         VALUES (?, ?, ?, ?, 'revoked', ?, ?, ?, ?)`
      ).bind(
        revokedGrantId,
        spaceId,
        revokedDeviceId,
        first.payload.user.id,
        timestamp,
        timestamp,
        new Date(Date.now() + 10 * 60_000).toISOString(),
        timestamp
      ),
      env.ACCOUNT_DB.prepare('DELETE FROM auth_email_cooldowns WHERE email = ?').bind(email)
    ])

    const second = await signIn(email, installation)
    expect(second.verify.status).toBe(200)
    const relayAdmin = {
      revokeDevice: vi.fn(async () => { throw new Error('temporary device revocation outage') }),
      claimAccountBinding: vi.fn(async () => true),
      confirmAccountBinding: vi.fn(async () => true),
      releaseAccountBinding: vi.fn(async () => true),
      setAccountGeneration: vi.fn()
        .mockRejectedValueOnce(new Error('temporary Relay outage'))
        .mockResolvedValue(true),
      revokeAccount: vi.fn(async () => true)
    } satisfies RelayAdministrationBinding
    await expect(reactivateRelayAccountIfNeeded(env, spaceId, relayAdmin))
      .rejects.toThrow('temporary Relay outage')
    await expect(env.ACCOUNT_DB.prepare(
      'SELECT relay_generation AS relayGeneration FROM sync_spaces WHERE id = ?'
    ).bind(spaceId).first()).resolves.toEqual({ relayGeneration: 2 })
    await expect(env.ACCOUNT_DB.prepare(
      `SELECT status, source_generation AS sourceGeneration
       FROM relay_revocation_jobs WHERE id = ?`
    ).bind(`account:${spaceId}:${relayAccountId}`).first()).resolves.toEqual({
      status: 'pending',
      sourceGeneration: 1
    })
    await expect(processRelayRevocationJobs(env, {
      relayAdmin,
      now: new Date('2030-01-01T00:00:00.000Z')
    })).resolves.toEqual({ attempted: 1, completed: 1 })
    expect(relayAdmin.setAccountGeneration).toHaveBeenNthCalledWith(1, relayAccountId, spaceId, null, 2)
    expect(relayAdmin.setAccountGeneration).toHaveBeenNthCalledWith(2, relayAccountId, spaceId, null, 2)
    await expect(env.ACCOUNT_DB.prepare(
      `SELECT status, source_generation AS sourceGeneration
       FROM relay_revocation_jobs WHERE id = ?`
    ).bind(`account:${spaceId}:${relayAccountId}`).first()).resolves.toEqual({
      status: 'completed',
      sourceGeneration: 1
    })
    await expect(env.ACCOUNT_DB.prepare(
      `SELECT status, attempt_count AS attemptCount
       FROM relay_revocation_jobs WHERE id = ?`
    ).bind(`device:${revokedGrantId}`).first()).resolves.toEqual({
      status: 'pending',
      attemptCount: 0
    })
    expect(relayAdmin.revokeDevice).not.toHaveBeenCalled()
    await expect(env.ACCOUNT_DB.prepare(
      'SELECT relay_revoked_at AS relayRevokedAt FROM device_grants WHERE id = ?'
    ).bind(revokedGrantId).first()).resolves.toEqual({ relayRevokedAt: null })
  })

  it('durably revokes the previous Relay account when a re-signed-in Mac replaces it', async () => {
    const email = 'relay-replacement@example.com'
    const installation = { ...device, id: crypto.randomUUID() }
    const first = await signIn(email, installation)
    const spaceId = first.payload.device.syncSpaceId as string
    const oldRelayAccountId = 'relay-account-before-logout'
    const newRelayAccountId = 'relay-account-after-login'
    const authorization = (accessToken: string) => ({
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json'
    })

    const initialBinding = await SELF.fetch(`https://account.test/v1/sync-spaces/${spaceId}/relay-binding`, {
      method: 'POST',
      headers: authorization(first.payload.session.accessToken),
      body: JSON.stringify({
        relayUrl: 'https://fuddy.ai/api/relay',
        relayAccountId: oldRelayAccountId,
        bindingProof: 'test-binding-proof-old-relay'
      })
    })
    expect(initialBinding.status).toBe(200)
    expect(await env.ACCOUNT_DB.prepare(
      `SELECT COUNT(*) AS count FROM relay_revocation_jobs
       WHERE source_id = ? AND operation = 'account'`
    ).bind(spaceId).first()).toEqual({ count: 0 })

    const logout = await SELF.fetch('https://account.test/v1/auth/logout-all', {
      method: 'POST',
      headers: authorization(first.payload.session.accessToken)
    })
    expect(logout.status).toBe(204)
    await env.ACCOUNT_DB.prepare('DELETE FROM auth_email_cooldowns WHERE email = ?').bind(email).run()
    const second = await signIn(email, installation)
    expect(second.verify.status).toBe(200)
    const relayAdmin = {
      revokeDevice: vi.fn(async () => true),
      claimAccountBinding: vi.fn(async () => true),
      confirmAccountBinding: vi.fn(async () => true),
      releaseAccountBinding: vi.fn(async () => true),
      setAccountGeneration: vi.fn(async () => true),
      revokeAccount: vi.fn(async () => true)
    } satisfies RelayAdministrationBinding
    await expect(reactivateRelayAccountIfNeeded(env, spaceId, relayAdmin)).resolves.toBe(2)
    await expect(env.ACCOUNT_DB.prepare(
      `SELECT status, source_generation AS sourceGeneration
       FROM relay_revocation_jobs WHERE id = ?`
    ).bind(`account:${spaceId}:${oldRelayAccountId}`).first()).resolves.toEqual({
      status: 'completed',
      sourceGeneration: 1
    })

    const replacement = await SELF.fetch(`https://account.test/v1/sync-spaces/${spaceId}/relay-binding`, {
      method: 'POST',
      headers: authorization(second.payload.session.accessToken),
      body: JSON.stringify({
        relayUrl: 'https://fuddy.ai/api/relay',
        relayAccountId: newRelayAccountId,
        bindingProof: 'test-binding-proof-new-relay'
      })
    })
    expect(replacement.status).toBe(200)
    await expect(env.ACCOUNT_DB.prepare(
      `SELECT relay_account_id AS relayAccountId, relay_generation AS relayGeneration
       FROM sync_spaces WHERE id = ?`
    ).bind(spaceId).first()).resolves.toEqual({ relayAccountId: newRelayAccountId, relayGeneration: 2 })
    await expect(env.ACCOUNT_DB.prepare(
      `SELECT status, source_generation AS sourceGeneration
       FROM relay_revocation_jobs WHERE id = ?`
    ).bind(`account:${spaceId}:${oldRelayAccountId}`).first()).resolves.toEqual({
      status: 'pending',
      sourceGeneration: 2
    })

    await expect(processRelayRevocationJobs(env, {
      relayAdmin,
      now: new Date('2030-01-01T00:00:00.000Z')
    })).resolves.toEqual({ attempted: 1, completed: 1 })
    expect(relayAdmin.revokeAccount).toHaveBeenCalledWith(
      oldRelayAccountId,
      spaceId,
      expect.any(String),
      2
    )
    expect(relayAdmin.revokeAccount).not.toHaveBeenCalledWith(
      newRelayAccountId,
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
    await expect(env.ACCOUNT_DB.prepare(
      'SELECT status FROM relay_revocation_jobs WHERE id = ?'
    ).bind(`account:${spaceId}:${oldRelayAccountId}`).first()).resolves.toEqual({ status: 'completed' })
  })

  it('claims a one-time Relay proof before finalizing the D1 binding', async () => {
    const { payload } = await signIn('relay-proof@example.com')
    const spaceId = payload.device.syncSpaceId as string
    const relayAccountId = 'relay-account-with-proof'
    const relayAdmin = {
      revokeDevice: vi.fn(async () => true),
      claimAccountBinding: vi.fn(async () => true),
      confirmAccountBinding: vi.fn(async () => true),
      releaseAccountBinding: vi.fn(async () => true),
      setAccountGeneration: vi.fn(async () => true),
      revokeAccount: vi.fn(async () => true)
    } satisfies RelayAdministrationBinding
    const request = new Request(`https://account.test/v1/sync-spaces/${spaceId}/relay-binding`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${payload.session.accessToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        relayUrl: 'https://fuddy.ai/api/relay',
        relayAccountId,
        bindingProof: 'one-time-relay-binding-proof'
      })
    })

    const response = await bindRelay(request, env, spaceId, relayAdmin)
    expect(response.status).toBe(200)
    const binding = await env.ACCOUNT_DB.prepare(
      `SELECT relay_account_id AS relayAccountId, relay_binding_id AS relayBindingId
       FROM sync_spaces WHERE id = ?`
    ).bind(spaceId).first<{ relayAccountId: string; relayBindingId: string }>()
    expect(binding).toEqual({ relayAccountId, relayBindingId: expect.any(String) })
    expect(relayAdmin.claimAccountBinding).toHaveBeenCalledWith(
      relayAccountId,
      spaceId,
      binding!.relayBindingId,
      1,
      'one-time-relay-binding-proof'
    )
    expect(relayAdmin.confirmAccountBinding).toHaveBeenCalledWith(
      relayAccountId,
      spaceId,
      binding!.relayBindingId
    )
    expect(relayAdmin.releaseAccountBinding).not.toHaveBeenCalled()
  })

  it('does not enqueue an old-account revocation when the binding CAS loses a race', async () => {
    const { payload } = await signIn('relay-binding-race@example.com')
    const spaceId = payload.device.syncSpaceId as string
    const oldRelayAccountId = 'relay-before-binding-race'
    const authorization = `Bearer ${payload.session.accessToken}`
    const initial = await SELF.fetch(`https://account.test/v1/sync-spaces/${spaceId}/relay-binding`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        relayUrl: 'https://fuddy.ai/api/relay',
        relayAccountId: oldRelayAccountId,
        bindingProof: 'initial-binding-proof-for-race'
      })
    })
    expect(initial.status).toBe(200)
    const relayAdmin = {
      revokeDevice: vi.fn(async () => true),
      claimAccountBinding: vi.fn(async () => {
        await env.ACCOUNT_DB.prepare(
          'UPDATE sync_spaces SET relay_generation = relay_generation + 1 WHERE id = ?'
        ).bind(spaceId).run()
        return true
      }),
      confirmAccountBinding: vi.fn(async () => true),
      releaseAccountBinding: vi.fn(async () => true),
      setAccountGeneration: vi.fn(async () => true),
      revokeAccount: vi.fn(async () => true)
    } satisfies RelayAdministrationBinding
    const racedRequest = new Request(`https://account.test/v1/sync-spaces/${spaceId}/relay-binding`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        relayUrl: 'https://fuddy.ai/api/relay',
        relayAccountId: 'relay-after-binding-race',
        bindingProof: 'replacement-binding-proof-for-race'
      })
    })

    await expect(bindRelay(racedRequest, env, spaceId, relayAdmin)).rejects.toMatchObject({
      status: 409,
      code: 'relay_binding_changed'
    })
    await expect(env.ACCOUNT_DB.prepare(
      `SELECT COUNT(*) AS count FROM relay_revocation_jobs
       WHERE source_id = ? AND relay_account_id = ?`
    ).bind(spaceId, oldRelayAccountId).first()).resolves.toEqual({ count: 0 })
    expect(relayAdmin.releaseAccountBinding).toHaveBeenCalledOnce()
    expect(relayAdmin.confirmAccountBinding).not.toHaveBeenCalled()
  })

  it('lists the current device separately from other signed-in devices', async () => {
    const first = await signIn('devices@example.com', { ...device, id: crypto.randomUUID() })
    await env.ACCOUNT_DB.prepare(
      `UPDATE auth_challenges SET created_at = datetime('now', '-2 minutes') WHERE email = ?`
    ).bind('devices@example.com').run()
    await env.ACCOUNT_DB.prepare('DELETE FROM auth_email_cooldowns WHERE email = ?')
      .bind('devices@example.com')
      .run()
    const second = await signIn('devices@example.com', { ...device, id: crypto.randomUUID(), name: '备用 Mac' })
    const response = await SELF.fetch('https://account.test/v1/devices', {
      headers: { authorization: `Bearer ${first.payload.session.accessToken}` }
    })
    expect(response.status).toBe(200)
    const payload = await response.json<any>()
    expect(payload.devices).toHaveLength(2)
    expect(payload.devices.find((item: any) => item.id === first.payload.device.id)?.isCurrent).toBe(1)
    expect(payload.devices.find((item: any) => item.id === second.payload.device.id)?.isCurrent).toBe(0)
  })

  it('links a verified Google identity only to its authenticated Fuddy account', async () => {
    const current = await signIn('link-google@example.com')
    await linkVerifiedGoogleIdentity(
      env,
      { userId: current.payload.user.id, deviceId: current.payload.device.id },
      { subject: 'google-subject-1', email: 'google@example.com', displayName: 'Google User' }
    )
    const identities = await SELF.fetch('https://account.test/v1/identities', {
      headers: { authorization: `Bearer ${current.payload.session.accessToken}` }
    })
    await expect(identities.json()).resolves.toMatchObject({
      identities: [
        { provider: 'email', email: 'link-google@example.com' },
        { provider: 'google', email: 'google@example.com' }
      ]
    })

    const other = await signIn('other-account@example.com')
    await expect(linkVerifiedGoogleIdentity(
      env,
      { userId: other.payload.user.id, deviceId: other.payload.device.id },
      { subject: 'google-subject-1', email: 'google@example.com', displayName: null }
    )).rejects.toThrow('另一个 Fuddy 账户')
  })

  it('verifies and deduplicates Resend webhooks, then suppresses bounced OTP recipients', async () => {
    const email = 'bounce@example.com'
    const started = await post('/v1/auth/email/start', { email })
    const challenge = await started.json<{ challengeId: string }>()
    const resendEmailId = crypto.randomUUID()
    await env.ACCOUNT_DB.prepare(
      `UPDATE auth_challenges SET resend_email_id = ?, delivery_status = 'sent' WHERE id = ?`
    ).bind(resendEmailId, challenge.challengeId).run()

    const body = JSON.stringify({
      type: 'email.bounced',
      created_at: new Date().toISOString(),
      data: { email_id: resendEmailId }
    })
    const secret = 'whsec_MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE='
    const id = `msg_${crypto.randomUUID()}`
    const timestamp = new Date()
    const signature = new Webhook(secret).sign(id, timestamp, body)
    const headers = {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'svix-signature': signature
    }
    const first = await SELF.fetch('https://account.test/v1/webhooks/resend', { method: 'POST', headers, body })
    expect(first.status).toBe(200)
    const duplicate = await SELF.fetch('https://account.test/v1/webhooks/resend', { method: 'POST', headers, body })
    await expect(duplicate.json()).resolves.toEqual({ accepted: true, duplicate: true })

    const resend = await post('/v1/auth/email/start', { email })
    expect(resend.status).toBe(422)
    await expect(resend.json()).resolves.toMatchObject({ error: { code: 'email_suppressed' } })
    const stored = await env.ACCOUNT_DB.prepare(
      'SELECT delivery_status FROM auth_challenges WHERE id = ?'
    ).bind(challenge.challengeId).first<{ delivery_status: string }>()
    expect(stored?.delivery_status).toBe('email.bounced')
  })

  it('lets the owning Mac bind Relay, inspect pending iPhone requests, and deliver an opaque grant', async () => {
    const { payload } = await signIn('enrollment@example.com')
    const accessToken = payload.session.accessToken as string
    const syncSpaceId = payload.device.syncSpaceId as string
    const iosDeviceId = crypto.randomUUID()
    const enrollmentId = crypto.randomUUID()
    const now = new Date()
    const future = new Date(now.getTime() + 10 * 60_000).toISOString()
    await env.ACCOUNT_DB.batch([
      env.ACCOUNT_DB.prepare(
        `INSERT INTO devices
          (id, user_id, platform, name, public_key, app_version, protocol_version, created_at, updated_at, last_seen_at)
         VALUES (?, ?, 'ios', '测试 iPhone', ?, '0.0.3', 1, ?, ?, ?)`
      ).bind(iosDeviceId, payload.user.id, 'ios-public-key-material', now.toISOString(), now.toISOString(), now.toISOString()),
      env.ACCOUNT_DB.prepare(
        `INSERT INTO device_grants
          (id, space_id, device_id, requested_by_user_id, status, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`
      ).bind(enrollmentId, syncSpaceId, iosDeviceId, payload.user.id, now.toISOString(), now.toISOString(), future)
    ])

    const binding = await SELF.fetch(`https://account.test/v1/sync-spaces/${syncSpaceId}/relay-binding`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        relayUrl: 'https://fuddy.ai/api/relay/',
        relayAccountId: 'relay-account-1',
        bindingProof: 'test-binding-proof-enrollment'
      })
    })
    expect(binding.status).toBe(200)
    await expect(binding.json()).resolves.toMatchObject({
      syncSpace: { relayBound: true, relayUrl: 'https://fuddy.ai/api/relay', relayAccountId: 'relay-account-1' }
    })

    const pending = await SELF.fetch(`https://account.test/v1/sync-spaces/${syncSpaceId}/enrollments`, {
      headers: { authorization: `Bearer ${accessToken}` }
    })
    expect(pending.status).toBe(200)
    await expect(pending.json()).resolves.toMatchObject({
      syncSpace: { id: syncSpaceId, relayAccountId: 'relay-account-1' },
      enrollments: [{ id: enrollmentId, deviceId: iosDeviceId, deviceName: '测试 iPhone' }]
    })

    const complete = await SELF.fetch(
      `https://account.test/v1/sync-spaces/${syncSpaceId}/enrollments/${enrollmentId}/complete`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ wrappedSpaceKey: 'opaque-wrapped-device-grant', keyVersion: 1 })
      }
    )
    expect(complete.status).toBe(200)
    const stored = await env.ACCOUNT_DB.prepare(
      'SELECT status, wrapped_space_key FROM device_grants WHERE id = ?'
    ).bind(enrollmentId).first<{ status: string; wrapped_space_key: string }>()
    expect(stored).toEqual({ status: 'active', wrapped_space_key: 'opaque-wrapped-device-grant' })

    const revoke = await SELF.fetch(`https://account.test/v1/devices/${iosDeviceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}` }
    })
    expect(revoke.status).toBe(204)
    await expect(activatePendingEnrollment(env, {
      enrollmentId,
      spaceId: syncSpaceId,
      wrappedSpaceKey: 'must-not-reactivate',
      keyVersion: 1
    })).resolves.toBe(false)
    await expect(env.ACCOUNT_DB.prepare(
      'SELECT status, wrapped_space_key FROM device_grants WHERE id = ?'
    ).bind(enrollmentId).first()).resolves.toEqual({
      status: 'revoked',
      wrapped_space_key: 'opaque-wrapped-device-grant'
    })
    const revocations = await SELF.fetch(`https://account.test/v1/sync-spaces/${syncSpaceId}/enrollments`, {
      headers: { authorization: `Bearer ${accessToken}` }
    })
    await expect(revocations.json()).resolves.toMatchObject({
      revocations: [{ id: enrollmentId, deviceId: iosDeviceId }]
    })
    const acknowledged = await SELF.fetch(
      `https://account.test/v1/sync-spaces/${syncSpaceId}/enrollments/${enrollmentId}/revocation-complete`,
      { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } }
    )
    expect(acknowledged.status).toBe(204)
  })

  it('requeues Relay revocation when a token is installed after the grant was revoked', async () => {
    const { payload } = await signIn('late-relay-install@example.com')
    const accessToken = payload.session.accessToken as string
    const syncSpaceId = payload.device.syncSpaceId as string
    const iosDeviceId = crypto.randomUUID()
    const enrollmentId = crypto.randomUUID()
    const relayAccountId = 'relay-account-late-install'
    const now = new Date().toISOString()
    await env.ACCOUNT_DB.batch([
      env.ACCOUNT_DB.prepare(
        'UPDATE sync_spaces SET relay_url = ?, relay_account_id = ?, relay_bound_at = ?, updated_at = ? WHERE id = ?'
      ).bind('https://fuddy.ai/api/relay', relayAccountId, now, now, syncSpaceId),
      env.ACCOUNT_DB.prepare(
        `INSERT INTO devices
          (id, user_id, platform, name, public_key, app_version, protocol_version, created_at, updated_at, last_seen_at)
         VALUES (?, ?, 'ios', '竞态 iPhone', 'race-public-key', '0.0.3', 1, ?, ?, ?)`
      ).bind(iosDeviceId, payload.user.id, now, now, now),
      env.ACCOUNT_DB.prepare(
        `INSERT INTO device_grants
          (id, space_id, device_id, requested_by_user_id, status, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`
      ).bind(
        enrollmentId,
        syncSpaceId,
        iosDeviceId,
        payload.user.id,
        now,
        now,
        new Date(Date.now() + 10 * 60_000).toISOString()
      )
    ])

    const revoked = await SELF.fetch(`https://account.test/v1/devices/${iosDeviceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}` }
    })
    expect(revoked.status).toBe(204)
    const relayAdmin = {
      revokeDevice: vi.fn(async () => true),
      claimAccountBinding: vi.fn(async () => true),
      confirmAccountBinding: vi.fn(async () => true),
      releaseAccountBinding: vi.fn(async () => true),
      setAccountGeneration: vi.fn(async () => true),
      revokeAccount: vi.fn(async () => true)
    } satisfies RelayAdministrationBinding
    await expect(processRelayRevocationJobs(env, {
      relayAdmin,
      now: new Date('2030-01-01T00:00:00.000Z')
    })).resolves.toEqual({ attempted: 1, completed: 1 })
    await expect(env.ACCOUNT_DB.prepare(
      'SELECT relay_revoked_at AS relayRevokedAt FROM device_grants WHERE id = ?'
    ).bind(enrollmentId).first<{ relayRevokedAt: string | null }>()).resolves.toMatchObject({
      relayRevokedAt: expect.any(String)
    })

    const rejectedActivation = await SELF.fetch(
      `https://account.test/v1/sync-spaces/${syncSpaceId}/enrollments/${enrollmentId}/complete`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ wrappedSpaceKey: 'late-installed-token', keyVersion: 1 })
      }
    )
    expect(rejectedActivation.status).toBe(409)
    await expect(rejectedActivation.json()).resolves.toMatchObject({
      error: { code: 'enrollment_not_pending' }
    })
    await expect(env.ACCOUNT_DB.prepare(
      `SELECT g.relay_revoked_at AS relayRevokedAt, j.status
       FROM device_grants g JOIN relay_revocation_jobs j ON j.source_id = g.id
       WHERE g.id = ?`
    ).bind(enrollmentId).first()).resolves.toEqual({ relayRevokedAt: null, status: 'pending' })

    await expect(processRelayRevocationJobs(env, {
      relayAdmin,
      now: new Date('2031-01-01T00:00:00.000Z')
    })).resolves.toEqual({ attempted: 1, completed: 1 })
    expect(relayAdmin.revokeDevice).toHaveBeenCalledTimes(2)
    expect(relayAdmin.revokeDevice).toHaveBeenLastCalledWith(relayAccountId, iosDeviceId, enrollmentId)
  })

  it('keeps a revoked device generation until its old Relay token is removed', async () => {
    const email = 'reenrollment-revocation@example.com'
    const mac = await signIn(email)
    const accessToken = mac.payload.session.accessToken as string
    const syncSpaceId = mac.payload.device.syncSpaceId as string
    const relayAccountId = 'relay-account-reenrollment'
    const iosInstallation = {
      ...device,
      id: crypto.randomUUID(),
      platform: 'ios' as const,
      name: '待重新连接的 iPhone',
      publicKey: 'reenrollment-public-key'
    }
    await env.ACCOUNT_DB.prepare('DELETE FROM auth_email_cooldowns WHERE email = ?').bind(email).run()
    const phone = await signIn(email, iosInstallation)
    const iosDeviceId = phone.payload.device.id as string
    const oldGrantId = crypto.randomUUID()
    const now = new Date().toISOString()

    const binding = await SELF.fetch(`https://account.test/v1/sync-spaces/${syncSpaceId}/relay-binding`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        relayUrl: 'https://fuddy.ai/api/relay',
        relayAccountId,
        bindingProof: 'test-binding-proof-reenrollment'
      })
    })
    expect(binding.status).toBe(200)
    await env.ACCOUNT_DB.prepare(
      `INSERT INTO device_grants
        (id, space_id, device_id, requested_by_user_id, status, wrapped_space_key, key_version,
         created_at, updated_at, expires_at, activated_at)
       VALUES (?, ?, ?, ?, 'active', 'old-wrapped-key', 1, ?, ?, ?, ?)`
    ).bind(
      oldGrantId,
      syncSpaceId,
      iosDeviceId,
      mac.payload.user.id,
      now,
      now,
      new Date(Date.now() + 10 * 60_000).toISOString(),
      now
    ).run()

    const revoked = await SELF.fetch(`https://account.test/v1/devices/${iosDeviceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}` }
    })
    expect(revoked.status).toBe(204)
    await env.ACCOUNT_DB.prepare('DELETE FROM auth_email_cooldowns WHERE email = ?').bind(email).run()
    const signedInAgain = await signIn(email, iosInstallation)
    expect(signedInAgain.verify.status).toBe(200)

    const blocked = await SELF.fetch(`https://account.test/v1/sync-spaces/${syncSpaceId}/enrollments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signedInAgain.payload.session.accessToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ deviceId: iosDeviceId })
    })
    expect(blocked.status).toBe(409)
    await expect(blocked.json()).resolves.toMatchObject({ error: { code: 'relay_revocation_pending' } })
    await expect(env.ACCOUNT_DB.prepare(
      `SELECT id, status, relay_revoked_at AS relayRevokedAt
       FROM device_grants WHERE space_id = ? AND device_id = ?`
    ).bind(syncSpaceId, iosDeviceId).first()).resolves.toEqual({
      id: oldGrantId,
      status: 'revoked',
      relayRevokedAt: null
    })

    const relayAdmin = {
      revokeDevice: vi.fn(async () => true),
      claimAccountBinding: vi.fn(async () => true),
      confirmAccountBinding: vi.fn(async () => true),
      releaseAccountBinding: vi.fn(async () => true),
      setAccountGeneration: vi.fn(async () => true),
      revokeAccount: vi.fn(async () => true)
    } satisfies RelayAdministrationBinding
    await expect(processRelayRevocationJobs(env, {
      relayAdmin,
      now: new Date('2030-01-01T00:00:00.000Z')
    })).resolves.toEqual({ attempted: 1, completed: 1 })
    expect(relayAdmin.revokeDevice).toHaveBeenCalledWith(relayAccountId, iosDeviceId, oldGrantId)

    const allowed = await SELF.fetch(`https://account.test/v1/sync-spaces/${syncSpaceId}/enrollments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signedInAgain.payload.session.accessToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ deviceId: iosDeviceId })
    })
    expect(allowed.status).toBe(201)
    const allowedPayload = await allowed.json<{ enrollment: { id: string } }>()
    expect(allowedPayload.enrollment.id).not.toBe(oldGrantId)
    await expect(env.ACCOUNT_DB.prepare(
      'SELECT id, status FROM device_grants WHERE space_id = ? AND device_id = ?'
    ).bind(syncSpaceId, iosDeviceId).first()).resolves.toEqual({
      id: allowedPayload.enrollment.id,
      status: 'pending'
    })
  })
})
