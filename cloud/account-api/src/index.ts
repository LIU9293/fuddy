import { createRemoteJWKSet, jwtVerify } from 'jose'
import { Webhook } from 'svix'
import { z } from 'zod'
import type { ProjectRelayAdministrationBinding, RelayAdministrationBinding } from '../../relay/src/administration-contract'
import { defaultCompanionRelayUrl } from '../../../src/shared/companion-sync'
import { addSeconds, hmac, isoNow, randomCode, randomToken, secretsEqual } from './crypto'
import {
  acceptProjectInvitationSchema,
  beginProjectBaselineSchema,
  completeEnrollmentSchema,
  completeProjectDeviceGrantSchema,
  completeProjectCommandSchema,
  createProjectInvitationSchema,
  createProjectShareSchema,
  publishProjectEventSchema,
  putProjectBaselineChunkSchema,
  registerProjectChatSchema,
  submitProjectCommandSchema,
  enrollmentSchema,
  googleIdentitySchema,
  googleSignInSchema,
  relayBindingSchema,
  refreshSchema,
  resendWebhookSchema,
  startEmailSchema,
  updateProjectExecutionHostSchema,
  verifyEmailSchema
} from './schemas'
import type { AuthenticatedUser, DeviceInput, Environment } from './types'
import { chatTitleInputLimit } from '../../../src/shared/agent-run-title'
import { generateChatTitle } from './chat-title'

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
const PROJECT_INVITATION_SECONDS = 7 * 24 * 60 * 60
const MAX_PROJECT_MEMBERS = 20

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

type ProjectShareRow = {
  project_id: string
  local_project_id: string
  owner_user_id: string
  execution_host_id: string
  key_authority_host_id: string
  status: 'active' | 'closed'
  permission_revision: number
  key_epoch: number
}

async function requireProjectShare(
  env: Environment,
  projectId: string,
  userId: string,
  ownerOnly = false
): Promise<{ share: ProjectShareRow; role: 'owner' | 'member' }> {
  const share = await env.ACCOUNT_DB.prepare(
    `SELECT project_id, local_project_id, owner_user_id, execution_host_id, key_authority_host_id,
            status, permission_revision, key_epoch
     FROM project_shares WHERE project_id = ? AND status = 'active'`
  ).bind(projectId).first<ProjectShareRow>()
  if (!share) throw new ApiError(404, 'project_share_not_found', '没有找到这个共享项目。')
  if (share.owner_user_id === userId) return { share, role: 'owner' }
  if (!ownerOnly) {
    const member = await env.ACCOUNT_DB.prepare(
      'SELECT 1 FROM project_memberships WHERE project_id = ? AND user_id = ? AND revoked_at IS NULL'
    ).bind(projectId, userId).first()
    if (member) return { share, role: 'member' }
  }
  throw new ApiError(404, 'project_share_not_found', '没有找到这个共享项目。')
}

async function createProjectShare(request: Request, env: Environment): Promise<Response> {
  const user = await authenticate(request, env)
  const input = createProjectShareSchema.parse(await bodyJson(request))
  const host = await env.ACCOUNT_DB.prepare(
    'SELECT id FROM hosts WHERE id = ? AND user_id = ? AND device_id = ? AND revoked_at IS NULL'
  ).bind(input.executionHostId, user.userId, user.deviceId).first()
  if (!host) throw new ApiError(403, 'execution_host_required', '请在项目执行 Mac 上开启共享。')
  const now = isoNow()
  const shareId = crypto.randomUUID()
  const inserted = await env.ACCOUNT_DB.prepare(
    `INSERT OR IGNORE INTO project_shares
       (project_id, local_project_id, owner_user_id, execution_host_id, key_authority_host_id, status,
        permission_revision, key_epoch, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', 1, 1, ?, ?)`
  ).bind(shareId, input.localProjectId, user.userId, input.executionHostId,
    input.executionHostId, now, now).run()
  if ((inserted.meta.changes ?? 0) === 0) {
    await env.ACCOUNT_DB.prepare(
      `UPDATE project_shares SET status = 'active', execution_host_id = ?, key_authority_host_id = ?,
         permission_revision = permission_revision + 1, key_epoch = key_epoch + 1,
         closed_at = NULL, updated_at = ?
       WHERE local_project_id = ? AND owner_user_id = ? AND status = 'closed'`
    ).bind(input.executionHostId, input.executionHostId,
      now, input.localProjectId, user.userId).run()
  }
  const owned = await env.ACCOUNT_DB.prepare(
    `SELECT project_id FROM project_shares WHERE owner_user_id = ? AND local_project_id = ?`
  ).bind(user.userId, input.localProjectId).first<{ project_id: string }>()
  if (!owned) throw new ApiError(409, 'project_share_registration_failed', '共享项目登记失败。')
  const { share } = await requireProjectShare(env, owned.project_id, user.userId, true)
  if (share.execution_host_id !== input.executionHostId) {
    throw new ApiError(409, 'project_share_exists', '这个项目已有共享执行 Mac。')
  }
  await env.ACCOUNT_DB.prepare(
    `INSERT OR IGNORE INTO project_share_publishers (project_id, host_id, created_at) VALUES (?, ?, ?)`
  ).bind(share.project_id, input.executionHostId, now).run()
  return json({ projectShare: {
    projectId: share.project_id, localProjectId: share.local_project_id,
    role: 'owner', executionHostId: share.execution_host_id,
    keyAuthorityHostId: share.key_authority_host_id,
    permissionRevision: share.permission_revision, keyEpoch: share.key_epoch
  } }, { status: (inserted.meta.changes ?? 0) > 0 ? 201 : 200 })
}

async function listProjectShares(request: Request, env: Environment): Promise<Response> {
  const user = await authenticate(request, env)
  const rows = await env.ACCOUNT_DB.prepare(
    `SELECT s.project_id AS projectId, s.execution_host_id AS executionHostId,
            s.key_authority_host_id AS keyAuthorityHostId,
            CASE WHEN s.owner_user_id = ? THEN s.local_project_id ELSE NULL END AS localProjectId,
            s.permission_revision AS permissionRevision, s.key_epoch AS keyEpoch,
            CASE WHEN s.owner_user_id = ? THEN 'owner' ELSE 'member' END AS role
     FROM project_shares s
     LEFT JOIN project_memberships m ON m.project_id = s.project_id AND m.user_id = ? AND m.revoked_at IS NULL
     WHERE s.status = 'active' AND (s.owner_user_id = ? OR m.user_id IS NOT NULL)
     ORDER BY s.updated_at DESC`
  ).bind(user.userId, user.userId, user.userId, user.userId).all()
  return json({ projectShares: rows.results })
}

async function getProjectShare(request: Request, env: Environment, projectId: string): Promise<Response> {
  const user = await authenticate(request, env)
  const { share, role } = await requireProjectShare(env, projectId, user.userId)
  return json({ projectShare: {
    projectId: share.project_id, ...(role === 'owner' ? { localProjectId: share.local_project_id } : {}),
    role, executionHostId: share.execution_host_id,
    keyAuthorityHostId: share.key_authority_host_id,
    permissionRevision: share.permission_revision, keyEpoch: share.key_epoch
  } })
}

function projectRelay(env: Environment, override?: ProjectRelayAdministrationBinding): ProjectRelayAdministrationBinding {
  const binding = override ?? env.RELAY_ADMIN
  if (!binding) {
    throw new ApiError(503, 'project_relay_unavailable', '项目同步服务暂不可用。')
  }
  return binding as ProjectRelayAdministrationBinding
}

async function requireProjectPublisher(env: Environment, projectId: string, user: AuthenticatedUser): Promise<ProjectShareRow> {
  const { share } = await requireProjectShare(env, projectId, user.userId, true)
  const host = await env.ACCOUNT_DB.prepare(
    `SELECT h.id FROM hosts h JOIN project_share_publishers p ON p.host_id = h.id
     WHERE p.project_id = ? AND h.user_id = ? AND h.device_id = ? AND h.revoked_at IS NULL`
  ).bind(projectId, user.userId, user.deviceId).first()
  if (!host) throw new ApiError(403, 'publisher_host_required', '这台 Mac 尚未登记为项目内容来源。')
  return share
}

async function registerProjectPublisher(request: Request, env: Environment, projectId: string): Promise<Response> {
  const user = await authenticate(request, env)
  await requireProjectShare(env, projectId, user.userId, true)
  const host = await env.ACCOUNT_DB.prepare(
    'SELECT id FROM hosts WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL'
  ).bind(user.userId, user.deviceId).first<{ id: string }>()
  if (!host) throw new ApiError(403, 'publisher_host_required', '请在自己的 Mac 上登记项目内容来源。')
  await env.ACCOUNT_DB.prepare(
    `INSERT OR IGNORE INTO project_share_publishers (project_id, host_id, created_at) VALUES (?, ?, ?)`
  ).bind(projectId, host.id, isoNow()).run()
  return json({ hostId: host.id })
}

async function listProjectPublishers(request: Request, env: Environment, projectId: string): Promise<Response> {
  const user = await authenticate(request, env)
  await requireProjectShare(env, projectId, user.userId)
  const rows = await env.ACCOUNT_DB.prepare(
    `SELECT p.host_id AS hostId, h.device_id AS sourceDeviceId,
            h.name AS hostName, h.last_seen_at AS lastSeenAt
     FROM project_share_publishers p JOIN hosts h ON h.id = p.host_id
     WHERE p.project_id = ? AND h.revoked_at IS NULL ORDER BY p.created_at`
  ).bind(projectId).all()
  return json({ publishers: rows.results })
}

async function requireProjectReader(env: Environment, projectId: string, user: AuthenticatedUser): Promise<ProjectShareRow> {
  const { share, role } = await requireProjectShare(env, projectId, user.userId)
  if (role === 'member') {
    const grant = await env.ACCOUNT_DB.prepare(
      `SELECT 1 FROM project_device_grants WHERE project_id = ? AND user_id = ? AND device_id = ?
       AND status = 'active' AND revoked_at IS NULL AND key_epoch = ?`
    ).bind(projectId, user.userId, user.deviceId, share.key_epoch).first()
    if (!grant) throw new ApiError(403, 'project_device_grant_required', '当前设备尚未获得项目密钥授权。')
  }
  return share
}

const maximumProjectAttachmentCipherBytes = 20 * 1024 * 1024
const maximumProjectAttachmentQuotaBytes = 500 * 1024 * 1024
const projectAttachmentIdPattern = /^[A-Za-z0-9_-]{8,128}$/u
const projectAttachmentHashPattern = /^[a-f0-9]{64}$/u

async function readBoundedAttachment(request: Request, maximumBytes: number): Promise<Uint8Array> {
  if (!request.body) throw new ApiError(400, 'attachment_missing', '附件内容为空。')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maximumBytes) {
        await reader.cancel()
        throw new ApiError(413, 'attachment_too_large', '附件超过 20 MiB 限额。')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const combined = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength }
  return combined
}

async function putProjectAttachment(request: Request, env: Environment,
  projectId: string, attachmentId: string): Promise<Response> {
  const user = await authenticate(request, env)
  const { share, role } = await requireProjectShare(env, projectId, user.userId)
  if (role === 'member') await requireProjectReader(env, projectId, user)
  if (!projectAttachmentIdPattern.test(attachmentId)) {
    throw new ApiError(400, 'invalid_attachment_id', '附件标识无效。')
  }
  const runId = request.headers.get('X-Project-Run-Id')?.trim()
  const requestId = request.headers.get('X-Project-Request-Id')?.trim() || null
  const kind = request.headers.get('X-Project-Attachment-Kind')
  const keyEpoch = Number(request.headers.get('X-Project-Key-Epoch'))
  const expectedHash = request.headers.get('X-Content-SHA256')?.toLowerCase()
  if (!runId || runId.length > 128 || !['input', 'artifact'].includes(kind ?? '')
    || !Number.isSafeInteger(keyEpoch) || keyEpoch !== share.key_epoch
    || !expectedHash || !projectAttachmentHashPattern.test(expectedHash)
    || (kind === 'input' && (!requestId || !projectAttachmentIdPattern.test(requestId)))
    || (kind === 'artifact' && requestId)) {
    throw new ApiError(400, 'invalid_attachment_scope', '附件项目或请求范围无效。')
  }
  if (kind === 'artifact') {
    await requireProjectPublisher(env, projectId, user)
  }
  const chat = await env.ACCOUNT_DB.prepare(
    `SELECT visibility, created_by_user_id AS createdByUserId FROM project_chats
     WHERE project_id = ? AND run_id = ?`
  ).bind(projectId, runId).first<{ visibility: string; createdByUserId: string | null }>()
  if (!chat || (chat.visibility === 'draft' && chat.createdByUserId !== user.userId)) {
    throw new ApiError(404, 'shared_chat_not_found', '共享 Chat 尚未发布。')
  }
  const advertisedSize = Number(request.headers.get('Content-Length'))
  if (!Number.isSafeInteger(advertisedSize) || advertisedSize <= 0
    || advertisedSize > maximumProjectAttachmentCipherBytes) {
    throw new ApiError(413, 'attachment_too_large', '附件超过 20 MiB 限额。')
  }
  const ciphertext = await readBoundedAttachment(request, maximumProjectAttachmentCipherBytes)
  if (ciphertext.byteLength !== advertisedSize
    || ciphertext.byteLength > maximumProjectAttachmentCipherBytes) {
    throw new ApiError(400, 'attachment_size_mismatch', '附件大小与请求不一致。')
  }
  const actualHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',
    ciphertext.buffer as ArrayBuffer))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('')
  if (actualHash !== expectedHash) {
    throw new ApiError(400, 'attachment_hash_mismatch', '附件传输校验失败。')
  }
  const existing = await env.ACCOUNT_DB.prepare(
    `SELECT project_id AS projectId, run_id AS runId, request_id AS requestId,
            kind, uploaded_by_device_id AS deviceId, cipher_size AS size,
            cipher_sha256 AS sha256 FROM project_attachments
     WHERE project_id = ? AND key_epoch = ? AND attachment_id = ?`
  ).bind(projectId, keyEpoch, attachmentId).first<{
    projectId: string; runId: string; requestId: string | null; kind: string
    deviceId: string; size: number; sha256: string
  }>()
  if (existing) {
    if (existing.projectId === projectId && existing.runId === runId && existing.requestId === requestId
      && existing.kind === kind && existing.deviceId === user.deviceId
      && existing.size === ciphertext.byteLength && existing.sha256 === actualHash) {
      return json({ attachmentId, size: existing.size })
    }
    throw new ApiError(409, 'attachment_id_conflict', '附件 ID 已用于其他内容。')
  }
  if (kind === 'input') {
    const count = await env.ACCOUNT_DB.prepare(
      `SELECT COUNT(*) AS count FROM project_attachments
       WHERE project_id = ? AND key_epoch = ? AND run_id = ? AND request_id = ? AND kind = 'input'`
    ).bind(projectId, keyEpoch, runId, requestId).first<{ count: number }>()
    if ((count?.count ?? 0) >= 4) throw new ApiError(413, 'attachment_limit', '一次最多发送 4 个附件。')
  }
  const used = await env.ACCOUNT_DB.prepare(
    'SELECT COALESCE(SUM(cipher_size), 0) AS bytes FROM project_attachments WHERE project_id = ? AND key_epoch = ?'
  ).bind(projectId, keyEpoch).first<{ bytes: number }>()
  if ((used?.bytes ?? 0) + ciphertext.byteLength > maximumProjectAttachmentQuotaBytes) {
    throw new ApiError(413, 'attachment_quota', '这个项目的共享附件空间已满。')
  }
  const storageKey = `project-shares/${projectId}/${keyEpoch}/${attachmentId}/${crypto.randomUUID()}`
  await env.PROJECT_ATTACHMENTS.put(storageKey, ciphertext, {
    customMetadata: { projectId, attachmentId, keyEpoch: String(keyEpoch) }
  })
  const now = isoNow()
  try {
    const inserted = await env.ACCOUNT_DB.prepare(
      `INSERT OR IGNORE INTO project_attachments
       (attachment_id, project_id, run_id, request_id, kind, status,
        uploaded_by_user_id, uploaded_by_device_id, key_epoch, storage_key,
        cipher_size, cipher_sha256, created_at, published_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE
         (SELECT COALESCE(SUM(cipher_size), 0) FROM project_attachments
          WHERE project_id = ? AND key_epoch = ?) + ? <= ?
         AND (? != 'input' OR (SELECT COUNT(*) FROM project_attachments
           WHERE project_id = ? AND key_epoch = ? AND run_id = ?
             AND request_id = ? AND kind = 'input') < 4)`
    ).bind(attachmentId, projectId, runId, requestId, kind,
      kind === 'artifact' ? 'published' : 'pending', user.userId, user.deviceId,
      keyEpoch, storageKey, ciphertext.byteLength, actualHash, now,
      kind === 'artifact' ? now : null, projectId, keyEpoch, ciphertext.byteLength,
      maximumProjectAttachmentQuotaBytes, kind, projectId, keyEpoch, runId, requestId).run()
    if ((inserted.meta.changes ?? 0) !== 1) {
      throw new ApiError(409, 'attachment_conflict_or_quota', '附件上传冲突或共享空间已满。')
    }
  } catch (error) {
    await env.PROJECT_ATTACHMENTS.delete(storageKey)
    throw error
  }
  return json({ attachmentId, size: ciphertext.byteLength }, { status: 201 })
}

async function getProjectAttachment(request: Request, env: Environment,
  projectId: string, attachmentId: string): Promise<Response> {
  const user = await authenticate(request, env)
  const { share, role } = await requireProjectShare(env, projectId, user.userId)
  if (role === 'member') await requireProjectReader(env, projectId, user)
  const attachment = await env.ACCOUNT_DB.prepare(
    `SELECT storage_key AS storageKey, status, uploaded_by_user_id AS uploadedByUserId,
            run_id AS runId, request_id AS requestId, kind,
            key_epoch AS keyEpoch, cipher_sha256 AS sha256, cipher_size AS size
     FROM project_attachments WHERE project_id = ? AND key_epoch = ? AND attachment_id = ?`
  ).bind(projectId, share.key_epoch, attachmentId).first<{
    storageKey: string; status: string; uploadedByUserId: string
    runId: string; requestId: string | null; kind: string
    keyEpoch: number; sha256: string; size: number
  }>()
  if (!attachment || attachment.keyEpoch !== share.key_epoch
    || (role === 'member' && attachment.status !== 'published'
      && attachment.uploadedByUserId !== user.userId)) {
    throw new ApiError(404, 'project_attachment_not_found', '没有找到这个共享附件。')
  }
  const object = await env.PROJECT_ATTACHMENTS.get(attachment.storageKey)
  if (!object || object.size !== attachment.size) {
    throw new ApiError(503, 'project_attachment_unavailable', '共享附件暂时不可用。')
  }
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(attachment.size),
      'X-Content-SHA256': attachment.sha256,
      'X-Project-Run-Id': attachment.runId,
      'X-Project-Request-Id': attachment.requestId ?? '',
      'X-Project-Attachment-Kind': attachment.kind,
      'X-Project-Key-Epoch': String(attachment.keyEpoch),
      'X-Uploaded-By-User-Id': attachment.uploadedByUserId,
      'Cache-Control': 'private, no-store'
    }
  })
}

async function deleteProjectAttachmentObjects(env: Environment, projectId: string): Promise<void> {
  let cursor: string | undefined
  do {
    const page = await env.PROJECT_ATTACHMENTS.list({ prefix: `project-shares/${projectId}/`, cursor })
    if (page.objects.length > 0) {
      await env.PROJECT_ATTACHMENTS.delete(page.objects.map((object) => object.key))
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  await env.ACCOUNT_DB.prepare('DELETE FROM project_attachments WHERE project_id = ?')
    .bind(projectId).run()
}

async function pruneProjectAttachmentObjects(env: Environment): Promise<void> {
  const closed = await env.ACCOUNT_DB.prepare(
    `SELECT DISTINCT project_id AS projectId FROM project_attachments
     WHERE project_id IN (SELECT project_id FROM project_shares WHERE status = 'closed') LIMIT 100`
  ).all<{ projectId: string }>()
  for (const project of closed.results) {
    await deleteProjectAttachmentObjects(env, project.projectId)
  }
  const orphaned = await env.ACCOUNT_DB.prepare(
    `SELECT storage_key AS storageKey
     FROM project_attachments WHERE status = 'pending' AND created_at < ? LIMIT 100`
  ).bind(isoNow(addSeconds(new Date(), -24 * 60 * 60))).all<{ storageKey: string }>()
  for (const attachment of orphaned.results) {
    await env.PROJECT_ATTACHMENTS.delete(attachment.storageKey)
    await env.ACCOUNT_DB.prepare(
      "DELETE FROM project_attachments WHERE storage_key = ? AND status = 'pending'"
    ).bind(attachment.storageKey).run()
  }
  const retired = await env.ACCOUNT_DB.prepare(
    `SELECT a.storage_key AS storageKey FROM project_attachments a
     JOIN project_shares s ON s.project_id = a.project_id
     WHERE a.key_epoch < s.key_epoch LIMIT 100`
  ).all<{ storageKey: string }>()
  for (const attachment of retired.results) {
    await env.PROJECT_ATTACHMENTS.delete(attachment.storageKey)
    await env.ACCOUNT_DB.prepare('DELETE FROM project_attachments WHERE storage_key = ?')
      .bind(attachment.storageKey).run()
  }
}

export async function publishProjectEvent(
  request: Request, env: Environment, projectId: string, relayOverride?: ProjectRelayAdministrationBinding
): Promise<Response> {
  const user = await authenticate(request, env)
  const share = await requireProjectPublisher(env, projectId, user)
  const input = publishProjectEventSchema.parse(await bodyJson(request))
  if (input.keyEpoch !== share.key_epoch) {
    throw new ApiError(409, 'key_epoch_mismatch', '项目密钥版本已变化。')
  }
  const result = await projectRelay(env, relayOverride).appendProjectEvent(projectId, {
    ...input, actorUserId: user.userId, sourceDeviceId: user.deviceId
  })
  if (result === 'conflict') throw new ApiError(409, 'event_id_conflict', '事件 ID 已用于其他内容。')
  if (result === 'snapshot-required') {
    throw new ApiError(409, 'snapshot_required', '项目事件历史已达到上限，需要建立新的恢复快照。')
  }
  return json({ event: result }, { status: 201 })
}

export async function listProjectEvents(
  request: Request, env: Environment, projectId: string, relayOverride?: ProjectRelayAdministrationBinding
): Promise<Response> {
  const user = await authenticate(request, env)
  const share = await requireProjectReader(env, projectId, user)
  const url = new URL(request.url)
  const afterRaw = url.searchParams.get('after') ?? '0'
  const limitRaw = url.searchParams.get('limit') ?? '100'
  if (!/^(0|[1-9]\d{0,12})$/u.test(afterRaw) || !/^[1-9]\d{0,2}$/u.test(limitRaw)) {
    throw new ApiError(400, 'invalid_cursor', '事件游标或页大小无效。')
  }
  const after = Number(afterRaw)
  const limit = Number(limitRaw)
  if (!Number.isSafeInteger(after) || limit > 100) {
    throw new ApiError(400, 'invalid_cursor', '事件游标或页大小无效。')
  }
  const events = await projectRelay(env, relayOverride).listProjectEvents(projectId, after, limit, share.key_epoch)
  return json({ events, nextCursor: events.at(-1)?.sequence ?? after })
}

export async function beginProjectBaseline(request: Request, env: Environment, projectId: string,
  relayOverride?: ProjectRelayAdministrationBinding): Promise<Response> {
  const user = await authenticate(request, env)
  const share = await requireProjectPublisher(env, projectId, user)
  const input = beginProjectBaselineSchema.parse(await bodyJson(request))
  if (input.keyEpoch !== share.key_epoch) {
    throw new ApiError(409, 'key_epoch_mismatch', '项目密钥版本已变化。')
  }
  const baseline = await projectRelay(env, relayOverride).beginProjectBaseline(
    projectId, input.baselineId, user.deviceId, input.keyEpoch, input.chunkCount
  )
  if (baseline === 'conflict') throw new ApiError(409, 'baseline_conflict', '当前 Mac 已有未完成的恢复快照。')
  return json({ baseline }, { status: 201 })
}

export async function putProjectBaselineChunk(
  request: Request, env: Environment, projectId: string, baselineId: string,
  relayOverride?: ProjectRelayAdministrationBinding
): Promise<Response> {
  const user = await authenticate(request, env)
  const share = await requireProjectPublisher(env, projectId, user)
  const input = putProjectBaselineChunkSchema.parse(await bodyJson(request))
  const result = await projectRelay(env, relayOverride).putProjectBaselineChunk(projectId, user.deviceId, share.key_epoch, {
    baselineId, index: input.index, envelope: input.envelope
  })
  if (result === 'not-found') throw new ApiError(404, 'baseline_not_found', '恢复快照不存在或已提交。')
  if (result === 'conflict') throw new ApiError(409, 'baseline_chunk_conflict', '快照分片已保存为其他内容。')
  return new Response(null, { status: 204 })
}

export async function commitProjectBaseline(
  request: Request, env: Environment, projectId: string, baselineId: string,
  relayOverride?: ProjectRelayAdministrationBinding
): Promise<Response> {
  const user = await authenticate(request, env)
  const share = await requireProjectPublisher(env, projectId, user)
  const result = await projectRelay(env, relayOverride).commitProjectBaseline(
    projectId, baselineId, user.deviceId, share.key_epoch
  )
  if (result === 'not-found') throw new ApiError(404, 'baseline_not_found', '恢复快照不存在。')
  if (result === 'incomplete') throw new ApiError(409, 'baseline_incomplete', '恢复快照尚有分片未上传。')
  return new Response(null, { status: 204 })
}

export async function listProjectBaselines(request: Request, env: Environment, projectId: string,
  relayOverride?: ProjectRelayAdministrationBinding): Promise<Response> {
  const user = await authenticate(request, env)
  const share = await requireProjectReader(env, projectId, user)
  const baselines = (await projectRelay(env, relayOverride).listProjectBaselines(projectId))
    .filter((entry) => entry.keyEpoch === share.key_epoch)
  return json({ baselines })
}

export async function listProjectBaselineChunks(
  request: Request, env: Environment, projectId: string, baselineId: string,
  relayOverride?: ProjectRelayAdministrationBinding
): Promise<Response> {
  const user = await authenticate(request, env)
  const share = await requireProjectReader(env, projectId, user)
  const baseline = (await projectRelay(env, relayOverride).listProjectBaselines(projectId))
    .find((entry) => entry.baselineId === baselineId && entry.keyEpoch === share.key_epoch)
  if (!baseline) throw new ApiError(404, 'baseline_not_found', '恢复快照不存在。')
  const url = new URL(request.url)
  const afterRaw = url.searchParams.get('after') ?? '-1'
  const limitRaw = url.searchParams.get('limit') ?? '100'
  if (!/^(?:-1|0|[1-9]\d{0,3})$/u.test(afterRaw) || !/^[1-9]\d{0,2}$/u.test(limitRaw)
    || Number(limitRaw) > 100) {
    throw new ApiError(400, 'invalid_cursor', '快照游标或页大小无效。')
  }
  const afterIndex = Number(afterRaw)
  const chunks = await projectRelay(env, relayOverride).listProjectBaselineChunks(projectId, baselineId,
    afterIndex, Number(limitRaw))
  return json({ chunks, nextIndex: chunks.at(-1)?.index ?? afterIndex })
}

type ProjectCommandRow = {
  command_id: string
  project_id: string
  run_id: string | null
  request_id: string | null
  type: string
  actor_user_id: string
  actor_display_name: string
  source_device_id: string
  target_host_id: string
  key_epoch: number
  permission_revision: number
  envelope: string
  status: string
  claimed_by_device_id: string | null
  lease_expires_at: string | null
  result_run_id: string | null
  error_code: string | null
  created_at: string
  updated_at: string
}

function publicProjectCommand(row: ProjectCommandRow) {
  return {
    commandId: row.command_id, projectId: row.project_id,
    runId: row.run_id, requestId: row.request_id, type: row.type,
    actorUserId: row.actor_user_id,
    authorSnapshot: { displayName: row.actor_display_name, avatarRef: null },
    sourceDeviceId: row.source_device_id, targetHostId: row.target_host_id,
    keyEpoch: row.key_epoch, permissionRevision: row.permission_revision,
    envelope: JSON.parse(row.envelope) as unknown, status: row.status,
    leaseExpiresAt: row.lease_expires_at, resultRunId: row.result_run_id,
    errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at
  }
}

async function projectCommandActorActive(env: Environment, share: ProjectShareRow,
  command: ProjectCommandRow): Promise<boolean> {
  if (share.key_epoch !== command.key_epoch || share.permission_revision !== command.permission_revision) return false
  const device = await env.ACCOUNT_DB.prepare(
    'SELECT 1 FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL'
  ).bind(command.source_device_id, command.actor_user_id).first()
  if (!device) return false
  if (share.owner_user_id === command.actor_user_id) return true
  const member = await env.ACCOUNT_DB.prepare(
    `SELECT 1 FROM project_memberships m JOIN project_device_grants g
       ON g.project_id = m.project_id AND g.user_id = m.user_id
     WHERE m.project_id = ? AND m.user_id = ? AND m.revoked_at IS NULL
       AND g.device_id = ? AND g.status = 'active' AND g.revoked_at IS NULL AND g.key_epoch = ?`
  ).bind(share.project_id, command.actor_user_id, command.source_device_id, share.key_epoch).first()
  return Boolean(member)
}

async function requireCommandHost(env: Environment, user: AuthenticatedUser,
  share: ProjectShareRow, targetHostId: string): Promise<void> {
  if (user.userId !== share.owner_user_id) throw new ApiError(404, 'project_share_not_found', '没有找到这个共享项目。')
  const host = await env.ACCOUNT_DB.prepare(
    'SELECT 1 FROM hosts WHERE id = ? AND user_id = ? AND device_id = ? AND revoked_at IS NULL'
  ).bind(targetHostId, user.userId, user.deviceId).first()
  if (!host) throw new ApiError(403, 'command_host_required', '这条命令属于另一台执行 Mac。')
}

async function heartbeatProjectHost(request: Request, env: Environment, projectId: string): Promise<Response> {
  const user = await authenticate(request, env)
  await requireProjectShare(env, projectId, user.userId, true)
  const host = await env.ACCOUNT_DB.prepare(
    'SELECT id FROM hosts WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL'
  ).bind(user.userId, user.deviceId).first<{ id: string }>()
  if (!host) throw new ApiError(403, 'command_host_required', '需要执行 Mac。')
  await env.ACCOUNT_DB.prepare(
    `INSERT INTO project_host_presence (project_id, host_id, last_heartbeat_at)
     VALUES (?, ?, ?) ON CONFLICT(project_id, host_id)
     DO UPDATE SET last_heartbeat_at = excluded.last_heartbeat_at`
  ).bind(projectId, host.id, isoNow()).run()
  return new Response(null, { status: 204 })
}

async function registerProjectChat(request: Request, env: Environment, projectId: string): Promise<Response> {
  const user = await authenticate(request, env)
  await requireProjectPublisher(env, projectId, user)
  const input = registerProjectChatSchema.parse(await bodyJson(request))
  if (input.visibility !== 'published') throw new ApiError(400, 'draft_registration_forbidden', '草稿由创建命令登记。')
  const host = await env.ACCOUNT_DB.prepare(
    'SELECT id FROM hosts WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL'
  ).bind(user.userId, user.deviceId).first<{ id: string }>()
  if (!host) throw new ApiError(403, 'command_host_required', '请在 Chat 的执行 Mac 上登记。')
  const now = isoNow()
  const inserted = await env.ACCOUNT_DB.prepare(
    `INSERT OR IGNORE INTO project_chats
       (run_id, project_id, execution_host_id, created_by_user_id, visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'published', ?, ?)`
  ).bind(input.runId, projectId, host.id, input.createdByUserId, now, now).run()
  if ((inserted.meta.changes ?? 0) === 0) {
    const existing = await env.ACCOUNT_DB.prepare(
      'SELECT project_id, execution_host_id FROM project_chats WHERE run_id = ?'
    ).bind(input.runId).first<{ project_id: string; execution_host_id: string }>()
    if (existing?.project_id !== projectId || existing.execution_host_id !== host.id) {
      throw new ApiError(409, 'chat_registration_conflict', 'Chat 已登记到其他项目或执行 Mac。')
    }
    await env.ACCOUNT_DB.prepare(
      "UPDATE project_chats SET visibility = 'published', updated_at = ? WHERE run_id = ?"
    ).bind(now, input.runId).run()
  }
  return json({ runId: input.runId, executionHostId: host.id })
}

async function submitProjectCommand(request: Request, env: Environment, projectId: string): Promise<Response> {
  const user = await authenticate(request, env)
  const { share, role } = await requireProjectShare(env, projectId, user.userId)
  if (role === 'member') await requireProjectReader(env, projectId, user)
  const input = submitProjectCommandSchema.parse(await bodyJson(request))
  if (input.keyEpoch !== share.key_epoch) throw new ApiError(409, 'key_epoch_mismatch', '项目密钥版本已变化。')
  let targetHostId = share.execution_host_id
  if (input.runId) {
    const chat = await env.ACCOUNT_DB.prepare(
      `SELECT execution_host_id AS executionHostId, created_by_user_id AS createdByUserId,
              visibility FROM project_chats WHERE project_id = ? AND run_id = ?`
    ).bind(projectId, input.runId).first<{
      executionHostId: string; createdByUserId: string | null; visibility: string
    }>()
    if (!chat) throw new ApiError(404, 'shared_chat_not_found', '共享 Chat 尚未同步。')
    targetHostId = chat.executionHostId
    if (chat.visibility === 'draft' && chat.createdByUserId !== user.userId) {
      throw new ApiError(404, 'shared_chat_not_found', '共享 Chat 尚未发布。')
    }
    if (['rename-chat', 'archive-chat'].includes(input.type)
      && role !== 'owner' && chat.createdByUserId !== user.userId) {
      throw new ApiError(403, 'chat_owner_required', '只能管理自己创建的 Chat。')
    }
    if (input.type === 'cancel-turn' || input.type === 'stop-turn') {
      const original = await env.ACCOUNT_DB.prepare(
        `SELECT actor_user_id FROM project_commands
         WHERE project_id = ? AND run_id = ? AND request_id = ? AND type = 'send-message'`
      ).bind(projectId, input.runId, input.requestId).first<{ actor_user_id: string }>()
      if (!original || (role !== 'owner' && original.actor_user_id !== user.userId)) {
        throw new ApiError(403, 'turn_owner_required', '只能控制自己提交的消息。')
      }
    }
  }
  const online = await env.ACCOUNT_DB.prepare(
    `SELECT 1 FROM project_host_presence p JOIN hosts h ON h.id = p.host_id
     WHERE p.project_id = ? AND p.host_id = ? AND h.revoked_at IS NULL
       AND p.last_heartbeat_at > ?`
  ).bind(projectId, targetHostId, isoNow(addSeconds(new Date(), -45))).first()
  if (!online) throw new ApiError(503, 'execution_host_offline', '执行 Mac 当前离线，请上线后重试。')
  const encoded = JSON.stringify(input.envelope)
  const now = isoNow()
  const actor = await env.ACCOUNT_DB.prepare('SELECT display_name FROM users WHERE id = ?')
    .bind(user.userId).first<{ display_name: string | null }>()
  const actorDisplayName = actor?.display_name?.trim() || `用户 ${user.userId.slice(0, 6)}`
  const inserted = await env.ACCOUNT_DB.prepare(
    `INSERT OR IGNORE INTO project_commands
       (command_id, project_id, run_id, request_id, type, actor_user_id, actor_display_name, source_device_id,
        target_host_id, key_epoch, permission_revision, envelope, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(input.commandId, projectId, input.runId, input.requestId, input.type,
    user.userId, actorDisplayName, user.deviceId, targetHostId, input.keyEpoch,
    share.permission_revision, encoded, now, now).run()
  const row = await env.ACCOUNT_DB.prepare(
    'SELECT * FROM project_commands WHERE command_id = ?'
  ).bind(input.commandId).first<ProjectCommandRow>()
  if (!row) throw new ApiError(409, 'command_request_conflict', '这条消息已由其他命令提交。')
  if ((inserted.meta.changes ?? 0) === 0 && (row.project_id !== projectId || row.type !== input.type
    || row.run_id !== input.runId || row.request_id !== input.requestId
    || row.actor_user_id !== user.userId || row.source_device_id !== user.deviceId
    || row.key_epoch !== input.keyEpoch || row.envelope !== encoded)) {
    throw new ApiError(409, 'command_id_conflict', '命令 ID 已用于其他操作。')
  }
  return json({ command: publicProjectCommand(row) },
    { status: (inserted.meta.changes ?? 0) > 0 ? 201 : 200 })
}

async function listHostProjectCommands(request: Request, env: Environment, projectId: string): Promise<Response> {
  const user = await authenticate(request, env)
  const { share } = await requireProjectShare(env, projectId, user.userId, true)
  const host = await env.ACCOUNT_DB.prepare(
    'SELECT id FROM hosts WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL'
  ).bind(user.userId, user.deviceId).first<{ id: string }>()
  if (!host) throw new ApiError(403, 'command_host_required', '需要执行 Mac。')
  await requireCommandHost(env, user, share, host.id)
  await expirePendingProjectCommands(env, projectId)
  await env.ACCOUNT_DB.prepare(
    `UPDATE project_commands SET status = 'interrupted', updated_at = ?
     WHERE project_id = ? AND target_host_id = ? AND status = 'claimed' AND lease_expires_at <= ?`
  ).bind(isoNow(), projectId, host.id, isoNow()).run()
  const rows = await env.ACCOUNT_DB.prepare(
    `SELECT c.* FROM project_commands c
     WHERE c.project_id = ? AND c.target_host_id = ? AND c.status = 'pending'
     ORDER BY c.created_at, c.command_id LIMIT 100`
  ).bind(projectId, host.id).all<ProjectCommandRow>()
  return json({ commands: rows.results.map(publicProjectCommand) })
}

async function listOwnProjectCommands(request: Request, env: Environment, projectId: string): Promise<Response> {
  const user = await authenticate(request, env)
  await requireProjectShare(env, projectId, user.userId)
  await requireProjectReader(env, projectId, user)
  await expirePendingProjectCommands(env, projectId)
  const rows = await env.ACCOUNT_DB.prepare(
    `SELECT c.* FROM project_commands c
     LEFT JOIN project_chats h ON h.project_id = c.project_id AND h.run_id = c.result_run_id
     WHERE c.project_id = ? AND c.actor_user_id = ? AND
       ((c.type = 'create-chat' AND c.status = 'completed' AND h.visibility = 'draft')
         OR (c.type = 'send-message' AND c.status IN ('pending', 'claimed')))
     ORDER BY c.created_at DESC, c.command_id DESC LIMIT 500`
  ).bind(projectId, user.userId).all<ProjectCommandRow>()
  return json({ commands: rows.results.map(publicProjectCommand) })
}

async function expirePendingProjectCommands(env: Environment, projectId: string): Promise<void> {
  await env.ACCOUNT_DB.prepare(
    `UPDATE project_commands SET status = 'interrupted', error_code = 'execution_host_offline',
       updated_at = ? WHERE project_id = ? AND status = 'pending' AND created_at <= ?`
  ).bind(isoNow(), projectId, isoNow(addSeconds(new Date(), -60))).run()
}

// Recheck the actor inside the same statement that changes a command's state.
// A separate read can race a membership or device revocation.
const activeCommandPredicate = `EXISTS (
  SELECT 1 FROM project_shares s JOIN devices d
    ON d.id = project_commands.source_device_id
   AND d.user_id = project_commands.actor_user_id AND d.revoked_at IS NULL
  WHERE s.project_id = project_commands.project_id AND s.status = 'active'
    AND s.key_epoch = project_commands.key_epoch
    AND s.permission_revision = project_commands.permission_revision
    AND (s.owner_user_id = project_commands.actor_user_id OR EXISTS (
      SELECT 1 FROM project_memberships m JOIN project_device_grants g
        ON g.project_id = m.project_id AND g.user_id = m.user_id
      WHERE m.project_id = s.project_id AND m.user_id = project_commands.actor_user_id
        AND m.revoked_at IS NULL AND g.device_id = project_commands.source_device_id
        AND g.status = 'active' AND g.revoked_at IS NULL AND g.key_epoch = s.key_epoch
    ))
)`

async function loadProjectCommand(env: Environment, projectId: string, commandId: string): Promise<ProjectCommandRow> {
  const row = await env.ACCOUNT_DB.prepare(
    'SELECT * FROM project_commands WHERE project_id = ? AND command_id = ?'
  ).bind(projectId, commandId).first<ProjectCommandRow>()
  if (!row) throw new ApiError(404, 'project_command_not_found', '命令不存在。')
  return row
}

async function getProjectCommand(request: Request, env: Environment,
  projectId: string, commandId: string): Promise<Response> {
  const user = await authenticate(request, env)
  const { role } = await requireProjectShare(env, projectId, user.userId)
  if (role === 'member') await requireProjectReader(env, projectId, user)
  await expirePendingProjectCommands(env, projectId)
  const row = await loadProjectCommand(env, projectId, commandId)
  if (role !== 'owner' && row.actor_user_id !== user.userId) {
    throw new ApiError(404, 'project_command_not_found', '命令不存在。')
  }
  return json({ command: publicProjectCommand(row) })
}

async function claimProjectCommand(request: Request, env: Environment,
  projectId: string, commandId: string): Promise<Response> {
  const user = await authenticate(request, env)
  const { share } = await requireProjectShare(env, projectId, user.userId, true)
  const row = await loadProjectCommand(env, projectId, commandId)
  await requireCommandHost(env, user, share, row.target_host_id)
  if (row.status === 'claimed' && row.claimed_by_device_id === user.deviceId
    && row.lease_expires_at && row.lease_expires_at > isoNow()
    && await projectCommandActorActive(env, share, row)) {
    return json({ command: publicProjectCommand(row) })
  }
  if (row.status !== 'pending' || row.created_at <= isoNow(addSeconds(new Date(), -60))
    || !await projectCommandActorActive(env, share, row)) {
    throw new ApiError(409, 'command_not_claimable', '命令已处理或发起者授权已变化。')
  }
  const now = new Date()
  const claimed = await env.ACCOUNT_DB.prepare(
    `UPDATE project_commands SET status = 'claimed', claimed_by_device_id = ?,
       lease_expires_at = ?, updated_at = ? WHERE command_id = ? AND status = 'pending'
       AND created_at > ? AND ${activeCommandPredicate}
     RETURNING *`
  ).bind(user.deviceId, isoNow(addSeconds(now, 45)), isoNow(now), commandId,
    isoNow(addSeconds(now, -60))).first<ProjectCommandRow>()
  if (!claimed) throw new ApiError(409, 'command_not_claimable', '命令已被其他执行机领取。')
  return json({ command: publicProjectCommand(claimed) })
}

async function renewProjectCommand(request: Request, env: Environment,
  projectId: string, commandId: string): Promise<Response> {
  const user = await authenticate(request, env)
  const { share } = await requireProjectShare(env, projectId, user.userId, true)
  const row = await loadProjectCommand(env, projectId, commandId)
  await requireCommandHost(env, user, share, row.target_host_id)
  if (row.status !== 'claimed' || row.claimed_by_device_id !== user.deviceId
    || !row.lease_expires_at || row.lease_expires_at <= isoNow()
    || !await projectCommandActorActive(env, share, row)) {
    throw new ApiError(409, 'command_lease_expired', '命令授权已失效，执行机必须停止。')
  }
  const expiresAt = isoNow(addSeconds(new Date(), 45))
  const renewed = await env.ACCOUNT_DB.prepare(
    `UPDATE project_commands SET lease_expires_at = ?, updated_at = ?
     WHERE command_id = ? AND status = 'claimed' AND claimed_by_device_id = ?
       AND lease_expires_at > ? AND ${activeCommandPredicate}`
  ).bind(expiresAt, isoNow(), commandId, user.deviceId, isoNow()).run()
  if ((renewed.meta.changes ?? 0) !== 1) {
    throw new ApiError(409, 'command_lease_expired', '命令授权已失效，执行机必须停止。')
  }
  return json({ leaseExpiresAt: expiresAt })
}

async function completeProjectCommand(request: Request, env: Environment,
  projectId: string, commandId: string): Promise<Response> {
  const user = await authenticate(request, env)
  const { share } = await requireProjectShare(env, projectId, user.userId, true)
  const row = await loadProjectCommand(env, projectId, commandId)
  await requireCommandHost(env, user, share, row.target_host_id)
  const input = completeProjectCommandSchema.parse(await bodyJson(request))
  if (row.status !== 'claimed' || row.claimed_by_device_id !== user.deviceId
    || !row.lease_expires_at || row.lease_expires_at <= isoNow()
    || !await projectCommandActorActive(env, share, row)) {
    throw new ApiError(409, 'command_lease_expired', '命令授权已失效，不能确认完成。')
  }
  if (row.type === 'create-chat' && input.status === 'completed' && !input.resultRunId) {
    throw new ApiError(400, 'result_run_required', '新建 Chat 必须返回 Chat ID。')
  }
  if (row.type === 'send-message' && input.resultRunId && input.resultRunId !== row.run_id) {
    throw new ApiError(400, 'result_run_mismatch', '消息所属 Chat 不匹配。')
  }
  if (row.type === 'send-message' && input.status === 'completed' && input.resultRunId !== row.run_id) {
    throw new ApiError(400, 'result_run_required', '消息完成后必须确认 Chat ID。')
  }
  const now = isoNow()
  const statements = [env.ACCOUNT_DB.prepare(
    `UPDATE project_commands SET status = ?, result_run_id = ?, error_code = ?,
       lease_expires_at = NULL, updated_at = ?
     WHERE command_id = ? AND status = 'claimed' AND claimed_by_device_id = ?
       AND lease_expires_at > ? AND ${activeCommandPredicate}`
  ).bind(input.status, input.resultRunId, input.errorCode, now, commandId, user.deviceId, now)]
  if (row.type === 'create-chat' && input.status === 'completed' && input.resultRunId) {
    statements.push(env.ACCOUNT_DB.prepare(
      `INSERT INTO project_chats
       (run_id, project_id, execution_host_id, created_by_user_id, visibility, created_at, updated_at)
       SELECT ?, ?, ?, ?, 'draft', ?, ? WHERE EXISTS
         (SELECT 1 FROM project_commands WHERE command_id = ? AND status = 'completed')`
    ).bind(input.resultRunId, projectId, row.target_host_id, row.actor_user_id, now, now, commandId))
  }
  if (row.type === 'send-message' && row.run_id
    && (input.status === 'completed' || (input.status === 'failed' && input.resultRunId === row.run_id))) {
    statements.push(env.ACCOUNT_DB.prepare(
      `UPDATE project_chats SET visibility = 'published', updated_at = ?
       WHERE run_id = ? AND project_id = ? AND EXISTS
         (SELECT 1 FROM project_commands WHERE command_id = ? AND status IN ('completed', 'failed')
            AND result_run_id = ?)`
    ).bind(now, row.run_id, projectId, commandId, row.run_id))
    statements.push(env.ACCOUNT_DB.prepare(
      `UPDATE project_attachments SET status = 'published', published_at = ?
       WHERE project_id = ? AND run_id = ? AND request_id = ? AND kind = 'input'
         AND status = 'pending' AND key_epoch = ? AND uploaded_by_user_id = ?
         AND EXISTS (SELECT 1 FROM project_commands
                     WHERE command_id = ? AND status IN ('completed', 'failed')
                       AND result_run_id = ?)`
    ).bind(now, projectId, row.run_id, row.request_id, row.key_epoch,
      row.actor_user_id, commandId, row.run_id))
  }
  const results = await env.ACCOUNT_DB.batch(statements)
  if ((results[0].meta.changes ?? 0) !== 1) {
    throw new ApiError(409, 'command_lease_expired', '命令授权已失效，不能确认完成。')
  }
  return new Response(null, { status: 204 })
}

async function updateProjectExecutionHost(request: Request, env: Environment, projectId: string): Promise<Response> {
  const user = await authenticate(request, env)
  await requireProjectShare(env, projectId, user.userId, true)
  const { executionHostId } = updateProjectExecutionHostSchema.parse(await bodyJson(request))
  const host = await env.ACCOUNT_DB.prepare(
    'SELECT id FROM hosts WHERE id = ? AND user_id = ? AND revoked_at IS NULL'
  ).bind(executionHostId, user.userId).first()
  if (!host) throw new ApiError(404, 'execution_host_not_found', '没有找到这台执行 Mac。')
  await env.ACCOUNT_DB.prepare(
    `UPDATE project_shares SET execution_host_id = ?, permission_revision = permission_revision + 1,
       updated_at = ? WHERE project_id = ? AND owner_user_id = ? AND status = 'active'
       AND execution_host_id != ?`
  ).bind(executionHostId, isoNow(), projectId, user.userId, executionHostId).run()
  await env.ACCOUNT_DB.prepare(
    `INSERT OR IGNORE INTO project_share_publishers (project_id, host_id, created_at) VALUES (?, ?, ?)`
  ).bind(projectId, executionHostId, isoNow()).run()
  return getProjectShare(request, env, projectId)
}

async function createProjectInvitation(request: Request, env: Environment, projectId: string): Promise<Response> {
  const user = await authenticate(request, env)
  await requireProjectShare(env, projectId, user.userId, true)
  const { email } = createProjectInvitationSchema.parse(await bodyJson(request))
  const ownIdentity = await env.ACCOUNT_DB.prepare(
    `SELECT 1 FROM users WHERE id = ? AND primary_email = ?
     UNION SELECT 1 FROM auth_identities WHERE user_id = ? AND email = ? LIMIT 1`
  ).bind(user.userId, email, user.userId, email).first()
  if (ownIdentity) throw new ApiError(409, 'self_invitation', '不能邀请自己。')
  await rateLimit(env, `project-invite:${user.userId}`, 50, new Date())
  const count = await env.ACCOUNT_DB.prepare(
    `SELECT (SELECT COUNT(*) FROM project_memberships WHERE project_id = ? AND revoked_at IS NULL)
          + (SELECT COUNT(*) FROM project_invitations WHERE project_id = ? AND status = 'pending' AND expires_at > ?) AS count`
  ).bind(projectId, projectId, isoNow()).first<{ count: number }>()
  if ((count?.count ?? 0) >= MAX_PROJECT_MEMBERS) {
    throw new ApiError(409, 'project_member_limit', '项目成员或待接受邀请已达上限。')
  }
  const now = new Date()
  const createdAt = isoNow(now)
  await env.ACCOUNT_DB.prepare(
    `UPDATE project_invitations SET status = 'revoked', revoked_at = ?
     WHERE project_id = ? AND invited_email = ? AND status = 'pending' AND expires_at <= ?`
  ).bind(createdAt, projectId, email, createdAt).run()
  const token = randomToken('fuddy_invite')
  const id = crypto.randomUUID()
  const expiresAt = isoNow(addSeconds(now, PROJECT_INVITATION_SECONDS))
  const inserted = await env.ACCOUNT_DB.prepare(
    `INSERT OR IGNORE INTO project_invitations
       (id, project_id, invited_email, token_hash, invited_by_user_id, status, expires_at, created_at)
     SELECT ?, s.project_id, ?, ?, ?, 'pending', ?, ?
     FROM project_shares s WHERE s.project_id = ? AND s.owner_user_id = ? AND s.status = 'active'`
  ).bind(id, email, await hmac(token, env.SESSION_TOKEN_PEPPER), user.userId,
    expiresAt, createdAt, projectId, user.userId).run()
  if ((inserted.meta.changes ?? 0) === 0) throw new ApiError(409, 'invitation_exists', '此邮箱已有待接受的邀请。')
  return json({ invitation: { id, projectId, email, expiresAt, status: 'pending', token } }, { status: 201 })
}

async function listProjectInvitations(request: Request, env: Environment, projectId: string): Promise<Response> {
  const user = await authenticate(request, env)
  await requireProjectShare(env, projectId, user.userId, true)
  const rows = await env.ACCOUNT_DB.prepare(
    `SELECT id, project_id AS projectId, invited_email AS email, status, expires_at AS expiresAt, created_at AS createdAt
     FROM project_invitations WHERE project_id = ? ORDER BY created_at DESC LIMIT 100`
  ).bind(projectId).all()
  return json({ invitations: rows.results })
}

async function revokeProjectInvitation(request: Request, env: Environment, projectId: string, id: string): Promise<Response> {
  const user = await authenticate(request, env)
  await requireProjectShare(env, projectId, user.userId, true)
  const result = await env.ACCOUNT_DB.prepare(
    `UPDATE project_invitations SET status = 'revoked', revoked_at = ?
     WHERE id = ? AND project_id = ? AND status = 'pending'`
  ).bind(isoNow(), id, projectId).run()
  if ((result.meta.changes ?? 0) === 0) throw new ApiError(404, 'invitation_not_found', '邀请不存在或已失效。')
  return new Response(null, { status: 204 })
}

async function acceptProjectInvitation(request: Request, env: Environment): Promise<Response> {
  const user = await authenticate(request, env)
  const { token } = acceptProjectInvitationSchema.parse(await bodyJson(request))
  const tokenHash = await hmac(token, env.SESSION_TOKEN_PEPPER)
  const invitation = await env.ACCOUNT_DB.prepare(
    `SELECT i.project_id AS projectId, i.invited_email AS email, i.status,
            i.expires_at AS expiresAt, i.accepted_by_user_id AS acceptedByUserId,
            s.owner_user_id AS ownerUserId, s.status AS projectStatus
     FROM project_invitations i JOIN project_shares s ON s.project_id = i.project_id
     WHERE i.token_hash = ?`
  ).bind(tokenHash).first<{
    projectId: string; email: string; status: string; expiresAt: string
    acceptedByUserId: string | null; ownerUserId: string; projectStatus: string
  }>()
  if (!invitation || invitation.projectStatus !== 'active' || invitation.ownerUserId === user.userId) {
    throw new ApiError(404, 'invitation_not_found', '邀请不存在或已失效。')
  }
  const verifiedEmail = await env.ACCOUNT_DB.prepare(
    `SELECT 1 FROM users WHERE id = ? AND primary_email = ?
     UNION SELECT 1 FROM auth_identities WHERE user_id = ? AND email = ? LIMIT 1`
  ).bind(user.userId, invitation.email, user.userId, invitation.email).first()
  if (!verifiedEmail) throw new ApiError(403, 'invitation_account_mismatch', '请用受邀邮箱对应的账户登录。')
  if (invitation.status === 'accepted' && invitation.acceptedByUserId === user.userId) {
    await requireProjectShare(env, invitation.projectId, user.userId)
    return json({ projectId: invitation.projectId, role: 'member' })
  }
  if (invitation.status !== 'pending' || invitation.expiresAt <= isoNow()) {
    throw new ApiError(404, 'invitation_not_found', '邀请不存在或已失效。')
  }
  const now = isoNow()
  await env.ACCOUNT_DB.batch([
    env.ACCOUNT_DB.prepare(
      `INSERT INTO project_memberships (project_id, user_id, role, created_at)
       SELECT i.project_id, ?, 'member', ? FROM project_invitations i
       JOIN project_shares s ON s.project_id = i.project_id
       WHERE i.token_hash = ? AND i.status = 'pending' AND i.expires_at > ? AND s.status = 'active'
         AND (EXISTS (SELECT 1 FROM users u WHERE u.id = ? AND u.primary_email = i.invited_email)
           OR EXISTS (SELECT 1 FROM auth_identities a WHERE a.user_id = ? AND a.email = i.invited_email))
       ON CONFLICT(project_id, user_id) DO UPDATE SET revoked_at = NULL`
    ).bind(user.userId, now, tokenHash, now, user.userId, user.userId),
    env.ACCOUNT_DB.prepare(
      `UPDATE project_shares SET permission_revision = permission_revision + 1, updated_at = ?
       WHERE project_id = ? AND status = 'active' AND EXISTS
         (SELECT 1 FROM project_invitations WHERE token_hash = ? AND status = 'pending' AND expires_at > ?)`
    ).bind(now, invitation.projectId, tokenHash, now),
    env.ACCOUNT_DB.prepare(
      `UPDATE project_invitations SET status = 'accepted', accepted_by_user_id = ?, accepted_at = ?
       WHERE token_hash = ? AND status = 'pending' AND expires_at > ?
         AND EXISTS (SELECT 1 FROM project_memberships m WHERE m.project_id = project_invitations.project_id
           AND m.user_id = ? AND m.revoked_at IS NULL)
         AND (EXISTS (SELECT 1 FROM users u WHERE u.id = ? AND u.primary_email = project_invitations.invited_email)
           OR EXISTS (SELECT 1 FROM auth_identities a WHERE a.user_id = ? AND a.email = project_invitations.invited_email))`
    ).bind(user.userId, now, tokenHash, now, user.userId, user.userId, user.userId)
  ])
  await requireProjectShare(env, invitation.projectId, user.userId)
  return json({ projectId: invitation.projectId, role: 'member' }, { status: 201 })
}

async function listProjectMembers(request: Request, env: Environment, projectId: string): Promise<Response> {
  const user = await authenticate(request, env)
  await requireProjectShare(env, projectId, user.userId, true)
  const rows = await env.ACCOUNT_DB.prepare(
    `SELECT m.user_id AS userId, u.display_name AS displayName, m.created_at AS joinedAt
     FROM project_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.project_id = ? AND m.revoked_at IS NULL ORDER BY m.created_at ASC`
  ).bind(projectId).all()
  return json({ members: rows.results })
}

async function requestProjectDeviceGrant(request: Request, env: Environment, projectId: string): Promise<Response> {
  const user = await authenticate(request, env)
  const { share } = await requireProjectShare(env, projectId, user.userId)
  const device = await env.ACCOUNT_DB.prepare(
    'SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL'
  ).bind(user.deviceId, user.userId).first()
  if (!device) throw new ApiError(403, 'device_required', '当前设备已失效。')
  const now = isoNow()
  const id = crypto.randomUUID()
  const inserted = await env.ACCOUNT_DB.prepare(
    `INSERT INTO project_device_grants
       (id, project_id, user_id, device_id, status, key_epoch, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
     ON CONFLICT(project_id, device_id) DO UPDATE SET
       id = excluded.id, user_id = excluded.user_id, status = 'pending',
       key_epoch = excluded.key_epoch, wrapped_project_key = NULL,
       created_at = excluded.created_at, updated_at = excluded.updated_at, revoked_at = NULL
     WHERE project_device_grants.status = 'revoked' OR project_device_grants.key_epoch != excluded.key_epoch`
  ).bind(id, projectId, user.userId, user.deviceId, share.key_epoch, now, now).run()
  const grant = await env.ACCOUNT_DB.prepare(
    `SELECT id, status, key_epoch AS keyEpoch, wrapped_project_key AS wrappedProjectKey
     FROM project_device_grants
     WHERE project_id = ? AND device_id = ? AND user_id = ?`
  ).bind(projectId, user.deviceId, user.userId).first<{
    id: string; status: string; keyEpoch: number; wrappedProjectKey: string | null
  }>()
  if (!grant) throw new ApiError(409, 'grant_unavailable', '设备授权尚未建立。')
  return json({ grant: {
    ...grant, wrappedProjectKey: grant.status === 'active' ? grant.wrappedProjectKey : null
  } }, { status: (inserted.meta.changes ?? 0) > 0 ? 201 : 200 })
}

async function getOwnProjectDeviceGrant(request: Request, env: Environment, projectId: string): Promise<Response> {
  const user = await authenticate(request, env)
  const { share } = await requireProjectShare(env, projectId, user.userId)
  const grant = await env.ACCOUNT_DB.prepare(
    `SELECT g.id, g.status, g.key_epoch AS keyEpoch, g.wrapped_project_key AS wrappedProjectKey
     FROM project_device_grants g JOIN devices d ON d.id = g.device_id
     WHERE g.project_id = ? AND g.device_id = ? AND g.user_id = ?
       AND d.revoked_at IS NULL AND g.status != 'revoked' AND g.key_epoch = ?`
  ).bind(projectId, user.deviceId, user.userId, share.key_epoch)
    .first<{ id: string; status: string; keyEpoch: number; wrappedProjectKey: string | null }>()
  if (!grant) throw new ApiError(404, 'project_grant_not_found', '没有找到设备授权。')
  return json({ grant: {
    ...grant, wrappedProjectKey: grant.status === 'active' ? grant.wrappedProjectKey : null
  } })
}

async function listPendingProjectDeviceGrants(request: Request, env: Environment, projectId: string): Promise<Response> {
  const user = await authenticate(request, env)
  const { share } = await requireProjectShare(env, projectId, user.userId, true)
  const publisher = await env.ACCOUNT_DB.prepare(
    `SELECT 1 FROM project_share_publishers p JOIN hosts h ON h.id = p.host_id
     WHERE p.project_id = ? AND h.user_id = ? AND h.device_id = ? AND h.revoked_at IS NULL`
  ).bind(projectId, user.userId, user.deviceId).first()
  if (!publisher) {
    throw new ApiError(403, 'project_publisher_required', '请在已登记的所有者 Mac 上完成设备授权。')
  }
  const rows = await env.ACCOUNT_DB.prepare(
    `SELECT g.id, g.user_id AS userId, g.device_id AS deviceId,
            d.public_key AS publicKey, d.name AS deviceName, g.key_epoch AS keyEpoch,
            g.created_at AS createdAt
     FROM project_device_grants g JOIN devices d ON d.id = g.device_id
     WHERE g.project_id = ? AND g.status = 'pending' AND g.key_epoch = ?
       AND (g.user_id = ? OR EXISTS (SELECT 1 FROM project_memberships m
         WHERE m.project_id = g.project_id AND m.user_id = g.user_id AND m.revoked_at IS NULL))
       AND d.revoked_at IS NULL
     ORDER BY g.created_at ASC LIMIT 100`
  ).bind(projectId, share.key_epoch, user.userId).all()
  return json({ grants: rows.results })
}

async function completeProjectDeviceGrant(
  request: Request, env: Environment, projectId: string, grantId: string
): Promise<Response> {
  const user = await authenticate(request, env)
  const { share } = await requireProjectShare(env, projectId, user.userId, true)
  const publisher = await env.ACCOUNT_DB.prepare(
    `SELECT 1 FROM project_share_publishers p JOIN hosts h ON h.id = p.host_id
     WHERE p.project_id = ? AND h.user_id = ? AND h.device_id = ? AND h.revoked_at IS NULL`
  ).bind(projectId, user.userId, user.deviceId).first()
  if (!publisher) {
    throw new ApiError(403, 'project_publisher_required', '请在已登记的所有者 Mac 上完成设备授权。')
  }
  const input = completeProjectDeviceGrantSchema.parse(await bodyJson(request))
  if (input.keyEpoch !== share.key_epoch) throw new ApiError(409, 'key_epoch_mismatch', '项目密钥版本已变化。')
  const updated = await env.ACCOUNT_DB.prepare(
    `UPDATE project_device_grants SET status = 'active', wrapped_project_key = ?, updated_at = ?
     WHERE id = ? AND project_id = ? AND status = 'pending' AND key_epoch = ?
       AND (project_device_grants.user_id = ? OR EXISTS (SELECT 1 FROM project_memberships m
         WHERE m.project_id = ? AND m.user_id = project_device_grants.user_id AND m.revoked_at IS NULL))
       AND EXISTS (SELECT 1 FROM devices d WHERE d.id = project_device_grants.device_id AND d.revoked_at IS NULL)
       AND EXISTS (SELECT 1 FROM project_shares s WHERE s.project_id = ?
         AND s.status = 'active' AND s.key_epoch = ?)`
  ).bind(input.wrappedProjectKey, isoNow(), grantId, projectId, input.keyEpoch,
    user.userId, projectId, projectId, input.keyEpoch).run()
  if ((updated.meta.changes ?? 0) === 0) throw new ApiError(409, 'grant_not_pending', '设备授权已失效或已完成。')
  return new Response(null, { status: 204 })
}

async function removeProjectMember(request: Request, env: Environment, projectId: string, memberId: string): Promise<Response> {
  const user = await authenticate(request, env)
  if (user.userId !== memberId) await requireProjectShare(env, projectId, user.userId, true)
  else await requireProjectShare(env, projectId, user.userId)
  const now = isoNow()
  const result = await env.ACCOUNT_DB.batch([
    env.ACCOUNT_DB.prepare(
      `UPDATE project_device_grants SET
         status = CASE WHEN user_id = ? THEN 'revoked' ELSE 'pending' END,
         key_epoch = CASE WHEN user_id = ? THEN key_epoch ELSE key_epoch + 1 END,
         wrapped_project_key = NULL,
         revoked_at = CASE WHEN user_id = ? THEN ? ELSE NULL END,
         updated_at = ? WHERE project_id = ? AND status != 'revoked'
         AND EXISTS (SELECT 1 FROM project_memberships WHERE project_id = ?
           AND user_id = ? AND revoked_at IS NULL)`
    ).bind(memberId, memberId, memberId, now, now, projectId, projectId, memberId),
    env.ACCOUNT_DB.prepare(
      `UPDATE project_shares SET permission_revision = permission_revision + 1,
         key_epoch = key_epoch + 1, key_authority_host_id = execution_host_id, updated_at = ?
       WHERE project_id = ? AND status = 'active' AND EXISTS
         (SELECT 1 FROM project_memberships WHERE project_id = ? AND user_id = ? AND revoked_at IS NULL)`
    ).bind(now, projectId, projectId, memberId),
    env.ACCOUNT_DB.prepare(
      'UPDATE project_memberships SET revoked_at = ? WHERE project_id = ? AND user_id = ? AND revoked_at IS NULL'
    ).bind(now, projectId, memberId)
  ])
  if ((result[2].meta.changes ?? 0) === 0) throw new ApiError(404, 'project_member_not_found', '项目成员不存在。')
  return new Response(null, { status: 204 })
}

async function closeProjectShare(request: Request, env: Environment, projectId: string): Promise<Response> {
  const user = await authenticate(request, env)
  await requireProjectShare(env, projectId, user.userId, true)
  const now = isoNow()
  await env.ACCOUNT_DB.batch([
    env.ACCOUNT_DB.prepare(
      `UPDATE project_shares SET status = 'closed', permission_revision = permission_revision + 1,
         key_epoch = key_epoch + 1, closed_at = ?, updated_at = ?
       WHERE project_id = ? AND owner_user_id = ? AND status = 'active'`
    ).bind(now, now, projectId, user.userId),
    env.ACCOUNT_DB.prepare(
      `UPDATE project_invitations SET status = 'revoked', revoked_at = ?
       WHERE project_id = ? AND status = 'pending'`
    ).bind(now, projectId),
    env.ACCOUNT_DB.prepare(
      'UPDATE project_memberships SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL'
    ).bind(now, projectId),
    env.ACCOUNT_DB.prepare(
      `UPDATE project_device_grants SET status = 'revoked', wrapped_project_key = NULL,
         revoked_at = ?, updated_at = ? WHERE project_id = ? AND status != 'revoked'`
    ).bind(now, now, projectId)
  ])
  // Authorization closes immediately. Cleanup can retry from the scheduled job.
  await deleteProjectAttachmentObjects(env, projectId).catch(() => undefined)
  return new Response(null, { status: 204 })
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
            d.name AS deviceName, d.public_key AS publicKey, d.platform AS platform
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
  const relayGrants = (await env.ACCOUNT_DB.prepare(
        `SELECT g.id, g.device_id AS deviceId, s.relay_account_id AS relayAccountId
         FROM device_grants g JOIN sync_spaces s ON s.id = g.space_id
         WHERE g.device_id = ? AND g.status != 'revoked' AND s.relay_account_id IS NOT NULL`
      ).bind(deviceId).all<{ id: string; deviceId: string; relayAccountId: string }>()).results
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
      `UPDATE project_device_grants SET status = 'revoked', wrapped_project_key = NULL,
         revoked_at = ?, updated_at = ? WHERE device_id = ? AND status != 'revoked'`
    ).bind(timestamp, timestamp, deviceId),
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
    ...relayAccountRevocationStatements(env, relaySpaces, timestamp),
    ...relayDeviceRevocationStatements(env, relayGrants, timestamp)
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
  if (!device || !['ios', 'macos'].includes(device.platform)) throw new ApiError(403, 'device_required', '设备无法申请连接 Mac。')
  const ownSpace = await env.ACCOUNT_DB.prepare('SELECT 1 FROM sync_spaces s JOIN hosts h ON h.id=s.host_id WHERE s.id=? AND h.device_id=?')
    .bind(spaceId, user.deviceId).first()
  if (ownSpace) throw new ApiError(409, 'self_enrollment', '无需连接本机同步空间。')
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
  if (request.method === 'POST' && parts.join('/') === 'v1/chat-titles') {
    const user = await authenticate(request, env)
    const { prompt } = z.object({ prompt: z.string().trim().min(1).max(chatTitleInputLimit) }).strict()
      .parse(await bodyJson(request))
    if (!env.AI) throw new ApiError(503, 'title_unavailable', '标题生成暂时不可用。')
    await rateLimit(env, `chat-title:${user.userId}`, 60, new Date())
    try {
      const title = await generateChatTitle(env.AI, prompt)
      if (title) return json({ title })
    } catch {
      // Model errors may contain prompt data. Keep them out of account API logs.
    }
    throw new ApiError(503, 'title_unavailable', '标题生成暂时不可用。')
  }
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
  if (parts[0] === 'v1' && parts[1] === 'project-shares') {
    if (request.headers.get('X-Fuddy-Project-Sharing-Version') !== '1') {
      throw new ApiError(426, 'project_sharing_upgrade_required', '请升级 Fuddy 后使用项目共享。')
    }
    if (parts.length === 2 && request.method === 'POST') return createProjectShare(request, env)
    if (parts.length === 2 && request.method === 'GET') return listProjectShares(request, env)
    if (parts[2] && parts.length === 3 && request.method === 'GET') return getProjectShare(request, env, parts[2])
    if (parts[2] && parts.length === 3 && request.method === 'DELETE') return closeProjectShare(request, env, parts[2])
    if (parts[2] && parts[3] === 'events' && parts.length === 4 && request.method === 'POST') {
      return publishProjectEvent(request, env, parts[2])
    }
    if (parts[2] && parts[3] === 'attachments' && parts[4] && parts.length === 5) {
      if (request.method === 'PUT') return putProjectAttachment(request, env, parts[2], parts[4])
      if (request.method === 'GET') return getProjectAttachment(request, env, parts[2], parts[4])
    }
    if (parts[2] && parts[3] === 'events' && parts.length === 4 && request.method === 'GET') {
      return listProjectEvents(request, env, parts[2])
    }
    if (parts[2] && parts[3] === 'baselines' && parts.length === 4 && request.method === 'POST') {
      return beginProjectBaseline(request, env, parts[2])
    }
    if (parts[2] && parts[3] === 'baselines' && parts.length === 4 && request.method === 'GET') {
      return listProjectBaselines(request, env, parts[2])
    }
    if (parts[2] && parts[3] === 'baselines' && parts[4] && parts[5] === 'chunks'
      && parts.length === 6 && request.method === 'PUT') {
      return putProjectBaselineChunk(request, env, parts[2], parts[4])
    }
    if (parts[2] && parts[3] === 'baselines' && parts[4] && parts[5] === 'chunks'
      && parts.length === 6 && request.method === 'GET') {
      return listProjectBaselineChunks(request, env, parts[2], parts[4])
    }
    if (parts[2] && parts[3] === 'baselines' && parts[4] && parts[5] === 'commit'
      && parts.length === 6 && request.method === 'POST') {
      return commitProjectBaseline(request, env, parts[2], parts[4])
    }
    if (parts[2] && parts[3] === 'execution-host' && parts.length === 4 && request.method === 'POST') {
      return updateProjectExecutionHost(request, env, parts[2])
    }
    if (parts[2] && parts[3] === 'publishers' && parts.length === 4 && request.method === 'GET') {
      return listProjectPublishers(request, env, parts[2])
    }
    if (parts[2] && parts[3] === 'publishers' && parts[4] === 'self'
      && parts.length === 5 && request.method === 'POST') {
      return registerProjectPublisher(request, env, parts[2])
    }
    if (parts[2] && parts[3] === 'chats' && parts.length === 4 && request.method === 'POST') {
      return registerProjectChat(request, env, parts[2])
    }
    if (parts[2] && parts[3] === 'commands' && parts.length === 4 && request.method === 'POST') {
      return submitProjectCommand(request, env, parts[2])
    }
    if (parts[2] && parts[3] === 'host-heartbeat' && parts.length === 4 && request.method === 'POST') {
      return heartbeatProjectHost(request, env, parts[2])
    }
    if (parts[2] && parts[3] === 'commands' && parts.length === 4 && request.method === 'GET') {
      return new URL(request.url).searchParams.get('mine') === '1'
        ? listOwnProjectCommands(request, env, parts[2])
        : listHostProjectCommands(request, env, parts[2])
    }
    if (parts[2] && parts[3] === 'commands' && parts[4]
      && parts.length === 5 && request.method === 'GET') {
      return getProjectCommand(request, env, parts[2], parts[4])
    }
    if (parts[2] && parts[3] === 'commands' && parts[4] && parts[5] === 'claim'
      && parts.length === 6 && request.method === 'POST') {
      return claimProjectCommand(request, env, parts[2], parts[4])
    }
    if (parts[2] && parts[3] === 'commands' && parts[4] && parts[5] === 'renew'
      && parts.length === 6 && request.method === 'POST') {
      return renewProjectCommand(request, env, parts[2], parts[4])
    }
    if (parts[2] && parts[3] === 'commands' && parts[4] && parts[5] === 'complete'
      && parts.length === 6 && request.method === 'POST') {
      return completeProjectCommand(request, env, parts[2], parts[4])
    }
    if (parts[2] && parts[3] === 'invitations' && parts.length === 4 && request.method === 'POST') {
      return createProjectInvitation(request, env, parts[2])
    }
    if (parts[2] && parts[3] === 'invitations' && parts.length === 4 && request.method === 'GET') {
      return listProjectInvitations(request, env, parts[2])
    }
    if (parts[2] && parts[3] === 'invitations' && parts[4] && parts.length === 5 && request.method === 'DELETE') {
      return revokeProjectInvitation(request, env, parts[2], parts[4])
    }
    if (parts[2] && parts[3] === 'members' && parts.length === 4 && request.method === 'GET') {
      return listProjectMembers(request, env, parts[2])
    }
    if (parts[2] && parts[3] === 'members' && parts[4] && parts.length === 5 && request.method === 'DELETE') {
      return removeProjectMember(request, env, parts[2], parts[4])
    }
    if (parts[2] && parts[3] === 'device-grant' && parts.length === 4 && request.method === 'POST') {
      return requestProjectDeviceGrant(request, env, parts[2])
    }
    if (parts[2] && parts[3] === 'device-grant' && parts.length === 4 && request.method === 'GET') {
      return getOwnProjectDeviceGrant(request, env, parts[2])
    }
    if (parts[2] && parts[3] === 'device-grants' && parts.length === 4 && request.method === 'GET') {
      return listPendingProjectDeviceGrants(request, env, parts[2])
    }
    if (parts[2] && parts[3] === 'device-grants' && parts[4] && parts[5] === 'complete'
      && parts.length === 6 && request.method === 'POST') {
      return completeProjectDeviceGrant(request, env, parts[2], parts[4])
    }
  }
  if (parts.join('/') === 'v1/project-invitations/accept' && request.method === 'POST') {
    if (request.headers.get('X-Fuddy-Project-Sharing-Version') !== '1') {
      throw new ApiError(426, 'project_sharing_upgrade_required', '请升级 Fuddy 后使用项目共享。')
    }
    return acceptProjectInvitation(request, env)
  }
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
      await pruneProjectAttachmentObjects(env)
    })())
  }
} satisfies ExportedHandler<Environment>
