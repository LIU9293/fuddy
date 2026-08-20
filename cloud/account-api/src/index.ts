import { createRemoteJWKSet, jwtVerify } from 'jose'
import { Webhook } from 'svix'
import { z } from 'zod'
import type { RelayAdministrationBinding } from '../../relay/src/administration-contract'
import { defaultCompanionRelayUrl } from '../../../src/shared/companion-sync'
import { addSeconds, hmac, isoNow, randomCode, randomToken, secretsEqual } from './crypto'
import {
  completeEnrollmentSchema,
  enrollmentSchema,
  googleIdentitySchema,
  googleSignInSchema,
  relayBindingSchema,
  refreshSchema,
  resendWebhookSchema,
  startEmailSchema,
  verifyEmailSchema
} from './schemas'
import type { AuthenticatedUser, DeviceInput, Environment } from './types'

const ACCESS_SECONDS = 15 * 60
const REFRESH_SECONDS = 30 * 24 * 60 * 60
const ABSOLUTE_SESSION_SECONDS = 90 * 24 * 60 * 60
const OTP_SECONDS = 10 * 60
const OTP_MAX_ATTEMPTS = 5
const OTP_RESEND_SECONDS = 60
const RELAY_BINDING_ATTEMPT_SECONDS = 5 * 60
const MAX_JSON_BODY_BYTES = 64 * 1024
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))
export const maximumActiveDevicesPerUser = 20
export const maximumActiveMacHostsPerUser = 5
export const maximumActiveSessionsPerDevice = 10
const ACCOUNT_PRUNE_BATCH_SIZE = 500

export function relayBindingUsesManagedAuthority(relayUrl: string, environment: string): boolean {
  if (environment !== 'production') return true
  const url = new URL(relayUrl)
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '')
  return `${url.origin}${pathname}` === defaultCompanionRelayUrl
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message)
  }
}

type SessionRecord = {
  id: string
  family_id: string
  user_id: string
  device_id: string
  access_expires_at: string
  refresh_expires_at: string
  absolute_expires_at: string
  revoked_at: string | null
}

type IdentityRecord = {
  user_id: string
  primary_email: string
  display_name: string | null
}

export type VerifiedGoogleIdentity = {
  subject: string
  email: string
  displayName: string | null
}

export type GoogleAuthorizationCodeExchangeInput = {
  authorizationCode: string
  clientId: string
  codeVerifier: string
  redirectUri: string
}

type GoogleCredential = z.infer<typeof googleIdentitySchema>

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  headers.set('cache-control', 'no-store')
  return new Response(JSON.stringify(value), { ...init, headers })
}

async function readLimitedText(message: Request | Response, maximumBytes: number): Promise<string> {
  const contentLength = Number(message.headers.get('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) throw new Error('body_too_large')
  if (!message.body) return ''
  const reader = message.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maximumBytes) {
      await reader.cancel()
      throw new Error('body_too_large')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function bodyJson(request: Request): Promise<unknown> {
  let raw: string
  try {
    raw = await readLimitedText(request, MAX_JSON_BODY_BYTES)
  } catch {
    throw new ApiError(413, 'request_too_large', '请求内容过大。')
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new ApiError(400, 'invalid_json', '请求内容不是有效的 JSON。')
  }
}

export function parseResendErrorDetails(raw: string): { name: string | null; message: string | null } | null {
  if (!raw) return null
  try {
    const parsed = z.object({
      name: z.string().trim().min(1).max(100).optional(),
      message: z.string().trim().min(1).max(500).optional()
    }).safeParse(JSON.parse(raw) as unknown)
    if (!parsed.success) return null
    if (!parsed.data.name && !parsed.data.message) return null
    return {
      name: parsed.data.name ?? null,
      message: parsed.data.message ?? null
    }
  } catch {
    return null
  }
}

function pathParts(request: Request): string[] {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean)
  return parts[0] === 'api' && parts[1] === 'account' ? parts.slice(2) : parts
}

function requireConfiguration(env: Environment): void {
  if (!env.OTP_PEPPER || !env.SESSION_TOKEN_PEPPER) {
    throw new ApiError(503, 'service_not_configured', '登录暂时不可用，请稍后重试。')
  }
}

async function rateLimit(env: Environment, rawKey: string, limit: number, now: Date): Promise<void> {
  const keyHash = await hmac(rawKey, env.OTP_PEPPER)
  const windowStart = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000).toISOString()
  const row = await env.ACCOUNT_DB.prepare(
    `INSERT INTO auth_rate_limits (key_hash, window_start, count, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(key_hash, window_start)
     DO UPDATE SET count = count + 1, updated_at = excluded.updated_at
     RETURNING count`
  )
    .bind(keyHash, windowStart, isoNow(now))
    .first<{ count: number }>()
  if ((row?.count ?? limit + 1) > limit) {
    throw new ApiError(429, 'rate_limited', '请求过于频繁，请稍后再试。')
  }
}

async function sendEmailCode(env: Environment, to: string, code: string, challengeId: string): Promise<string | null> {
  if (env.EMAIL_DELIVERY_MODE === 'test' && env.ENVIRONMENT !== 'production') return null
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) {
    throw new ApiError(503, 'email_not_configured', '验证码暂时无法发送，请稍后重试。')
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
      'idempotency-key': `fuddy-login-${challengeId}`
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: [to],
      subject: `${code} 是你的 Fuddy 登录验证码`,
      text: `你的 Fuddy 验证码是 ${code}，10 分钟内有效。若非本人操作，请忽略这封邮件。`
    })
  })
  let raw: string
  try {
    raw = await readLimitedText(response, 32 * 1024)
  } catch {
    throw new ApiError(502, 'email_delivery_failed', '验证码暂时无法发送，请稍后重试。')
  }
  if (!response.ok) {
    const details = parseResendErrorDetails(raw)
    console.error('Resend rejected login email', {
      status: response.status,
      name: details?.name ?? null,
      message: details?.message ?? null,
      challengeId
    })
    throw new ApiError(502, 'email_delivery_failed', '验证码暂时无法发送，请稍后重试。')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(raw) as unknown
  } catch {
    throw new ApiError(502, 'email_delivery_failed', '验证码暂时无法发送，请稍后重试。')
  }
  const payload = z.object({ id: z.string().trim().min(1).max(200) }).safeParse(decoded)
  if (!payload.success) throw new ApiError(502, 'email_delivery_failed', '验证码暂时无法发送，请稍后重试。')
  return payload.data.id
}

async function upsertDevice(
  env: Environment,
  userId: string,
  input: DeviceInput,
  now: Date
): Promise<{ id: string; hostId: string | null; syncSpaceId: string | null }> {
  const installationId = input.id ?? crypto.randomUUID()
  const timestamp = isoNow(now)
  const device = await env.ACCOUNT_DB.prepare(
    `INSERT INTO devices
       (id, user_id, installation_id, platform, name, public_key, app_version, protocol_version, created_at, updated_at, last_seen_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM devices
       WHERE user_id = ? AND installation_id = ? AND platform = ? AND revoked_at IS NULL
     ) OR (
       (SELECT COUNT(*) FROM devices WHERE user_id = ? AND revoked_at IS NULL) < ?
       AND (
         ? != 'macos' OR
         (SELECT COUNT(*) FROM devices WHERE user_id = ? AND platform = 'macos' AND revoked_at IS NULL) < ?
       )
     )
     ON CONFLICT(user_id, installation_id) DO UPDATE SET
       name = excluded.name,
       public_key = excluded.public_key,
       app_version = excluded.app_version,
       protocol_version = excluded.protocol_version,
       updated_at = excluded.updated_at,
       last_seen_at = excluded.last_seen_at,
       revoked_at = NULL
     WHERE devices.platform = excluded.platform
     RETURNING id`
  )
    .bind(
      crypto.randomUUID(),
      userId,
      installationId,
      input.platform,
      input.name,
      input.publicKey,
      input.appVersion,
      input.protocolVersion,
      timestamp,
      timestamp,
      timestamp,
      userId,
      installationId,
      input.platform,
      userId,
      maximumActiveDevicesPerUser,
      input.platform,
      userId,
      maximumActiveMacHostsPerUser
    )
    .first<{ id: string }>()
  if (!device) {
    const existingInstallation = await env.ACCOUNT_DB.prepare(
      `SELECT platform FROM devices WHERE user_id = ? AND installation_id = ?`
    ).bind(userId, installationId).first<{ platform: string }>()
    if (existingInstallation && existingInstallation.platform !== input.platform) {
      throw new ApiError(409, 'device_platform_mismatch', '这台设备的系统类型与首次注册时不一致。')
    }
    const active = await env.ACCOUNT_DB.prepare(
      `SELECT COUNT(*) AS devices,
              SUM(CASE WHEN platform = 'macos' THEN 1 ELSE 0 END) AS macs
       FROM devices WHERE user_id = ? AND revoked_at IS NULL`
    ).bind(userId).first<{ devices: number; macs: number | null }>()
    if ((active?.devices ?? 0) >= maximumActiveDevicesPerUser) {
      throw new ApiError(409, 'device_limit_reached', `每个账户最多保留 ${maximumActiveDevicesPerUser} 台活跃设备。`)
    }
    if (input.platform === 'macos' && (active?.macs ?? 0) >= maximumActiveMacHostsPerUser) {
      throw new ApiError(409, 'mac_host_limit_reached', `每个账户最多保留 ${maximumActiveMacHostsPerUser} 台活跃 Mac。`)
    }
    throw new ApiError(500, 'device_registration_failed', '设备注册失败。')
  }
  const id = device.id

  if (input.platform !== 'macos') return { id, hostId: null, syncSpaceId: null }

  const current = await env.ACCOUNT_DB.prepare(
    `SELECT h.id AS host_id, s.id AS sync_space_id
     FROM hosts h LEFT JOIN sync_spaces s ON s.host_id = h.id AND s.revoked_at IS NULL
     WHERE h.device_id = ? AND h.revoked_at IS NULL`
  )
    .bind(id)
    .first<{ host_id: string; sync_space_id: string | null }>()
  if (current?.sync_space_id) return { id, hostId: current.host_id, syncSpaceId: current.sync_space_id }

  const host = await env.ACCOUNT_DB.prepare(
    `INSERT INTO hosts (id, user_id, device_id, name, created_at, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at,
       last_seen_at = excluded.last_seen_at, revoked_at = NULL
     RETURNING id`
  ).bind(crypto.randomUUID(), userId, id, input.name, timestamp, timestamp, timestamp).first<{ id: string }>()
  if (!host) throw new ApiError(500, 'host_registration_failed', 'Mac Host 注册失败。')
  const space = await env.ACCOUNT_DB.prepare(
    `INSERT INTO sync_spaces (id, owner_user_id, host_id, name, relay_account_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(host_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at, revoked_at = NULL
     RETURNING id`
  ).bind(
    crypto.randomUUID(),
    userId,
    host.id,
    `${input.name} 的工作空间`,
    crypto.randomUUID(),
    timestamp,
    timestamp
  ).first<{ id: string }>()
  if (!space) throw new ApiError(500, 'sync_space_registration_failed', '同步空间注册失败。')
  await env.ACCOUNT_DB.prepare(
    `INSERT INTO space_memberships (space_id, user_id, role, created_at)
     VALUES (?, ?, 'owner', ?)
     ON CONFLICT(space_id, user_id) DO UPDATE SET role = 'owner', revoked_at = NULL`
  ).bind(space.id, userId, timestamp).run()
  const hostId = host.id
  const syncSpaceId = space.id
  return { id, hostId, syncSpaceId }
}

async function createSession(
  env: Environment,
  user: { id: string; email: string; displayName: string | null },
  device: DeviceInput,
  now: Date,
  provider: 'email' | 'google'
): Promise<Record<string, unknown>> {
  const deviceRecord = await upsertDevice(env, user.id, device, now)
  if (device.platform === 'macos' && deviceRecord.syncSpaceId) {
    await reactivateRelayAccountIfNeeded(env, deviceRecord.syncSpaceId)
  }
  const sessionId = crypto.randomUUID()
  const familyId = crypto.randomUUID()
  const accessToken = randomToken('fat')
  const refreshToken = randomToken('frt')
  const timestamp = isoNow(now)
  const accessExpiresAt = addSeconds(now, ACCESS_SECONDS).toISOString()
  const refreshExpiresAt = addSeconds(now, REFRESH_SECONDS).toISOString()
  const absoluteExpiresAt = addSeconds(now, ABSOLUTE_SESSION_SECONDS).toISOString()
  await env.ACCOUNT_DB.batch([
    env.ACCOUNT_DB.prepare(
      `UPDATE auth_sessions SET revoked_at = ?, updated_at = ?
       WHERE id IN (
         SELECT id FROM auth_sessions
         WHERE device_id = ? AND revoked_at IS NULL
         ORDER BY updated_at DESC LIMIT -1 OFFSET ?
       )`
    ).bind(timestamp, timestamp, deviceRecord.id, maximumActiveSessionsPerDevice - 1),
    env.ACCOUNT_DB.prepare(
      `INSERT INTO auth_sessions
         (id, family_id, user_id, device_id, access_hash, current_refresh_hash, access_expires_at, refresh_expires_at,
          absolute_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      sessionId,
      familyId,
      user.id,
      deviceRecord.id,
      await hmac(accessToken, env.SESSION_TOKEN_PEPPER),
      await hmac(refreshToken, env.SESSION_TOKEN_PEPPER),
      accessExpiresAt,
      refreshExpiresAt,
      absoluteExpiresAt,
      timestamp,
      timestamp
    ),
    env.ACCOUNT_DB.prepare(
      `INSERT INTO security_events (id, user_id, device_id, event_type, metadata_json, created_at)
       VALUES (?, ?, ?, 'auth.signed_in', ?, ?)`
    ).bind(crypto.randomUUID(), user.id, deviceRecord.id, JSON.stringify({ provider }), timestamp)
  ])
  return {
    user: { id: user.id, email: user.email, displayName: user.displayName },
    device: {
      id: deviceRecord.id,
      platform: device.platform,
      name: device.name,
      hostId: deviceRecord.hostId,
      syncSpaceId: deviceRecord.syncSpaceId
    },
    session: { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt }
  }
}

async function authenticate(request: Request, env: Environment): Promise<AuthenticatedUser> {
  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) throw new ApiError(401, 'unauthorized', '请先登录。')
  const accessHash = await hmac(authorization.slice(7), env.SESSION_TOKEN_PEPPER)
  const row = await env.ACCOUNT_DB.prepare(
    `SELECT s.id AS session_id, s.user_id, s.device_id, s.access_expires_at, s.revoked_at,
            u.primary_email, u.display_name, u.disabled_at, d.revoked_at AS device_revoked_at
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     JOIN devices d ON d.id = s.device_id
     WHERE s.access_hash = ?`
  )
    .bind(accessHash)
    .first<{
      session_id: string
      user_id: string
      device_id: string
      access_expires_at: string
      revoked_at: string | null
      primary_email: string
      display_name: string | null
      disabled_at: string | null
      device_revoked_at: string | null
    }>()
  if (
    !row ||
    row.revoked_at ||
    row.disabled_at ||
    row.device_revoked_at ||
    new Date(row.access_expires_at).getTime() <= Date.now()
  ) {
    throw new ApiError(401, 'session_expired', '登录状态已过期，请重新登录。')
  }
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    deviceId: row.device_id,
    email: row.primary_email,
    displayName: row.display_name
  }
}

async function startEmail(request: Request, env: Environment): Promise<Response> {
  const { email } = startEmailSchema.parse(await bodyJson(request))
  const now = new Date()
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  await Promise.all([
    rateLimit(env, `otp-email:${email}`, 10, now),
    rateLimit(env, `otp-ip:${ip}`, 30, now)
  ])
  const emailHash = await hmac(`email-suppression:${email}`, env.OTP_PEPPER)
  const suppression = await env.ACCOUNT_DB.prepare(
    'SELECT reason FROM email_suppressions WHERE email_hash = ?'
  ).bind(emailHash).first<{ reason: string }>()
  if (suppression) {
    throw new ApiError(422, 'email_suppressed', '这个邮箱暂时无法接收验证码，请更换邮箱或联系支持。')
  }
  const challengeId = crypto.randomUUID()
  const timestamp = isoNow(now)
  const availableAt = addSeconds(now, OTP_RESEND_SECONDS).toISOString()
  const reservation = await env.ACCOUNT_DB.prepare(
    `INSERT INTO auth_email_cooldowns (email, challenge_id, available_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET challenge_id = excluded.challenge_id,
       available_at = excluded.available_at, updated_at = excluded.updated_at
     WHERE auth_email_cooldowns.available_at <= ?
     RETURNING available_at`
  ).bind(email, challengeId, availableAt, timestamp, timestamp).first<{ available_at: string }>()
  if (!reservation) {
    const cooldown = await env.ACCOUNT_DB.prepare(
      'SELECT available_at FROM auth_email_cooldowns WHERE email = ?'
    ).bind(email).first<{ available_at: string }>()
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(((cooldown ? new Date(cooldown.available_at).getTime() : now.getTime()) - now.getTime()) / 1_000)
    )
    throw new ApiError(429, 'otp_cooldown', '验证码刚刚已经发送，请稍后重试。', {
      retryAfterSeconds
    })
  }
  const code = randomCode()
  const expiresAt = addSeconds(now, OTP_SECONDS).toISOString()
  try {
    await env.ACCOUNT_DB.prepare(
      `INSERT INTO auth_challenges (id, email, code_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(challengeId, email, await hmac(`${challengeId}:${code}`, env.OTP_PEPPER), expiresAt, timestamp)
      .run()
    const resendEmailId = await sendEmailCode(env, email, code, challengeId)
    const deliveryStatus = resendEmailId ? 'sent' : 'test'
    await env.ACCOUNT_DB.prepare(
      `UPDATE auth_challenges
       SET resend_email_id = ?, delivery_status = ?, delivery_updated_at = ?
       WHERE id = ?`
    ).bind(resendEmailId, deliveryStatus, isoNow(now), challengeId).run()
  } catch (error) {
    await env.ACCOUNT_DB.batch([
      env.ACCOUNT_DB.prepare('DELETE FROM auth_challenges WHERE id = ?').bind(challengeId),
      env.ACCOUNT_DB.prepare(
        'DELETE FROM auth_email_cooldowns WHERE email = ? AND challenge_id = ?'
      ).bind(email, challengeId)
    ])
    throw error
  }
  return json(
    {
      challengeId,
      expiresAt,
      retryAfterSeconds: OTP_RESEND_SECONDS,
      ...(env.EMAIL_DELIVERY_MODE === 'test' && env.ENVIRONMENT !== 'production' ? { debugCode: code } : {})
    },
    { status: 202 }
  )
}

async function verifyEmail(request: Request, env: Environment): Promise<Response> {
  const input = verifyEmailSchema.parse(await bodyJson(request))
  const now = new Date()
  const timestamp = isoNow(now)
  const challenge = await env.ACCOUNT_DB.prepare(
    `UPDATE auth_challenges SET attempt_count = attempt_count + 1
     WHERE id = ? AND consumed_at IS NULL AND expires_at > ? AND attempt_count < ?
     RETURNING email, code_hash`
  )
    .bind(input.challengeId, timestamp, OTP_MAX_ATTEMPTS)
    .first<{
      email: string
      code_hash: string
    }>()
  if (!challenge) {
    const unavailable = await env.ACCOUNT_DB.prepare(
      'SELECT attempt_count FROM auth_challenges WHERE id = ? AND consumed_at IS NULL AND expires_at > ?'
    ).bind(input.challengeId, timestamp).first<{ attempt_count: number }>()
    if ((unavailable?.attempt_count ?? 0) >= OTP_MAX_ATTEMPTS) {
      throw new ApiError(429, 'otp_attempts_exhausted', '验证码尝试次数过多，请重新获取。')
    }
    throw new ApiError(400, 'otp_expired', '验证码已失效，请重新获取。')
  }
  const suppliedHash = await hmac(`${input.challengeId}:${input.code}`, env.OTP_PEPPER)
  if (!secretsEqual(suppliedHash, challenge.code_hash)) {
    throw new ApiError(400, 'otp_invalid', '验证码不正确。')
  }

  const consumed = await env.ACCOUNT_DB.prepare(
    `UPDATE auth_challenges SET consumed_at = ?
     WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
     RETURNING id`
  )
    .bind(timestamp, input.challengeId, timestamp)
    .first<{ id: string }>()
  if (!consumed) throw new ApiError(400, 'otp_expired', '验证码已失效，请重新获取。')
  let identity = await env.ACCOUNT_DB.prepare(
    `SELECT i.user_id, u.primary_email, u.display_name
     FROM auth_identities i JOIN users u ON u.id = i.user_id
     WHERE i.provider = 'email' AND i.provider_subject = ?`
  )
    .bind(challenge.email)
    .first<IdentityRecord>()
  if (!identity) {
    const existingUser = await env.ACCOUNT_DB.prepare('SELECT id, primary_email, display_name FROM users WHERE primary_email = ?')
      .bind(challenge.email)
      .first<{ id: string; primary_email: string; display_name: string | null }>()
    const userId = existingUser?.id ?? crypto.randomUUID()
    const statements: D1PreparedStatement[] = []
    if (!existingUser) {
      statements.push(
        env.ACCOUNT_DB.prepare(
          'INSERT INTO users (id, primary_email, created_at, updated_at) VALUES (?, ?, ?, ?)'
        ).bind(userId, challenge.email, timestamp, timestamp)
      )
    }
    statements.push(
      env.ACCOUNT_DB.prepare(
        `INSERT INTO auth_identities (id, user_id, provider, provider_subject, email, created_at, last_used_at)
         VALUES (?, ?, 'email', ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), userId, challenge.email, challenge.email, timestamp, timestamp)
    )
    await env.ACCOUNT_DB.batch(statements)
    identity = {
      user_id: userId,
      primary_email: challenge.email,
      display_name: existingUser?.display_name ?? null
    }
  }
  await env.ACCOUNT_DB.prepare(
    `UPDATE auth_identities SET last_used_at = ?
     WHERE provider = 'email' AND provider_subject = ?`
  ).bind(timestamp, challenge.email).run()
  return json(
    await createSession(
      env,
      { id: identity.user_id, email: identity.primary_email, displayName: identity.display_name },
      input.device,
      now,
      'email'
    )
  )
}

async function verifyGoogleIdentity(env: Environment, idToken: string): Promise<VerifiedGoogleIdentity> {
  const audiences = env.GOOGLE_CLIENT_IDS.split(',').map((value) => value.trim()).filter(Boolean)
  if (audiences.length === 0) throw new ApiError(503, 'google_not_configured', 'Google 登录暂时不可用，请使用邮箱继续。')
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
  try {
    ;({ payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: audiences
    }))
  } catch {
    throw new ApiError(401, 'google_token_invalid', 'Google 登录凭证无效或已过期。')
  }
  if (!payload.sub || typeof payload.email !== 'string' || payload.email_verified !== true) {
    throw new ApiError(401, 'google_email_unverified', 'Google 账户邮箱尚未验证。')
  }
  return {
    subject: payload.sub,
    email: payload.email.trim().toLowerCase(),
    displayName: typeof payload.name === 'string' ? payload.name.slice(0, 100) : null
  }
}

export async function exchangeGoogleAuthorizationCode(
  input: GoogleAuthorizationCodeExchangeInput,
  clientSecret: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<string> {
  let response: Response
  try {
    response = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: clientSecret,
        code: input.authorizationCode,
        code_verifier: input.codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: input.redirectUri
      }),
      signal: AbortSignal.timeout(10_000)
    })
  } catch {
    throw new ApiError(503, 'google_exchange_unavailable', 'Google 登录服务暂时不可用，请重试。')
  }

  if (!response.ok) {
    let upstreamCode = ''
    try {
      const payload = await response.json() as { error?: unknown }
      if (typeof payload.error === 'string' && /^[a-z0-9_.-]{1,80}$/iu.test(payload.error)) {
        upstreamCode = payload.error
      }
    } catch {
      // The response body may be non-JSON; do not surface arbitrary upstream content.
    }
    if (upstreamCode === 'invalid_client') {
      throw new ApiError(503, 'google_client_invalid', 'Google 登录服务配置无效，请稍后重试。')
    }
    throw new ApiError(401, 'google_code_invalid', 'Google 登录授权无效或已过期，请重新登录。')
  }

  const payload = await response.json() as { id_token?: unknown }
  if (typeof payload.id_token !== 'string' || payload.id_token.length < 20) {
    throw new ApiError(502, 'google_token_missing', 'Google 没有返回可验证的登录凭证。')
  }
  return payload.id_token
}

async function resolveGoogleIdentity(env: Environment, credential: GoogleCredential): Promise<VerifiedGoogleIdentity> {
  if ('idToken' in credential) return verifyGoogleIdentity(env, credential.idToken)
  const audiences = env.GOOGLE_CLIENT_IDS.split(',').map((value) => value.trim()).filter(Boolean)
  if (!audiences.includes(credential.clientId)) {
    throw new ApiError(400, 'google_client_not_allowed', 'Google OAuth 客户端不受支持。')
  }
  if (!env.GOOGLE_CLIENT_SECRET) {
    throw new ApiError(503, 'google_exchange_not_configured', 'Google 登录暂时不可用，请使用邮箱继续。')
  }
  const idToken = await exchangeGoogleAuthorizationCode(credential, env.GOOGLE_CLIENT_SECRET)
  return verifyGoogleIdentity(env, idToken)
}

export async function linkVerifiedGoogleIdentity(
  env: Environment,
  user: Pick<AuthenticatedUser, 'userId' | 'deviceId'>,
  google: VerifiedGoogleIdentity,
  now = new Date()
): Promise<void> {
  const existingSubject = await env.ACCOUNT_DB.prepare(
    `SELECT user_id FROM auth_identities
     WHERE provider = 'google' AND provider_subject = ?`
  ).bind(google.subject).first<{ user_id: string }>()
  if (existingSubject && existingSubject.user_id !== user.userId) {
    throw new ApiError(409, 'identity_already_linked', '这个 Google 账户已经连接到另一个 Fuddy 账户。')
  }
  if (existingSubject) {
    await env.ACCOUNT_DB.prepare(
      `UPDATE auth_identities SET last_used_at = ?
       WHERE provider = 'google' AND provider_subject = ?`
    ).bind(isoNow(now), google.subject).run()
    return
  }
  const existingGoogle = await env.ACCOUNT_DB.prepare(
    `SELECT provider_subject FROM auth_identities
     WHERE user_id = ? AND provider = 'google'`
  ).bind(user.userId).first<{ provider_subject: string }>()
  if (existingGoogle) {
    throw new ApiError(409, 'google_identity_exists', '这个 Fuddy 账户已经连接了另一个 Google 账户。')
  }
  const timestamp = isoNow(now)
  await env.ACCOUNT_DB.batch([
    env.ACCOUNT_DB.prepare(
      `INSERT INTO auth_identities (id, user_id, provider, provider_subject, email, created_at, last_used_at)
       VALUES (?, ?, 'google', ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), user.userId, google.subject, google.email, timestamp, timestamp),
    env.ACCOUNT_DB.prepare(
      `UPDATE users SET display_name = COALESCE(display_name, ?), updated_at = ? WHERE id = ?`
    ).bind(google.displayName, timestamp, user.userId),
    env.ACCOUNT_DB.prepare(
      `INSERT INTO security_events (id, user_id, device_id, event_type, metadata_json, created_at)
       VALUES (?, ?, ?, 'identity.google_linked', ?, ?)`
    ).bind(
      crypto.randomUUID(),
      user.userId,
      user.deviceId,
      JSON.stringify({ googleEmailMatchesPrimary: google.email === await primaryEmail(env, user.userId) }),
      timestamp
    )
  ])
}

async function primaryEmail(env: Environment, userId: string): Promise<string | null> {
  const row = await env.ACCOUNT_DB.prepare('SELECT primary_email FROM users WHERE id = ?')
    .bind(userId)
    .first<{ primary_email: string }>()
  return row?.primary_email ?? null
}

async function listIdentityRecords(env: Environment, userId: string): Promise<Array<{
  provider: string
  email: string
  createdAt: string
  lastUsedAt: string
}>> {
  const rows = await env.ACCOUNT_DB.prepare(
    `SELECT provider, email, created_at AS createdAt, last_used_at AS lastUsedAt
     FROM auth_identities WHERE user_id = ? ORDER BY created_at ASC`
  ).bind(userId).all<{
    provider: string
    email: string
    createdAt: string
    lastUsedAt: string
  }>()
  return rows.results
}

async function googleSignIn(request: Request, env: Environment): Promise<Response> {
  const input = googleSignInSchema.parse(await bodyJson(request))
  const now = new Date()
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  await rateLimit(env, `google-ip:${ip}`, 30, now)
  const google = await resolveGoogleIdentity(env, input)
  const timestamp = isoNow(now)
  let identity = await env.ACCOUNT_DB.prepare(
    `SELECT i.user_id, u.primary_email, u.display_name
     FROM auth_identities i JOIN users u ON u.id = i.user_id
     WHERE i.provider = 'google' AND i.provider_subject = ?`
  )
    .bind(google.subject)
    .first<IdentityRecord>()
  if (!identity) {
    const existing = await env.ACCOUNT_DB.prepare('SELECT id FROM users WHERE primary_email = ?')
      .bind(google.email)
      .first<{ id: string }>()
    if (existing) {
      throw new ApiError(409, 'identity_link_required', '请先用邮箱验证码登录，再在账户设置中连接 Google。')
    }
    const userId = crypto.randomUUID()
    await env.ACCOUNT_DB.batch([
      env.ACCOUNT_DB.prepare(
        'INSERT INTO users (id, primary_email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(userId, google.email, google.displayName, timestamp, timestamp),
      env.ACCOUNT_DB.prepare(
        `INSERT INTO auth_identities (id, user_id, provider, provider_subject, email, created_at, last_used_at)
         VALUES (?, ?, 'google', ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), userId, google.subject, google.email, timestamp, timestamp)
    ])
    identity = { user_id: userId, primary_email: google.email, display_name: google.displayName }
  }
  await env.ACCOUNT_DB.prepare(
    `UPDATE auth_identities SET last_used_at = ?
     WHERE provider = 'google' AND provider_subject = ?`
  ).bind(timestamp, google.subject).run()
  return json(
    await createSession(
      env,
      { id: identity.user_id, email: identity.primary_email, displayName: identity.display_name },
      input.device,
      new Date(),
      'google'
    )
  )
}

async function listIdentities(request: Request, env: Environment): Promise<Response> {
  const user = await authenticate(request, env)
  return json({ identities: await listIdentityRecords(env, user.userId) })
}

async function linkGoogle(request: Request, env: Environment): Promise<Response> {
  const user = await authenticate(request, env)
  const credential = googleIdentitySchema.parse(await bodyJson(request))
  await linkVerifiedGoogleIdentity(env, user, await resolveGoogleIdentity(env, credential))
  return json({ identities: await listIdentityRecords(env, user.userId) })
}

async function unlinkGoogle(request: Request, env: Environment): Promise<Response> {
  const user = await authenticate(request, env)
  const identities = await listIdentityRecords(env, user.userId)
  if (!identities.some((identity) => identity.provider === 'google')) {
    throw new ApiError(404, 'identity_not_found', '这个账户没有连接 Google。')
  }
  if (identities.length <= 1) {
    throw new ApiError(409, 'last_identity_required', '请先验证邮箱，再断开唯一的登录方式。')
  }
  const timestamp = isoNow()
  await env.ACCOUNT_DB.batch([
    env.ACCOUNT_DB.prepare(
      `DELETE FROM auth_identities WHERE user_id = ? AND provider = 'google'`
    ).bind(user.userId),
    env.ACCOUNT_DB.prepare(
      `INSERT INTO security_events (id, user_id, device_id, event_type, created_at)
       VALUES (?, ?, ?, 'identity.google_unlinked', ?)`
    ).bind(crypto.randomUUID(), user.userId, user.deviceId, timestamp)
  ])
  return json({ identities: await listIdentityRecords(env, user.userId) })
}

async function rejectReusedRefreshToken(
  env: Environment,
  tokenHash: string,
  now: Date
): Promise<void> {
  const reused = await env.ACCOUNT_DB.prepare(
    `SELECT h.family_id, h.user_id, h.device_id
     FROM auth_refresh_history h
     JOIN auth_sessions s ON s.id = h.session_id
     WHERE h.token_hash = ? AND s.revoked_at IS NULL`
  )
    .bind(tokenHash)
    .first<{ family_id: string; user_id: string; device_id: string }>()
  if (reused) {
    await env.ACCOUNT_DB.batch([
      env.ACCOUNT_DB.prepare('UPDATE auth_sessions SET revoked_at = ?, updated_at = ? WHERE family_id = ?')
        .bind(isoNow(now), isoNow(now), reused.family_id),
      env.ACCOUNT_DB.prepare(
        `INSERT INTO security_events (id, user_id, device_id, event_type, created_at)
         VALUES (?, ?, ?, 'auth.refresh_reuse_detected', ?)`
      ).bind(crypto.randomUUID(), reused.user_id, reused.device_id, isoNow(now))
    ])
    throw new ApiError(401, 'refresh_token_reused', '检测到重复使用的登录凭证，请重新登录。')
  }
}

async function refreshSession(request: Request, env: Environment): Promise<Response> {
  const { refreshToken } = refreshSchema.parse(await bodyJson(request))
  const now = new Date()
  const tokenHash = await hmac(refreshToken, env.SESSION_TOKEN_PEPPER)
  const session = await env.ACCOUNT_DB.prepare(
    `SELECT id, family_id, user_id, device_id, access_expires_at, refresh_expires_at, absolute_expires_at, revoked_at
     FROM auth_sessions WHERE current_refresh_hash = ?`
  )
    .bind(tokenHash)
    .first<SessionRecord>()
  if (
    !session ||
    session.revoked_at ||
    new Date(session.refresh_expires_at).getTime() <= now.getTime() ||
    new Date(session.absolute_expires_at).getTime() <= now.getTime()
  ) {
    if (!session) await rejectReusedRefreshToken(env, tokenHash, now)
    throw new ApiError(401, 'refresh_token_expired', '登录状态已过期，请重新登录。')
  }
  const accessToken = randomToken('fat')
  const nextRefreshToken = randomToken('frt')
  const accessExpiresAt = addSeconds(now, ACCESS_SECONDS).toISOString()
  const refreshExpiresAt = new Date(
    Math.min(addSeconds(now, REFRESH_SECONDS).getTime(), new Date(session.absolute_expires_at).getTime())
  ).toISOString()
  const [rotated] = await env.ACCOUNT_DB.batch([
    env.ACCOUNT_DB.prepare(
      `UPDATE auth_sessions SET access_hash = ?, previous_refresh_hash = current_refresh_hash,
         current_refresh_hash = ?, access_expires_at = ?, refresh_expires_at = ?, updated_at = ?
       WHERE id = ? AND current_refresh_hash = ? AND revoked_at IS NULL`
    ).bind(
      await hmac(accessToken, env.SESSION_TOKEN_PEPPER),
      await hmac(nextRefreshToken, env.SESSION_TOKEN_PEPPER),
      accessExpiresAt,
      refreshExpiresAt,
      isoNow(now),
      session.id,
      tokenHash
    ),
    env.ACCOUNT_DB.prepare(
      `INSERT INTO auth_refresh_history (token_hash, session_id, family_id, user_id, device_id, used_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(token_hash) DO NOTHING`
    ).bind(tokenHash, session.id, session.family_id, session.user_id, session.device_id, isoNow(now)),
    env.ACCOUNT_DB.prepare(
      'UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL'
    ).bind(isoNow(now), isoNow(now), session.device_id),
    env.ACCOUNT_DB.prepare(
      'UPDATE hosts SET last_seen_at = ?, updated_at = ? WHERE device_id = ? AND revoked_at IS NULL'
    ).bind(isoNow(now), isoNow(now), session.device_id)
  ])
  if ((rotated.meta.changes ?? 0) === 0) {
    await rejectReusedRefreshToken(env, tokenHash, now)
    throw new ApiError(401, 'refresh_token_expired', '登录状态已过期，请重新登录。')
  }
  return json({ session: { accessToken, refreshToken: nextRefreshToken, accessExpiresAt, refreshExpiresAt } })
}

async function listDevices(request: Request, env: Environment): Promise<Response> {
  const user = await authenticate(request, env)
  const rows = await env.ACCOUNT_DB.prepare(
    `SELECT id, platform, name, app_version AS appVersion, protocol_version AS protocolVersion,
            created_at AS createdAt, last_seen_at AS lastSeenAt,
            CASE WHEN id = ? THEN 1 ELSE 0 END AS isCurrent
     FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC`
  )
    .bind(user.deviceId, user.userId)
    .all()
  return json({ devices: rows.results })
}

async function listHosts(request: Request, env: Environment): Promise<Response> {
  const user = await authenticate(request, env)
  const rows = await env.ACCOUNT_DB.prepare(
    `SELECT h.id, h.device_id AS deviceId, h.name, h.last_seen_at AS lastSeenAt,
            s.id AS syncSpaceId, s.name AS syncSpaceName, s.key_version AS keyVersion
     FROM hosts h LEFT JOIN sync_spaces s ON s.host_id = h.id AND s.revoked_at IS NULL
     WHERE h.user_id = ? AND h.revoked_at IS NULL ORDER BY h.last_seen_at DESC`
  )
    .bind(user.userId)
    .all()
  return json({ hosts: rows.results })
}

async function listSyncSpaces(request: Request, env: Environment): Promise<Response> {
  const user = await authenticate(request, env)
  const rows = await env.ACCOUNT_DB.prepare(
    `SELECT s.id, s.host_id AS hostId, s.name, s.key_version AS keyVersion,
            CASE WHEN s.relay_url IS NOT NULL AND s.relay_bound_at IS NOT NULL THEN 1 ELSE 0 END AS relayBound,
            s.relay_url AS relayUrl, s.relay_account_id AS relayAccountId,
            h.name AS hostName, h.last_seen_at AS hostLastSeenAt
     FROM sync_spaces s
     JOIN hosts h ON h.id = s.host_id
     JOIN space_memberships m ON m.space_id = s.id
     WHERE m.user_id = ? AND m.revoked_at IS NULL AND s.revoked_at IS NULL AND h.revoked_at IS NULL
     ORDER BY h.last_seen_at DESC`
  )
    .bind(user.userId)
    .all()
  return json({ syncSpaces: rows.results })
}

export async function bindRelay(
  request: Request,
  env: Environment,
  spaceId: string,
  relayAdminOverride?: RelayAdministrationBinding
): Promise<Response> {
  const user = await authenticate(request, env)
  const input = relayBindingSchema.parse(await bodyJson(request))
  const protocol = new URL(input.relayUrl).protocol
  if (protocol !== 'https:' && !(env.ENVIRONMENT !== 'production' && protocol === 'http:')) {
    throw new ApiError(400, 'relay_url_invalid', 'Relay 必须使用 HTTPS。')
  }
  if (!relayBindingUsesManagedAuthority(input.relayUrl, env.ENVIRONMENT)) {
    throw new ApiError(400, 'relay_url_invalid', '无法使用这个同步服务，请更新 Fuddy 后重试。')
  }
  const space = await env.ACCOUNT_DB.prepare(
    `SELECT s.id, s.relay_url, s.relay_account_id, s.relay_binding_id,
            s.relay_generation, s.relay_bound_at,
            h.device_id AS host_device_id
     FROM sync_spaces s JOIN hosts h ON h.id = s.host_id
     WHERE s.id = ? AND s.owner_user_id = ? AND s.revoked_at IS NULL AND h.revoked_at IS NULL`
  )
    .bind(spaceId, user.userId)
    .first<{
      id: string
      relay_url: string | null
      relay_account_id: string
      relay_binding_id: string | null
      relay_generation: number
      relay_bound_at: string | null
      host_device_id: string
    }>()
  if (!space) throw new ApiError(404, 'sync_space_not_found', '没有找到可连接的工作空间。')
  if (space.host_device_id !== user.deviceId) {
    throw new ApiError(403, 'host_required', '需要由对应的 Mac Host 绑定 Relay。')
  }
  const relayAdmin = relayAdminOverride ?? (env.RELAY_ADMIN
    ? env.RELAY_ADMIN as RelayAdministrationBinding
    : undefined)
  if (!relayAdmin && env.ENVIRONMENT === 'production') {
    throw new ApiError(503, 'relay_authority_unavailable', '同步服务暂时不可用，请稍后重试。')
  }
  if (space.relay_bound_at
    && space.relay_url === input.relayUrl
    && space.relay_account_id === input.relayAccountId
    && space.relay_binding_id) {
    if (relayAdmin) {
      const current = await relayAdmin.setAccountGeneration(
        input.relayAccountId,
        spaceId,
        space.relay_binding_id,
        space.relay_generation
      )
      if (!current) throw new ApiError(409, 'relay_binding_changed', '连接归属已发生变化，请重新连接。')
    }
    return json({
      syncSpace: {
        id: spaceId,
        relayBound: true,
        relayUrl: input.relayUrl,
        relayAccountId: input.relayAccountId
      }
    })
  }
  const now = new Date()
  const timestamp = isoNow(now)
  const bindingId = crypto.randomUUID()
  try {
    await env.ACCOUNT_DB.batch([
      env.ACCOUNT_DB.prepare('DELETE FROM relay_binding_attempts WHERE expires_at <= ?').bind(timestamp),
      env.ACCOUNT_DB.prepare(
        `INSERT INTO relay_binding_attempts
          (id, space_id, relay_account_id, relay_url, generation, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        bindingId,
        spaceId,
        input.relayAccountId,
        input.relayUrl,
        space.relay_generation,
        timestamp,
        isoNow(addSeconds(now, RELAY_BINDING_ATTEMPT_SECONDS))
      )
    ])
  } catch {
    throw new ApiError(409, 'relay_binding_in_progress', '连接正在处理中，请稍后重试。')
  }
  let claimed = false
  try {
    claimed = relayAdmin
      ? await relayAdmin.claimAccountBinding(
        input.relayAccountId,
        spaceId,
        bindingId,
        space.relay_generation,
        input.bindingProof
      )
      : true
    if (!claimed) throw new ApiError(409, 'relay_binding_proof_invalid', 'Relay 所有权证明无效或已过期，请重试。')
  } catch (error) {
    await env.ACCOUNT_DB.prepare('DELETE FROM relay_binding_attempts WHERE id = ?').bind(bindingId).run()
    if (error instanceof ApiError) throw error
    throw new ApiError(503, 'relay_authority_unavailable', '同步服务暂时不可用，请稍后重试。')
  }
  const finalizeTimestamp = isoNow()
  const replacementRevocations = space.relay_bound_at && space.relay_account_id !== input.relayAccountId
    ? relayAccountRevocationStatements(env, [{
        spaceId,
        relayAccountId: space.relay_account_id,
        relayBindingId: space.relay_binding_id,
        relayGeneration: space.relay_generation
      }], finalizeTimestamp, bindingId)
    : []
  try {
    const results = await env.ACCOUNT_DB.batch([
      env.ACCOUNT_DB.prepare(
        `UPDATE sync_spaces
         SET relay_url = ?, relay_account_id = ?, relay_binding_id = ?, relay_bound_at = ?, updated_at = ?
         WHERE id = ? AND relay_account_id = ? AND relay_generation = ?
           AND EXISTS (
             SELECT 1 FROM relay_binding_attempts
             WHERE id = ? AND space_id = ? AND relay_account_id = ? AND expires_at > ?
           )`
      ).bind(
        input.relayUrl,
        input.relayAccountId,
        bindingId,
        finalizeTimestamp,
        finalizeTimestamp,
        spaceId,
        space.relay_account_id,
        space.relay_generation,
        bindingId,
        spaceId,
        input.relayAccountId,
        finalizeTimestamp
      ),
      ...replacementRevocations,
      env.ACCOUNT_DB.prepare(
        'UPDATE hosts SET last_seen_at = ?, updated_at = ? WHERE device_id = ?'
      ).bind(finalizeTimestamp, finalizeTimestamp, user.deviceId),
      env.ACCOUNT_DB.prepare(
        'UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE id = ?'
      ).bind(finalizeTimestamp, finalizeTimestamp, user.deviceId),
      env.ACCOUNT_DB.prepare('DELETE FROM relay_binding_attempts WHERE id = ?').bind(bindingId)
    ])
    if ((results[0].meta.changes ?? 0) === 0) {
      throw new ApiError(409, 'relay_binding_changed', '连接状态刚刚发生变化，请重试。')
    }
  } catch (error) {
    // Release only after a definitive CAS miss. A thrown D1 transport error has
    // an ambiguous commit outcome; its Relay claim is a five-minute lease and
    // must not be cleared if D1 actually committed the binding.
    if (relayAdmin && claimed && error instanceof ApiError) {
      await relayAdmin.releaseAccountBinding(input.relayAccountId, spaceId, bindingId).catch(() => false)
    }
    await env.ACCOUNT_DB.prepare('DELETE FROM relay_binding_attempts WHERE id = ?').bind(bindingId).run()
    if (error instanceof ApiError) throw error
    throw new ApiError(409, 'relay_binding_changed', '连接状态刚刚发生变化，请重试。')
  }
  if (relayAdmin) {
    try {
      const confirmed = await relayAdmin.confirmAccountBinding(input.relayAccountId, spaceId, bindingId)
      if (!confirmed) throw new Error('Relay binding confirmation did not match the reserved claim.')
    } catch {
      // D1 is already authoritative at this point. Leave the exact binding ID
      // in place so the coordinator's idempotent retry can confirm it through
      // setAccountGeneration instead of creating a second Relay identity.
      throw new ApiError(503, 'relay_binding_confirmation_pending', '连接已保存，正在等待同步服务确认，请稍后重试。')
    }
  }
  await processRelayRevocationJobs(env)
  return json({
    syncSpace: {
      id: spaceId,
      relayBound: true,
      relayUrl: input.relayUrl,
      relayAccountId: input.relayAccountId
    }
  })
}

async function listPendingEnrollments(request: Request, env: Environment, spaceId: string): Promise<Response> {
  const user = await authenticate(request, env)
  const space = await env.ACCOUNT_DB.prepare(
    `SELECT s.id, s.key_version, s.relay_url, s.relay_account_id, h.device_id AS host_device_id
     FROM sync_spaces s JOIN hosts h ON h.id = s.host_id
     WHERE s.id = ? AND s.owner_user_id = ? AND s.revoked_at IS NULL AND h.revoked_at IS NULL`
  )
    .bind(spaceId, user.userId)
    .first<{
      id: string
      key_version: number
      relay_url: string | null
      relay_account_id: string
      host_device_id: string
    }>()
  if (!space) throw new ApiError(404, 'sync_space_not_found', '没有找到可连接的工作空间。')
  if (space.host_device_id !== user.deviceId) {
    throw new ApiError(403, 'host_required', '需要由对应的 Mac Host 读取连接申请。')
  }
  if (!space.relay_url) throw new ApiError(409, 'relay_not_bound', '这台 Mac 还没有绑定 Relay。')
  const now = isoNow()
  await env.ACCOUNT_DB.prepare(
    `UPDATE device_grants SET status = 'revoked', revoked_at = ?, updated_at = ?
     WHERE space_id = ? AND status = 'pending' AND expires_at <= ?`
  )
    .bind(now, now, spaceId, now)
    .run()
  const rows = await env.ACCOUNT_DB.prepare(
    `SELECT g.id, g.space_id AS spaceId, g.device_id AS deviceId, g.expires_at AS expiresAt,
            d.name AS deviceName, d.public_key AS publicKey
     FROM device_grants g JOIN devices d ON d.id = g.device_id
     WHERE g.space_id = ? AND g.status = 'pending' AND g.expires_at > ? AND d.revoked_at IS NULL
     ORDER BY g.created_at ASC`
  )
    .bind(spaceId, now)
    .all()
  const revocations = await env.ACCOUNT_DB.prepare(
    `SELECT id, device_id AS deviceId
     FROM device_grants
     WHERE space_id = ? AND status = 'revoked' AND relay_revoked_at IS NULL
     ORDER BY updated_at ASC`
  )
    .bind(spaceId)
    .all()
  return json({
    syncSpace: {
      id: space.id,
      keyVersion: space.key_version,
      relayUrl: space.relay_url,
      relayAccountId: space.relay_account_id
    },
    enrollments: rows.results,
    revocations: revocations.results
  })
}

type RelayDeviceRevocationTarget = { id: string; deviceId: string; relayAccountId: string }
type RelayAccountRevocationTarget = {
  spaceId: string
  relayAccountId: string
  relayBindingId: string | null
  relayGeneration: number
}
type RelayRevocationJob = {
  id: string
  operation: 'account' | 'device'
  source_id: string
  relay_account_id: string
  device_id: string | null
  binding_id: string | null
  source_generation: number
  attempt_count: number
}

function relayDeviceRevocationStatements(
  env: Environment,
  grants: RelayDeviceRevocationTarget[],
  timestamp: string
): D1PreparedStatement[] {
  return grants.map((grant) => env.ACCOUNT_DB.prepare(
    `INSERT INTO relay_revocation_jobs
      (id, operation, source_id, relay_account_id, device_id, status, attempt_count,
       next_attempt_at, created_at, updated_at)
     VALUES (?, 'device', ?, ?, ?, 'pending', 0, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET relay_account_id = excluded.relay_account_id,
       device_id = excluded.device_id, status = 'pending', attempt_count = 0,
       next_attempt_at = excluded.next_attempt_at, last_error = NULL,
       completed_at = NULL, updated_at = excluded.updated_at`
  ).bind(
    `device:${grant.id}`,
    grant.id,
    grant.relayAccountId,
    grant.deviceId,
    timestamp,
    timestamp,
    timestamp
  ))
}

function relayAccountRevocationStatements(
  env: Environment,
  spaces: RelayAccountRevocationTarget[],
  timestamp: string,
  requiredBindingId: string | null = null
): D1PreparedStatement[] {
  return spaces.map((space) => env.ACCOUNT_DB.prepare(
    `INSERT INTO relay_revocation_jobs
      (id, operation, source_id, relay_account_id, device_id, binding_id, source_generation, status, attempt_count,
       next_attempt_at, created_at, updated_at)
     SELECT ?, 'account', ?, ?, NULL, ?, ?, 'pending', 0, ?, ?, ?
     WHERE ? IS NULL OR EXISTS (
       SELECT 1 FROM sync_spaces WHERE id = ? AND relay_binding_id = ?
     )
     ON CONFLICT(id) DO UPDATE SET relay_account_id = excluded.relay_account_id,
       device_id = NULL, binding_id = excluded.binding_id,
       source_generation = excluded.source_generation,
       status = 'pending', attempt_count = 0,
       next_attempt_at = excluded.next_attempt_at, last_error = NULL,
       completed_at = NULL, updated_at = excluded.updated_at`
  ).bind(
    `account:${space.spaceId}:${space.relayAccountId}`,
    space.spaceId,
    space.relayAccountId,
    space.relayBindingId,
    space.relayGeneration,
    timestamp,
    timestamp,
    timestamp,
    requiredBindingId,
    space.spaceId,
    requiredBindingId
  ))
}

export async function reactivateRelayAccountIfNeeded(
  env: Environment,
  spaceId: string,
  relayAdminOverride?: RelayAdministrationBinding
): Promise<number | null> {
  const pending = await env.ACCOUNT_DB.prepare(
    `SELECT s.relay_account_id, s.relay_binding_id, s.relay_generation,
            j.source_generation AS pending_source_generation
     FROM sync_spaces s JOIN relay_revocation_jobs j
       ON j.source_id = s.id AND j.operation = 'account' AND j.status = 'pending'
       AND j.relay_account_id = s.relay_account_id
       AND j.source_generation <= s.relay_generation
     WHERE s.id = ?`
  ).bind(spaceId).first<{
    relay_account_id: string
    relay_binding_id: string | null
    relay_generation: number
    pending_source_generation: number
  }>()
  if (!pending) return null
  const relayAdmin = relayAdminOverride
    ?? (env.RELAY_ADMIN ? env.RELAY_ADMIN as RelayAdministrationBinding : undefined)
  if (!relayAdmin) return null
  const timestamp = isoNow()
  let targetGeneration = pending.relay_generation
  if (pending.pending_source_generation === pending.relay_generation) {
    const advanced = await env.ACCOUNT_DB.prepare(
      `UPDATE sync_spaces SET relay_generation = relay_generation + 1, updated_at = ?
       WHERE id = ? AND relay_account_id = ? AND relay_generation = ? AND EXISTS (
         SELECT 1 FROM relay_revocation_jobs
         WHERE operation = 'account' AND source_id = ? AND status = 'pending'
           AND relay_account_id = ? AND source_generation = ?
       )
       RETURNING relay_generation`
    ).bind(
      timestamp,
      spaceId,
      pending.relay_account_id,
      pending.relay_generation,
      spaceId,
      pending.relay_account_id,
      pending.pending_source_generation
    ).first<{ relay_generation: number }>()
    if (advanced) {
      targetGeneration = advanced.relay_generation
    } else {
      const current = await env.ACCOUNT_DB.prepare(
        'SELECT relay_account_id, relay_binding_id, relay_generation FROM sync_spaces WHERE id = ?'
      ).bind(spaceId).first<{
        relay_account_id: string
        relay_binding_id: string | null
        relay_generation: number
      }>()
      if (!current || current.relay_account_id !== pending.relay_account_id) return null
      targetGeneration = current.relay_generation
    }
  }
  const generationSet = await relayAdmin.setAccountGeneration(
    pending.relay_account_id,
    spaceId,
    pending.relay_binding_id,
    targetGeneration
  )
  if (!generationSet) throw new Error('Relay account binding did not match the active sync space.')
  const revokedGrants = (await env.ACCOUNT_DB.prepare(
    `SELECT id, device_id AS deviceId, ? AS relayAccountId
     FROM device_grants
     WHERE space_id = ? AND status = 'revoked' AND relay_revoked_at IS NULL`
  ).bind(pending.relay_account_id, spaceId).all<RelayDeviceRevocationTarget>()).results
  await env.ACCOUNT_DB.batch([
    env.ACCOUNT_DB.prepare(
      `UPDATE relay_revocation_jobs
       SET status = 'completed', completed_at = ?, updated_at = ?, last_error = NULL
       WHERE operation = 'account' AND source_id = ? AND relay_account_id = ?
         AND status = 'pending' AND source_generation < ?`
    ).bind(timestamp, timestamp, spaceId, pending.relay_account_id, targetGeneration),
    ...relayDeviceRevocationStatements(env, revokedGrants, timestamp)
  ])
  await processRelayRevocationJobs(env, { relayAdmin })
  return targetGeneration
}

export async function processRelayRevocationJobs(
  env: Environment,
  options: {
    relayAdmin?: RelayAdministrationBinding
    now?: Date
    limit?: number
  } = {}
): Promise<{ attempted: number; completed: number }> {
  const relayAdmin = options.relayAdmin
    ?? (env.RELAY_ADMIN ? env.RELAY_ADMIN as RelayAdministrationBinding : undefined)
  if (!relayAdmin) return { attempted: 0, completed: 0 }
  const now = options.now ?? new Date()
  const timestamp = now.toISOString()
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100)
  const jobs = (await env.ACCOUNT_DB.prepare(
    `SELECT id, operation, source_id, relay_account_id, device_id, binding_id,
            source_generation, attempt_count
     FROM relay_revocation_jobs
     WHERE status = 'pending' AND next_attempt_at <= ?
     ORDER BY created_at ASC
     LIMIT ?`
  ).bind(timestamp, limit).all<RelayRevocationJob>()).results
  let completed = 0
  for (const job of jobs) {
    try {
      let relayRevoked = false
      let reactivatedDeviceCleanup: RelayDeviceRevocationTarget[] = []
      if (job.operation === 'account') {
        const currentSpace = await env.ACCOUNT_DB.prepare(
          `SELECT relay_account_id, relay_binding_id, relay_generation FROM sync_spaces WHERE id = ?`
        ).bind(job.source_id).first<{
          relay_account_id: string
          relay_binding_id: string | null
          relay_generation: number
        }>()
        const reactivatedSameRelay = currentSpace?.relay_account_id === job.relay_account_id
          && currentSpace.relay_generation > job.source_generation
        if (reactivatedSameRelay) {
          const generationSet = await relayAdmin.setAccountGeneration(
            job.relay_account_id,
            job.source_id,
            currentSpace.relay_binding_id,
            currentSpace.relay_generation
          )
          if (!generationSet) throw new Error('Relay account binding did not match the reactivated sync space.')
          reactivatedDeviceCleanup = (await env.ACCOUNT_DB.prepare(
            `SELECT id, device_id AS deviceId, ? AS relayAccountId
             FROM device_grants
             WHERE space_id = ? AND status = 'revoked' AND relay_revoked_at IS NULL`
          ).bind(job.relay_account_id, job.source_id).all<RelayDeviceRevocationTarget>()).results
        } else {
          const generationSet = await relayAdmin.setAccountGeneration(
            job.relay_account_id,
            job.source_id,
            job.binding_id,
            job.source_generation
          )
          if (!generationSet) throw new Error('Relay account binding did not match the revocation job.')
          relayRevoked = await relayAdmin.revokeAccount(
            job.relay_account_id,
            job.source_id,
            job.binding_id,
            job.source_generation
          )
          if (!relayRevoked) throw new Error('Relay account generation did not match the revocation job.')
        }
      } else {
        if (!job.device_id) throw new Error('Relay device revocation is missing a device ID.')
        const currentGrant = await env.ACCOUNT_DB.prepare(
          `SELECT g.id FROM device_grants g
           JOIN sync_spaces s ON s.id = g.space_id
           WHERE g.id = ? AND g.device_id = ? AND g.status = 'revoked'
             AND g.relay_revoked_at IS NULL AND s.relay_account_id = ?`
        ).bind(job.source_id, job.device_id, job.relay_account_id).first<{ id: string }>()
        if (currentGrant) {
          // Relay compares the Account enrollment ID atomically with its active
          // device generation, so a delayed job cannot revoke a re-enrolled phone.
          relayRevoked = await relayAdmin.revokeDevice(job.relay_account_id, job.device_id, job.source_id)
        }
      }
      const completedAt = new Date().toISOString()
      const statements = [
        env.ACCOUNT_DB.prepare(
          `UPDATE relay_revocation_jobs
           SET status = 'completed', attempt_count = attempt_count + 1,
               last_error = NULL, completed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`
        ).bind(completedAt, completedAt, job.id),
        ...relayDeviceRevocationStatements(env, reactivatedDeviceCleanup, completedAt),
        relayRevoked && job.operation === 'account'
          ? env.ACCOUNT_DB.prepare(
              `UPDATE device_grants SET relay_revoked_at = ?, updated_at = ?
               WHERE space_id = ? AND status = 'revoked' AND relay_revoked_at IS NULL
                 AND EXISTS (
                   SELECT 1 FROM sync_spaces
                   WHERE id = ? AND relay_account_id = ? AND relay_generation = ?
                 )`
            ).bind(
              completedAt,
              completedAt,
              job.source_id,
              job.source_id,
              job.relay_account_id,
              job.source_generation
            )
          : relayRevoked && job.operation === 'device'
            ? env.ACCOUNT_DB.prepare(
              `UPDATE device_grants SET relay_revoked_at = ?, updated_at = ?
               WHERE id = ? AND status = 'revoked' AND relay_revoked_at IS NULL`
            ).bind(completedAt, completedAt, job.source_id)
            : null
      ].filter((statement): statement is D1PreparedStatement => statement !== null)
      await env.ACCOUNT_DB.batch(statements)
      completed += 1
    } catch (error) {
      const attemptCount = job.attempt_count + 1
      const retrySeconds = Math.min(24 * 60 * 60, 30 * (2 ** Math.min(attemptCount - 1, 11)))
      const nextAttemptAt = new Date(now.getTime() + retrySeconds * 1_000).toISOString()
      const message = (error instanceof Error ? error.message : 'Relay revocation failed.').slice(0, 500)
      await env.ACCOUNT_DB.prepare(
        `UPDATE relay_revocation_jobs
         SET attempt_count = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`
      ).bind(attemptCount, nextAttemptAt, message, timestamp, job.id).run()
      console.warn('Relay revocation retry scheduled.', {
        jobId: job.id,
        operation: job.operation,
        attemptCount,
        nextAttemptAt,
        error: message
      })
    }
  }
  return { attempted: jobs.length, completed }
}

export async function pruneExpiredAccountData(
  env: Environment,
  now = new Date(),
  batchSize = ACCOUNT_PRUNE_BATCH_SIZE
): Promise<number> {
  const limit = Math.min(Math.max(Math.trunc(batchSize), 1), 2_000)
  const cutoff = (days: number): string => new Date(now.getTime() - days * 86_400_000).toISOString()
  const results = await env.ACCOUNT_DB.batch([
    env.ACCOUNT_DB.prepare(
      `DELETE FROM auth_rate_limits WHERE rowid IN (
         SELECT rowid FROM auth_rate_limits WHERE window_start < ? LIMIT ?
       )`
    ).bind(cutoff(2), limit),
    env.ACCOUNT_DB.prepare(
      `DELETE FROM auth_email_cooldowns WHERE email IN (
         SELECT email FROM auth_email_cooldowns WHERE available_at < ? LIMIT ?
       )`
    ).bind(cutoff(2), limit),
    env.ACCOUNT_DB.prepare(
      `DELETE FROM auth_challenges WHERE id IN (
         SELECT id FROM auth_challenges WHERE created_at < ? LIMIT ?
       )`
    ).bind(cutoff(7), limit),
    env.ACCOUNT_DB.prepare(
      `DELETE FROM resend_webhook_events WHERE svix_id IN (
         SELECT svix_id FROM resend_webhook_events WHERE received_at < ? LIMIT ?
       )`
    ).bind(cutoff(30), limit),
    env.ACCOUNT_DB.prepare(
      `DELETE FROM security_events WHERE id IN (
         SELECT id FROM security_events WHERE created_at < ? LIMIT ?
       )`
    ).bind(cutoff(90), limit),
    env.ACCOUNT_DB.prepare(
      `DELETE FROM auth_sessions WHERE id IN (
         SELECT id FROM auth_sessions
         WHERE (revoked_at IS NOT NULL AND updated_at < ?) OR absolute_expires_at < ?
         LIMIT ?
       )`
    ).bind(cutoff(7), cutoff(7), limit),
    env.ACCOUNT_DB.prepare(
      `DELETE FROM relay_binding_attempts WHERE id IN (
         SELECT id FROM relay_binding_attempts WHERE expires_at < ? LIMIT ?
       )`
    ).bind(now.toISOString(), limit),
    env.ACCOUNT_DB.prepare(
      `DELETE FROM relay_revocation_jobs WHERE id IN (
         SELECT id FROM relay_revocation_jobs
         WHERE status = 'completed' AND completed_at < ? LIMIT ?
       )`
    ).bind(cutoff(30), limit)
  ])
  return results.reduce((total, result) => total + (result.meta.changes ?? 0), 0)
}

async function revokeDevice(request: Request, env: Environment, deviceId: string): Promise<Response> {
  const user = await authenticate(request, env)
  const device = await env.ACCOUNT_DB.prepare('SELECT id, platform FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .bind(deviceId, user.userId)
    .first<{ id: string; platform: string }>()
  if (!device) throw new ApiError(404, 'device_not_found', '没有找到这台设备。')
  const relayGrants = device.platform === 'ios'
    ? (await env.ACCOUNT_DB.prepare(
        `SELECT g.id, g.device_id AS deviceId, s.relay_account_id AS relayAccountId
         FROM device_grants g JOIN sync_spaces s ON s.id = g.space_id
         WHERE g.device_id = ? AND g.status != 'revoked' AND s.relay_account_id IS NOT NULL`
      ).bind(deviceId).all<{ id: string; deviceId: string; relayAccountId: string }>()).results
    : []
  const relaySpaces = device.platform === 'macos'
    ? (await env.ACCOUNT_DB.prepare(
        `SELECT s.id AS spaceId, s.relay_account_id AS relayAccountId,
                s.relay_binding_id AS relayBindingId,
                s.relay_generation AS relayGeneration
         FROM sync_spaces s JOIN hosts h ON h.id = s.host_id
         WHERE h.device_id = ? AND s.revoked_at IS NULL AND s.relay_account_id IS NOT NULL`
      ).bind(deviceId).all<RelayAccountRevocationTarget>()).results
    : []
  const timestamp = isoNow()
  const statements: D1PreparedStatement[] = [
    env.ACCOUNT_DB.prepare('UPDATE devices SET revoked_at = ?, updated_at = ? WHERE id = ?').bind(timestamp, timestamp, deviceId),
    env.ACCOUNT_DB.prepare('UPDATE auth_sessions SET revoked_at = ?, updated_at = ? WHERE device_id = ?').bind(timestamp, timestamp, deviceId),
    env.ACCOUNT_DB.prepare('UPDATE device_grants SET status = \'revoked\', revoked_at = ?, updated_at = ? WHERE device_id = ?')
      .bind(timestamp, timestamp, deviceId),
    env.ACCOUNT_DB.prepare(
      `INSERT INTO security_events (id, user_id, device_id, event_type, created_at)
       VALUES (?, ?, ?, 'device.revoked', ?)`
    ).bind(crypto.randomUUID(), user.userId, deviceId, timestamp)
  ]
  if (device.platform === 'macos') {
    statements.push(
      env.ACCOUNT_DB.prepare('UPDATE hosts SET revoked_at = ?, updated_at = ? WHERE device_id = ?')
        .bind(timestamp, timestamp, deviceId),
      env.ACCOUNT_DB.prepare(
        `UPDATE sync_spaces SET revoked_at = ?, updated_at = ?
         WHERE host_id IN (SELECT id FROM hosts WHERE device_id = ?)`
      ).bind(timestamp, timestamp, deviceId),
      env.ACCOUNT_DB.prepare(
        `UPDATE device_grants SET status = 'revoked', revoked_at = ?, relay_revoked_at = NULL, updated_at = ?
         WHERE space_id IN (SELECT s.id FROM sync_spaces s JOIN hosts h ON h.id = s.host_id WHERE h.device_id = ?)
           AND status != 'revoked'`
      ).bind(timestamp, timestamp, deviceId)
    )
  }
  statements.push(
    ...(device.platform === 'macos'
      ? relayAccountRevocationStatements(env, relaySpaces, timestamp)
      : relayDeviceRevocationStatements(env, relayGrants, timestamp))
  )
  await env.ACCOUNT_DB.batch(statements)
  await processRelayRevocationJobs(env)
  return new Response(null, { status: 204 })
}

async function createEnrollment(request: Request, env: Environment, spaceId: string): Promise<Response> {
  const user = await authenticate(request, env)
  const { deviceId } = enrollmentSchema.parse(await bodyJson(request))
  if (deviceId !== user.deviceId) throw new ApiError(403, 'device_mismatch', '只能为当前设备申请连接。')
  const device = await env.ACCOUNT_DB.prepare(
    'SELECT platform FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL'
  )
    .bind(user.deviceId, user.userId)
    .first<{ platform: string }>()
  if (device?.platform !== 'ios') throw new ApiError(403, 'ios_required', '只有 iPhone 可以申请连接 Mac。')
  const membership = await env.ACCOUNT_DB.prepare(
    `SELECT s.key_version FROM space_memberships m JOIN sync_spaces s ON s.id = m.space_id
     WHERE m.space_id = ? AND m.user_id = ? AND m.revoked_at IS NULL AND s.revoked_at IS NULL`
  )
    .bind(spaceId, user.userId)
    .first<{ key_version: number }>()
  if (!membership) throw new ApiError(404, 'sync_space_not_found', '没有找到可连接的工作空间。')
  const now = new Date()
  const enrollmentId = crypto.randomUUID()
  const revocationPending = await env.ACCOUNT_DB.prepare(
    `SELECT id FROM device_grants
     WHERE space_id = ? AND device_id = ? AND status = 'revoked' AND relay_revoked_at IS NULL`
  ).bind(spaceId, deviceId).first<{ id: string }>()
  if (revocationPending) await processRelayRevocationJobs(env)
  const enrollment = await env.ACCOUNT_DB.prepare(
    `INSERT INTO device_grants (id, space_id, device_id, requested_by_user_id, status, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
     ON CONFLICT(space_id, device_id) DO UPDATE SET id = excluded.id, status = 'pending', wrapped_space_key = NULL,
       key_version = NULL, created_at = excluded.created_at, updated_at = excluded.updated_at,
       expires_at = excluded.expires_at, activated_at = NULL, revoked_at = NULL, relay_revoked_at = NULL
     WHERE device_grants.status != 'revoked' OR device_grants.relay_revoked_at IS NOT NULL
     RETURNING id`
  )
    .bind(
      enrollmentId,
      spaceId,
      deviceId,
      user.userId,
      isoNow(now),
      isoNow(now),
      addSeconds(now, 10 * 60).toISOString()
    )
    .first<{ id: string }>()
  if (!enrollment) {
    throw new ApiError(409, 'relay_revocation_pending', '正在准备安全连接，请稍后重试。')
  }
  return json({ enrollment: { id: enrollmentId, spaceId, deviceId, status: 'pending' } }, { status: 201 })
}

async function completeEnrollment(
  request: Request,
  env: Environment,
  spaceId: string,
  enrollmentId: string
): Promise<Response> {
  const user = await authenticate(request, env)
  const input = completeEnrollmentSchema.parse(await bodyJson(request))
  const grant = await env.ACCOUNT_DB.prepare(
    `SELECT g.device_id, g.status, g.expires_at, s.key_version, h.device_id AS host_device_id
     FROM device_grants g JOIN sync_spaces s ON s.id = g.space_id JOIN hosts h ON h.id = s.host_id
     WHERE g.id = ? AND g.space_id = ? AND s.owner_user_id = ?`
  )
    .bind(enrollmentId, spaceId, user.userId)
    .first<{
      device_id: string
      status: string
      expires_at: string
      key_version: number
      host_device_id: string
  }>()
  if (!grant) throw new ApiError(404, 'enrollment_not_found', '没有找到这次连接申请。')
  if (grant.host_device_id !== user.deviceId) throw new ApiError(403, 'host_required', '需要由对应的 Mac Host 完成授权。')
  if (grant.status !== 'pending' || new Date(grant.expires_at).getTime() <= Date.now()) {
    if (grant.status === 'revoked') {
      await requeueRevokedEnrollmentRelay(env, spaceId, enrollmentId)
    }
    throw new ApiError(409, 'enrollment_not_pending', '这次连接申请已失效。')
  }
  if (input.keyVersion !== grant.key_version) throw new ApiError(409, 'key_version_mismatch', '工作空间密钥版本已变化。')
  const activated = await activatePendingEnrollment(env, {
    enrollmentId,
    spaceId,
    wrappedSpaceKey: input.wrappedSpaceKey,
    keyVersion: input.keyVersion
  })
  if (!activated) {
    await requeueRevokedEnrollmentRelay(env, spaceId, enrollmentId)
    throw new ApiError(409, 'enrollment_not_pending', '这次连接申请已失效。')
  }
  return json({ enrollment: { id: enrollmentId, spaceId, deviceId: grant.device_id, status: 'active' } })
}

async function requeueRevokedEnrollmentRelay(
  env: Environment,
  spaceId: string,
  enrollmentId: string
): Promise<void> {
  const grant = await env.ACCOUNT_DB.prepare(
    `SELECT g.id, g.device_id AS deviceId, s.relay_account_id AS relayAccountId
     FROM device_grants g JOIN sync_spaces s ON s.id = g.space_id
     WHERE g.id = ? AND g.space_id = ? AND g.status = 'revoked'`
  ).bind(enrollmentId, spaceId).first<RelayDeviceRevocationTarget>()
  if (!grant) return
  const timestamp = isoNow()
  await env.ACCOUNT_DB.batch([
    env.ACCOUNT_DB.prepare(
      `UPDATE device_grants SET relay_revoked_at = NULL, updated_at = ?
       WHERE id = ? AND space_id = ? AND status = 'revoked'`
    ).bind(timestamp, enrollmentId, spaceId),
    ...relayDeviceRevocationStatements(env, [grant], timestamp)
  ])
  await processRelayRevocationJobs(env)
}

export async function activatePendingEnrollment(
  env: Environment,
  input: {
    enrollmentId: string
    spaceId: string
    wrappedSpaceKey: string
    keyVersion: number
  },
  now = new Date()
): Promise<boolean> {
  const timestamp = isoNow(now)
  const activated = await env.ACCOUNT_DB.prepare(
    `UPDATE device_grants
     SET status = 'active', wrapped_space_key = ?, key_version = ?, updated_at = ?, activated_at = ?
     WHERE id = ? AND space_id = ? AND status = 'pending' AND expires_at > ?
       AND EXISTS (
         SELECT 1 FROM sync_spaces s
         WHERE s.id = ? AND s.key_version = ? AND s.revoked_at IS NULL
       )
       AND EXISTS (
         SELECT 1 FROM devices d
         WHERE d.id = device_grants.device_id AND d.revoked_at IS NULL
       )
     RETURNING id`
  ).bind(
    input.wrappedSpaceKey,
    input.keyVersion,
    timestamp,
    timestamp,
    input.enrollmentId,
    input.spaceId,
    timestamp,
    input.spaceId,
    input.keyVersion
  ).first<{ id: string }>()
  return Boolean(activated)
}

async function completeRelayRevocation(
  request: Request,
  env: Environment,
  spaceId: string,
  enrollmentId: string
): Promise<Response> {
  const user = await authenticate(request, env)
  const grant = await env.ACCOUNT_DB.prepare(
    `SELECT g.status, h.device_id AS host_device_id
     FROM device_grants g
     JOIN sync_spaces s ON s.id = g.space_id
     JOIN hosts h ON h.id = s.host_id
     WHERE g.id = ? AND g.space_id = ? AND s.owner_user_id = ?`
  )
    .bind(enrollmentId, spaceId, user.userId)
    .first<{ status: string; host_device_id: string }>()
  if (!grant) throw new ApiError(404, 'enrollment_not_found', '没有找到这次设备授权。')
  if (grant.host_device_id !== user.deviceId) {
    throw new ApiError(403, 'host_required', '需要由对应的 Mac Host 确认撤销。')
  }
  if (grant.status !== 'revoked') throw new ApiError(409, 'grant_not_revoked', '这台设备尚未被撤销。')
  const timestamp = isoNow()
  await env.ACCOUNT_DB.prepare(
    'UPDATE device_grants SET relay_revoked_at = ?, updated_at = ? WHERE id = ?'
  )
    .bind(timestamp, timestamp, enrollmentId)
    .run()
  return new Response(null, { status: 204 })
}

async function getEnrollment(request: Request, env: Environment, spaceId: string, enrollmentId: string): Promise<Response> {
  const user = await authenticate(request, env)
  const row = await env.ACCOUNT_DB.prepare(
    `SELECT g.id, g.space_id AS spaceId, g.device_id AS deviceId, g.status, g.wrapped_space_key AS wrappedSpaceKey,
            g.key_version AS keyVersion, g.expires_at AS expiresAt
     FROM device_grants g
     JOIN space_memberships m ON m.space_id = g.space_id
     JOIN sync_spaces s ON s.id = g.space_id
     JOIN hosts h ON h.id = s.host_id
     WHERE g.id = ? AND g.space_id = ? AND m.user_id = ? AND m.revoked_at IS NULL
       AND (g.device_id = ? OR h.device_id = ?)`
  )
    .bind(enrollmentId, spaceId, user.userId, user.deviceId, user.deviceId)
    .first()
  if (!row) throw new ApiError(404, 'enrollment_not_found', '没有找到这次连接申请。')
  return json({ enrollment: row })
}

async function receiveResendWebhook(request: Request, env: Environment): Promise<Response> {
  if (!env.RESEND_WEBHOOK_SECRET) {
    throw new ApiError(503, 'webhook_not_configured', '邮件回执服务尚未配置。')
  }
  let raw: string
  try {
    raw = await readLimitedText(request, MAX_JSON_BODY_BYTES)
  } catch {
    throw new ApiError(413, 'request_too_large', 'Webhook 内容过大。')
  }
  const svixId = request.headers.get('svix-id')
  const svixTimestamp = request.headers.get('svix-timestamp')
  const svixSignature = request.headers.get('svix-signature')
  if (!svixId || !svixTimestamp || !svixSignature) {
    throw new ApiError(400, 'webhook_signature_missing', 'Webhook 签名不完整。')
  }
  let verified: unknown
  try {
    verified = new Webhook(env.RESEND_WEBHOOK_SECRET).verify(raw, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature
    })
  } catch {
    throw new ApiError(400, 'webhook_signature_invalid', 'Webhook 签名无效。')
  }
  const event = resendWebhookSchema.parse(verified)
  const receivedAt = isoNow()
  const inserted = await env.ACCOUNT_DB.prepare(
    `INSERT INTO resend_webhook_events (svix_id, event_type, resend_email_id, event_created_at, received_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(svix_id) DO NOTHING`
  ).bind(svixId, event.type, event.data.email_id, event.created_at, receivedAt).run()
  if ((inserted.meta.changes ?? 0) === 0) return json({ accepted: true, duplicate: true })

  const challenge = await env.ACCOUNT_DB.prepare(
    'SELECT email FROM auth_challenges WHERE resend_email_id = ?'
  ).bind(event.data.email_id).first<{ email: string }>()
  const statements: D1PreparedStatement[] = [
    env.ACCOUNT_DB.prepare(
      `UPDATE auth_challenges SET delivery_status = ?, delivery_updated_at = ?
       WHERE resend_email_id = ? AND (delivery_updated_at IS NULL OR delivery_updated_at <= ?)`
    ).bind(event.type, event.created_at, event.data.email_id, event.created_at)
  ]
  if (challenge && ['email.bounced', 'email.complained', 'email.suppressed'].includes(event.type)) {
    const emailHash = await hmac(`email-suppression:${challenge.email}`, env.OTP_PEPPER)
    statements.push(
      env.ACCOUNT_DB.prepare(
        `INSERT INTO email_suppressions (email_hash, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(email_hash) DO UPDATE SET reason = excluded.reason, updated_at = excluded.updated_at`
      ).bind(emailHash, event.type, receivedAt, receivedAt)
    )
  }
  await env.ACCOUNT_DB.batch(statements)
  return json({ accepted: true })
}

async function route(request: Request, env: Environment): Promise<Response> {
  requireConfiguration(env)
  const parts = pathParts(request)
  if (request.method === 'GET' && parts.join('/') === 'health') return json({ ok: true })
  if (request.method === 'POST' && parts.join('/') === 'v1/webhooks/resend') return receiveResendWebhook(request, env)
  if (request.method === 'POST' && parts.join('/') === 'v1/auth/email/start') return startEmail(request, env)
  if (request.method === 'POST' && parts.join('/') === 'v1/auth/email/verify') return verifyEmail(request, env)
  if (request.method === 'POST' && parts.join('/') === 'v1/auth/google') return googleSignIn(request, env)
  if (request.method === 'POST' && parts.join('/') === 'v1/auth/refresh') return refreshSession(request, env)
  if (request.method === 'GET' && parts.join('/') === 'v1/identities') return listIdentities(request, env)
  if (request.method === 'POST' && parts.join('/') === 'v1/identities/google') return linkGoogle(request, env)
  if (request.method === 'DELETE' && parts.join('/') === 'v1/identities/google') return unlinkGoogle(request, env)
  if (request.method === 'GET' && parts.join('/') === 'v1/me') {
    const user = await authenticate(request, env)
    return json({ user: { id: user.userId, email: user.email, displayName: user.displayName }, deviceId: user.deviceId })
  }
  if (request.method === 'POST' && parts.join('/') === 'v1/auth/logout') {
    const user = await authenticate(request, env)
    const relayGrants = (await env.ACCOUNT_DB.prepare(
      `SELECT g.id, g.device_id AS deviceId, s.relay_account_id AS relayAccountId
       FROM device_grants g JOIN sync_spaces s ON s.id = g.space_id
       WHERE g.device_id = ? AND g.status != 'revoked' AND s.relay_account_id IS NOT NULL`
    ).bind(user.deviceId).all<{ id: string; deviceId: string; relayAccountId: string }>()).results
    const timestamp = isoNow()
    await env.ACCOUNT_DB.batch([
      env.ACCOUNT_DB.prepare('UPDATE auth_sessions SET revoked_at = ?, updated_at = ? WHERE id = ?')
        .bind(timestamp, timestamp, user.sessionId),
      env.ACCOUNT_DB.prepare(
        `UPDATE device_grants SET status = 'revoked', revoked_at = ?, relay_revoked_at = NULL, updated_at = ?
         WHERE device_id = ? AND status != 'revoked'`
      ).bind(timestamp, timestamp, user.deviceId),
      ...relayDeviceRevocationStatements(env, relayGrants, timestamp)
    ])
    await processRelayRevocationJobs(env)
    return new Response(null, { status: 204 })
  }
  if (request.method === 'POST' && parts.join('/') === 'v1/auth/logout-all') {
    const user = await authenticate(request, env)
    const relaySpaces = (await env.ACCOUNT_DB.prepare(
      `SELECT s.id AS spaceId, s.relay_account_id AS relayAccountId,
              s.relay_binding_id AS relayBindingId,
              s.relay_generation AS relayGeneration
       FROM sync_spaces s JOIN hosts h ON h.id = s.host_id
       WHERE h.user_id = ? AND s.revoked_at IS NULL AND s.relay_account_id IS NOT NULL`
    ).bind(user.userId).all<RelayAccountRevocationTarget>()).results
    const timestamp = isoNow()
    await env.ACCOUNT_DB.batch([
      env.ACCOUNT_DB.prepare('UPDATE auth_sessions SET revoked_at = ?, updated_at = ? WHERE user_id = ?')
        .bind(timestamp, timestamp, user.userId),
      env.ACCOUNT_DB.prepare(
        `UPDATE device_grants SET status = 'revoked', revoked_at = ?, relay_revoked_at = NULL, updated_at = ?
         WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?) AND status != 'revoked'`
      ).bind(timestamp, timestamp, user.userId),
      ...relayAccountRevocationStatements(env, relaySpaces, timestamp)
    ])
    await processRelayRevocationJobs(env)
    return new Response(null, { status: 204 })
  }
  if (request.method === 'GET' && parts.join('/') === 'v1/devices') return listDevices(request, env)
  if (request.method === 'GET' && parts.join('/') === 'v1/hosts') return listHosts(request, env)
  if (request.method === 'GET' && parts.join('/') === 'v1/sync-spaces') return listSyncSpaces(request, env)
  if (request.method === 'DELETE' && parts[0] === 'v1' && parts[1] === 'devices' && parts[2] && parts.length === 3) {
    return revokeDevice(request, env, parts[2])
  }
  if (parts[0] === 'v1' && parts[1] === 'sync-spaces' && parts[2] && parts[3] === 'enrollments') {
    if (request.method === 'POST' && parts.length === 4) return createEnrollment(request, env, parts[2])
    if (request.method === 'GET' && parts.length === 4) return listPendingEnrollments(request, env, parts[2])
    if (request.method === 'GET' && parts[4] && parts.length === 5) return getEnrollment(request, env, parts[2], parts[4])
    if (request.method === 'POST' && parts[4] && parts[5] === 'complete' && parts.length === 6) {
      return completeEnrollment(request, env, parts[2], parts[4])
    }
    if (request.method === 'POST' && parts[4] && parts[5] === 'revocation-complete' && parts.length === 6) {
      return completeRelayRevocation(request, env, parts[2], parts[4])
    }
  }
  if (
    request.method === 'POST' && parts[0] === 'v1' && parts[1] === 'sync-spaces' && parts[2]
    && parts[3] === 'relay-binding' && parts.length === 4
  ) {
    return bindRelay(request, env, parts[2])
  }
  throw new ApiError(404, 'not_found', '没有找到这个接口。')
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { allow: 'GET, POST, DELETE, OPTIONS' } })
    }
    try {
      return await route(request, env)
    } catch (error) {
      if (error instanceof ApiError) {
        return json({ error: { code: error.code, message: error.message, details: error.details } }, { status: error.status })
      }
      if (error instanceof z.ZodError) {
        return json(
          { error: { code: 'invalid_request', message: '请求内容不完整或格式不正确。', details: z.flattenError(error) } },
          { status: 400 }
        )
      }
      console.error('Unhandled account API error', error)
      return json({ error: { code: 'internal_error', message: '服务暂时不可用，请稍后重试。' } }, { status: 500 })
    }
  },
  async scheduled(_controller: ScheduledController, env: Environment, context: ExecutionContext): Promise<void> {
    context.waitUntil((async () => {
      await processRelayRevocationJobs(env)
      await pruneExpiredAccountData(env)
    })())
  }
} satisfies ExportedHandler<Environment>
