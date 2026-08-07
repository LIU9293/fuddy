import type {
  CompanionEventPage,
  CompanionPairingStartResult,
  CompanionPairingClaimResult
} from '../../../src/shared/companion-sync'
import { companionProtocolVersion } from '../../../src/shared/companion-sync'
import { AccountRelay } from './account-relay'
import {
  commandSchema,
  commandUpdateSchema,
  pairingClaimSchema,
  pairingStartSchema,
  pushRegistrationSchema,
  syncEventSchema
} from './schemas'

export { AccountRelay }

const maximumJsonBytes = 5 * 1024 * 1024
const maximumAttachmentBytes = 100 * 1024 * 1024
const relayBuild = '2026-08-08.4'

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

async function readJson(request: Request): Promise<unknown> {
  const contentLength = Number.parseInt(request.headers.get('Content-Length') ?? '0', 10)
  if (Number.isFinite(contentLength) && contentLength > maximumJsonBytes) {
    throw new HttpError(413, 'JSON body is too large.')
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > maximumJsonBytes) {
    throw new HttpError(413, 'JSON body is too large.')
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new HttpError(400, 'JSON body is invalid.')
  }
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('Authorization') ?? ''
  if (!authorization.startsWith('Bearer ')) throw new HttpError(401, 'Missing bearer token.')
  return authorization.slice('Bearer '.length).trim()
}

function requiredSearchParam(url: URL, name: string): string {
  const value = url.searchParams.get(name)?.trim()
  if (!value) throw new HttpError(400, `Missing ${name}.`)
  return value
}

function relay(env: Env, accountId: string): DurableObjectStub<AccountRelay> {
  return env.ACCOUNT_RELAY.getByName(accountId)
}

async function authenticatedContext(
  request: Request,
  env: Env,
  url: URL,
  requiredRole?: 'mac' | 'ios'
): Promise<{
  accountId: string
  deviceId: string
  token: string
  stub: DurableObjectStub<AccountRelay>
}> {
  const accountId = requiredSearchParam(url, 'accountId')
  const deviceId = requiredSearchParam(url, 'deviceId')
  const token = bearerToken(request)
  const stub = relay(env, accountId)
  const device = await stub.authorize(deviceId, token, requiredRole)
  if (!device) throw new HttpError(401, '设备认证失败。')
  return { accountId, deviceId, token, stub }
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/health') {
    return Response.json({ status: 'ok', protocolVersion: companionProtocolVersion, build: relayBuild })
  }

  if (request.method === 'POST' && url.pathname === '/v1/pairings') {
    const input = pairingStartSchema.parse(await readJson(request))
    const accountId = crypto.randomUUID()
    const macToken = randomToken()
    const pairingSecret = randomToken(24)
    const createdAt = new Date().toISOString()
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
    await relay(env, accountId).initializePairing({
      macDeviceId: input.macDeviceId,
      macDeviceName: input.macDeviceName,
      macToken,
      pairingSecret,
      publicKey: input.publicKey ?? null,
      expiresAt,
      createdAt
    })
    const pairingPayload = JSON.stringify({
      protocolVersion: companionProtocolVersion,
      relayUrl: url.origin,
      accountId,
      pairingSecret
    })
    return Response.json({
      protocolVersion: companionProtocolVersion,
      accountId,
      macDeviceId: input.macDeviceId,
      macToken,
      pairingSecret,
      pairingPayload,
      expiresAt
    } satisfies CompanionPairingStartResult, { status: 201 })
  }

  if (request.method === 'POST' && url.pathname === '/v1/pairings/claim') {
    const input = pairingClaimSchema.parse(await readJson(request))
    const claim = await relay(env, input.accountId).claimPairing(input)
    if (!claim.result) throw new HttpError(400, claim.error ?? '配对失败。')
    return Response.json(claim.result satisfies CompanionPairingClaimResult, { status: 201 })
  }

  if (request.method === 'GET' && url.pathname === '/v1/connect') {
    const context = await authenticatedContext(request, env, url)
    const device = await context.stub.authorize(context.deviceId, context.token)
    if (!device) throw new HttpError(401, '设备认证失败。')
    const headers = new Headers(request.headers)
    headers.set('X-Companion-Device-Id', device.id)
    headers.set('X-Companion-Device-Role', device.role)
    return await context.stub.fetch(new Request(request, { headers }))
  }

  if (request.method === 'GET' && url.pathname === '/v1/events') {
    const context = await authenticatedContext(request, env, url)
    const after = Math.max(0, Number.parseInt(url.searchParams.get('after') ?? '0', 10) || 0)
    const limit = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '200', 10) || 200))
    const page = await context.stub.listEvents(context.deviceId, context.token, after, limit) as CompanionEventPage
    return Response.json({ ...page, presence: await context.stub.getPresence() })
  }

  if (request.method === 'POST' && url.pathname === '/v1/events') {
    const context = await authenticatedContext(request, env, url, 'mac')
    const input = syncEventSchema.parse(await readJson(request))
    return Response.json(await context.stub.appendEvent(context.deviceId, context.token, input), { status: 201 })
  }

  if (request.method === 'POST' && url.pathname === '/v1/commands') {
    const context = await authenticatedContext(request, env, url, 'ios')
    const input = commandSchema.parse(await readJson(request))
    return Response.json(await context.stub.createCommand(context.deviceId, context.token, input), { status: 201 })
  }

  if (request.method === 'PUT' && url.pathname === '/v1/devices/push-token') {
    const context = await authenticatedContext(request, env, url, 'ios')
    const input = pushRegistrationSchema.parse(await readJson(request))
    await context.stub.registerPushToken(context.deviceId, context.token, input.token)
    return new Response(null, { status: 204 })
  }

  if (request.method === 'GET' && url.pathname === '/v1/commands/pending') {
    const context = await authenticatedContext(request, env, url, 'mac')
    return Response.json({ commands: await context.stub.listPendingCommands(context.deviceId, context.token) })
  }

  const commandMatch = url.pathname.match(/^\/v1\/commands\/([^/]+)$/)
  if (request.method === 'PATCH' && commandMatch) {
    const context = await authenticatedContext(request, env, url, 'mac')
    const update = commandUpdateSchema.parse(await readJson(request))
    return Response.json(await context.stub.updateCommand(
      context.deviceId,
      context.token,
      decodeURIComponent(commandMatch[1]),
      update
    ))
  }

  const attachmentMatch = url.pathname.match(/^\/v1\/attachments\/([A-Za-z0-9._-]+)$/)
  if (attachmentMatch) {
    const context = await authenticatedContext(request, env, url, request.method === 'PUT' ? 'mac' : undefined)
    const attachmentId = attachmentMatch[1]
    const key = `${context.accountId}/${attachmentId}`
    if (request.method === 'PUT') {
      const contentLength = Number.parseInt(request.headers.get('Content-Length') ?? '0', 10)
      if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > maximumAttachmentBytes) {
        throw new HttpError(413, 'Attachment size is invalid or exceeds 100 MiB.')
      }
      await env.ATTACHMENTS.put(key, request.body, {
        httpMetadata: {
          contentType: request.headers.get('Content-Type') ?? 'application/octet-stream'
        },
        customMetadata: {
          accountId: context.accountId,
          uploadedBy: context.deviceId,
          sha256: request.headers.get('X-Content-SHA256') ?? ''
        }
      })
      return Response.json({ id: attachmentId, size: contentLength }, { status: 201 })
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      const object = await env.ATTACHMENTS.get(key)
      if (!object) throw new HttpError(404, 'Attachment not found.')
      const headers = new Headers()
      object.writeHttpMetadata(headers)
      headers.set('ETag', object.httpEtag)
      headers.set('Content-Length', String(object.size))
      headers.set('Cache-Control', 'private, max-age=300')
      return new Response(request.method === 'HEAD' ? null : object.body, { headers })
    }
  }

  if (request.method === 'DELETE' && url.pathname === '/v1/account') {
    const context = await authenticatedContext(request, env, url, 'mac')
    await context.stub.revokeAccount(context.deviceId, context.token)
    let cursor: string | undefined
    do {
      const page = await env.ATTACHMENTS.list({ prefix: `${context.accountId}/`, cursor })
      if (page.objects.length > 0) await env.ATTACHMENTS.delete(page.objects.map((object) => object.key))
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return new Response(null, { status: 204 })
  }

  throw new HttpError(404, 'Route not found.')
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env)
    } catch (error) {
      const status = error instanceof HttpError
        ? error.status
        : error && typeof error === 'object' && 'name' in error && error.name === 'ZodError'
          ? 400
          : 500
      const message = error instanceof Error ? error.message : 'Unexpected relay error.'
      console.error(JSON.stringify({ message: 'companion relay request failed', status, error: message }))
      return Response.json({ error: status === 500 ? 'Internal relay error.' : message }, { status })
    }
  }
} satisfies ExportedHandler<Env>
