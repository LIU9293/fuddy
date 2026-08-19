import { SELF, env } from 'cloudflare:test'
import { Webhook } from 'svix'
import { describe, expect, it } from 'vitest'
import { linkVerifiedGoogleIdentity, parseResendErrorDetails } from '../src/index'
import type { DeviceInput } from '../src/types'

const device: DeviceInput = {
  platform: 'macos',
  name: '测试 Mac',
  publicKey: 'test-public-key-material',
  appVersion: '0.0.3',
  protocolVersion: 1
}

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
    const leftStart = await post('/v1/auth/email/start', { email })
    const left = await leftStart.json<{ challengeId: string; debugCode: string }>()
    await env.ACCOUNT_DB.prepare(
      `UPDATE auth_challenges SET created_at = datetime('now', '-2 minutes') WHERE id = ?`
    ).bind(left.challengeId).run()
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
    const now = new Date().toISOString()
    await env.ACCOUNT_DB.batch([
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
  })

  it('lists the current device separately from other signed-in devices', async () => {
    const first = await signIn('devices@example.com', { ...device, id: crypto.randomUUID() })
    await env.ACCOUNT_DB.prepare(
      `UPDATE auth_challenges SET created_at = datetime('now', '-2 minutes') WHERE email = ?`
    ).bind('devices@example.com').run()
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
      body: JSON.stringify({ relayUrl: 'https://fuddy.ai/api/relay/', relayAccountId: 'relay-account-1' })
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
})
