import { WorkerEntrypoint } from 'cloudflare:workers'
import type {
  CompanionDevice,
  CompanionEncryptedEventPage,
  CompanionPairingStartResult,
  CompanionPairingClaimResult
} from '../../../src/shared/companion-sync'
import {
  companionAttachmentObjectMaximumBytes,
  companionMinimumProtocolVersion,
  companionProtocolVersion
} from '../../../src/shared/companion-sync'
import { AccountRelay, type RelayMutationResult } from './account-relay'
import {
  commandSchema,
  commandUpdateSchema,
  deviceEnrollmentSchema,
  pairingClaimSchema,
  pairingStartSchema,
  pushRegistrationSchema,
  syncEventBatchSchema,
  syncEventSchema
} from './schemas'
import {
  assertEncryptedEventPayloadSizes,
  enforceRateLimit,
  HttpError
} from './request-guards'

export { AccountRelay }

const maximumJsonBytes = 5 * 1024 * 1024
export const maximumAttachmentBytes = companionAttachmentObjectMaximumBytes
const relayBuild = '2026-08-19.2'
const canonicalRelayPathPrefix = '/api/relay'

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

function publicRelayUrl(url: URL): string {
  return url.pathname === canonicalRelayPathPrefix || url.pathname.startsWith(`${canonicalRelayPathPrefix}/`)
    ? `${url.origin}${canonicalRelayPathPrefix}`
    : url.origin
}

function routedRelayPath(pathname: string): string {
  if (pathname === canonicalRelayPathPrefix) return '/'
  if (pathname.startsWith(`${canonicalRelayPathPrefix}/`)) {
    return pathname.slice(canonicalRelayPathPrefix.length)
  }
  return pathname
}

function relay(env: Env, accountId: string): DurableObjectStub<AccountRelay> {
  return env.ACCOUNT_RELAY.getByName(accountId)
}

type AttachmentUploadCommitResult = Awaited<ReturnType<AccountRelay['commitAttachmentUploadLease']>>

function relayMutationValue<T>(result: RelayMutationResult<T>): T {
  if (result.status === 'unauthorized') throw new HttpError(401, '设备认证失败。')
  if (result.status === 'account-unbound') throw new HttpError(409, 'Relay 账户尚未完成 Fuddy 账户绑定。')
  if (result.status === 'capacity-exceeded') throw new HttpError(409, '账户命令存储已达到上限，请等待活跃命令结束。')
  return result.value
}

export function shouldDeleteUploadedAttachmentObject(
  storageKey: string,
  commit: AttachmentUploadCommitResult
): boolean {
  return commit.status === 'unauthorized'
    || (commit.status === 'existing' && commit.attachment.storageKey !== storageKey)
}

async function deleteAccountAttachments(env: Env, accountId: string): Promise<void> {
  let cursor: string | undefined
  do {
    const page = await env.ATTACHMENTS.list({ prefix: `${accountId}/`, cursor })
    if (page.objects.length > 0) await env.ATTACHMENTS.delete(page.objects.map((object) => object.key))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
}

export class RelayAdministration extends WorkerEntrypoint<Env> {
  async revokeDevice(accountId: string, deviceId: string, grantId?: string): Promise<boolean> {
    return await relay(this.env, accountId).revokeDeviceByAuthority(deviceId, grantId)
  }

  async claimAccountBinding(
    accountId: string,
    spaceId: string,
    bindingId: string,
    generation: number,
    proof: string
  ): Promise<boolean> {
    return await relay(this.env, accountId).claimAccountBinding(spaceId, bindingId, generation, proof)
  }

  async releaseAccountBinding(accountId: string, spaceId: string, bindingId: string): Promise<boolean> {
    return await relay(this.env, accountId).releaseAccountBinding(spaceId, bindingId)
  }

  async confirmAccountBinding(accountId: string, spaceId: string, bindingId: string): Promise<boolean> {
    return await relay(this.env, accountId).confirmAccountBinding(spaceId, bindingId)
  }

  async setAccountGeneration(
    accountId: string,
    spaceId: string,
    bindingId: string | null,
    generation: number
  ): Promise<boolean> {
    return await relay(this.env, accountId).setAccountGeneration(spaceId, bindingId, generation)
  }

  async revokeAccount(
    accountId: string,
    spaceId: string,
    bindingId: string | null,
    generation: number
  ): Promise<boolean> {
    const revoked = await relay(this.env, accountId).revokeAccountByAuthority(spaceId, bindingId, generation)
    if (revoked) await deleteAccountAttachments(this.env, accountId)
    return revoked
  }
}

function relayRequestContext(request: Request, env: Env, url: URL): {
  accountId: string
  deviceId: string
  token: string
  stub: DurableObjectStub<AccountRelay>
} {
  const accountId = requiredSearchParam(url, 'accountId')
  const deviceId = requiredSearchParam(url, 'deviceId')
  return { accountId, deviceId, token: bearerToken(request), stub: relay(env, accountId) }
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
  device: CompanionDevice
  stub: DurableObjectStub<AccountRelay>
}> {
  const accountId = requiredSearchParam(url, 'accountId')
  const deviceId = requiredSearchParam(url, 'deviceId')
  const token = bearerToken(request)
  const stub = relay(env, accountId)
  const device = await stub.authorize(deviceId, token, requiredRole)
  if (!device) throw new HttpError(401, '设备认证失败。')
  return { accountId, deviceId, token, device, stub }
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const relayUrl = publicRelayUrl(url)
  url.pathname = routedRelayPath(url.pathname)
  if (request.method === 'GET' && url.pathname === '/health') {
    return Response.json({
      status: 'ok',
      minimumProtocolVersion: companionMinimumProtocolVersion,
      protocolVersion: companionProtocolVersion,
      build: relayBuild
    })
  }

  if (request.method === 'POST' && url.pathname === '/v1/pairings') {
    await enforceRateLimit(env.PAIRING_RATE_LIMIT, request, 'pairing-start')
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
      minimumProtocolVersion: companionMinimumProtocolVersion,
      protocolVersion: companionProtocolVersion,
      relayUrl,
      accountId,
      pairingSecret
    })
    return Response.json({
      minimumProtocolVersion: companionMinimumProtocolVersion,
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
    await enforceRateLimit(env.PAIRING_CLAIM_RATE_LIMIT, request, 'pairing-claim')
    const input = pairingClaimSchema.parse(await readJson(request))
    const claim = await relay(env, input.accountId).claimPairing(input)
    if (!claim.result) throw new HttpError(400, claim.error ?? '配对失败。')
    return Response.json(claim.result satisfies CompanionPairingClaimResult, { status: 201 })
  }

  if (request.method === 'GET' && url.pathname === '/v1/connect') {
    const context = relayRequestContext(request, env, url)
    return await context.stub.fetch(request)
  }

  if (request.method === 'GET' && url.pathname === '/v1/events') {
    const context = relayRequestContext(request, env, url)
    const after = Math.max(0, Number.parseInt(url.searchParams.get('after') ?? '0', 10) || 0)
    const limit = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '200', 10) || 200))
    const page = await context.stub.syncPage(context.deviceId, context.token, after, limit) as CompanionEncryptedEventPage | null
    if (!page) throw new HttpError(401, '设备认证失败。')
    return Response.json(page)
  }

  if (request.method === 'POST' && url.pathname === '/v1/events') {
    const context = relayRequestContext(request, env, url)
    const input = syncEventSchema.parse(await readJson(request))
    assertEncryptedEventPayloadSizes([input])
    const event = relayMutationValue(await context.stub.appendEvent(
      context.deviceId,
      context.token,
      input
    ))
    return Response.json(event, { status: 201 })
  }

  if (request.method === 'POST' && url.pathname === '/v1/events/batch') {
    const context = relayRequestContext(request, env, url)
    const input = syncEventBatchSchema.parse(await readJson(request))
    assertEncryptedEventPayloadSizes(input.events)
    const result = relayMutationValue(await context.stub.appendEvents(
      context.deviceId,
      context.token,
      input.events
    ))
    return Response.json(result, { status: 201 })
  }

  if (request.method === 'POST' && url.pathname === '/v1/commands') {
    const context = relayRequestContext(request, env, url)
    const input = commandSchema.parse(await readJson(request))
    return Response.json(relayMutationValue(
      await context.stub.createCommand(context.deviceId, context.token, input)
    ), { status: 201 })
  }

  if (request.method === 'POST' && url.pathname === '/v1/devices/enroll') {
    const context = relayRequestContext(request, env, url)
    const input = deviceEnrollmentSchema.parse(await readJson(request))
    if (input.deviceId === context.deviceId) throw new HttpError(409, '不能把 Mac 设备覆盖为 iOS 设备。')
    const enrollment = relayMutationValue(await context.stub.enrollDevice(
      context.deviceId,
      context.token,
      context.accountId,
      input
    ))
    return Response.json(enrollment, { status: 201 })
  }

  if (request.method === 'GET' && url.pathname === '/v1/device') {
    const context = await authenticatedContext(request, env, url)
    return Response.json({ device: context.device })
  }

  if (request.method === 'DELETE' && url.pathname === '/v1/devices/self') {
    const context = await authenticatedContext(request, env, url, 'ios')
    const revoked = await context.stub.revokeSelfDevice(context.deviceId, context.token)
    if (!revoked) throw new HttpError(401, '设备认证失败。')
    return new Response(null, { status: 204 })
  }

  const deviceMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)$/)
  if (request.method === 'DELETE' && deviceMatch) {
    const context = await authenticatedContext(request, env, url, 'mac')
    const revoked = await context.stub.revokeDevice(
      context.deviceId,
      context.token,
      decodeURIComponent(deviceMatch[1]),
      url.searchParams.get('grantId') ?? undefined
    )
    if (!revoked) throw new HttpError(409, '不能通过设备接口撤销 Mac Host。')
    return new Response(null, { status: 204 })
  }

  if (request.method === 'PUT' && url.pathname === '/v1/devices/push-token') {
    const context = await authenticatedContext(request, env, url, 'ios')
    const input = pushRegistrationSchema.parse(await readJson(request))
    await context.stub.registerPushToken(context.deviceId, context.token, input.token)
    return new Response(null, { status: 204 })
  }

  if (request.method === 'POST' && url.pathname === '/v1/account-binding-proofs') {
    const context = await authenticatedContext(request, env, url, 'mac')
    return Response.json(await context.stub.createAccountBindingProof(context.deviceId, context.token), { status: 201 })
  }

  if (request.method === 'GET' && url.pathname === '/v1/commands/pending') {
    const context = relayRequestContext(request, env, url)
    const page = await context.stub.pendingCommands(context.deviceId, context.token)
    if (!page) throw new HttpError(401, '设备认证失败。')
    return Response.json(page)
  }

  const commandMatch = url.pathname.match(/^\/v1\/commands\/([^/]+)$/)
  if (request.method === 'PATCH' && commandMatch) {
    const context = relayRequestContext(request, env, url)
    const update = commandUpdateSchema.parse(await readJson(request))
    return Response.json(relayMutationValue(await context.stub.updateCommand(
      context.deviceId,
      context.token,
      decodeURIComponent(commandMatch[1]),
      update
    )))
  }

  const attachmentMatch = url.pathname.match(/^\/v1\/attachments\/([A-Za-z0-9._-]+)$/)
  if (attachmentMatch) {
    const context = relayRequestContext(request, env, url)
    const attachmentId = attachmentMatch[1]
    if (request.method === 'PUT') {
      if (request.headers.get('X-Companion-Encryption') !== 'A256GCM') {
        throw new HttpError(400, 'End-to-end encrypted attachment envelope is required.')
      }
      const contentLength = Number.parseInt(request.headers.get('Content-Length') ?? '0', 10)
      if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > maximumAttachmentBytes) {
        throw new HttpError(413, 'Attachment size is invalid or exceeds 20 MiB.')
      }
      const sha256 = request.headers.get('X-Content-SHA256')?.trim().toLowerCase() ?? ''
      if (!/^[a-f0-9]{64}$/.test(sha256)) {
        throw new HttpError(400, 'Attachment SHA-256 is required.')
      }
      const uploadLease = await context.stub.createAttachmentUploadLease(
        context.deviceId,
        context.token,
        attachmentId,
        contentLength
      )
      if (!uploadLease) throw new HttpError(401, '设备认证失败。')
      if (uploadLease.status === 'account-unbound') {
        throw new HttpError(409, 'Relay 账户尚未完成 Fuddy 账户绑定。')
      }
      if (uploadLease.status === 'quota-exceeded') {
        throw new HttpError(413, '账户附件总容量已达到 100 GiB 上限。')
      }
      if (uploadLease.status === 'upload-in-progress') {
        throw new HttpError(409, 'Attachment upload is already in progress.')
      }
      if (uploadLease.status === 'existing') {
        const existing = await env.ATTACHMENTS.head(uploadLease.attachment.storageKey)
        if (!existing) throw new HttpError(503, 'Attachment storage is temporarily unavailable.')
        const identicalRetry = uploadLease.attachment.uploadedBy === context.deviceId
          && uploadLease.attachment.sha256 === sha256
          && uploadLease.attachment.size === contentLength
        if (!identicalRetry) throw new HttpError(409, 'Attachment IDs are immutable and already in use.')
        return Response.json({ id: attachmentId, size: existing.size }, { status: 200 })
      }
      const cancelUploadLease = async (): Promise<void> => {
        await context.stub.cancelAttachmentUploadLease(
          context.deviceId,
          context.token,
          uploadLease.leaseId
        )
      }

      const storageKey = `${context.accountId}/objects/${attachmentId}/${crypto.randomUUID()}`
      let uploaded: R2Object
      try {
        uploaded = await env.ATTACHMENTS.put(storageKey, request.body, {
          httpMetadata: {
            contentType: request.headers.get('Content-Type') ?? 'application/octet-stream'
          },
          customMetadata: {
            accountId: context.accountId,
            uploadedBy: context.deviceId,
            sha256,
            encryption: 'A256GCM'
          }
        })
      } catch (error) {
        await cancelUploadLease().catch(() => undefined)
        throw error
      }
      if (uploaded.size !== contentLength || uploaded.size > maximumAttachmentBytes) {
        await env.ATTACHMENTS.delete(storageKey)
        await cancelUploadLease()
        throw new HttpError(413, 'Attachment size is invalid or exceeds 20 MiB.')
      }
      const commitUpload = () => context.stub.commitAttachmentUploadLease(
        context.deviceId,
        context.token,
        {
          attachmentId,
          leaseId: uploadLease.leaseId,
          storageKey,
          sha256,
          size: uploaded.size,
          accountGeneration: uploadLease.accountGeneration
        }
      )
      let commit: Awaited<ReturnType<typeof context.stub.commitAttachmentUploadLease>>
      try {
        commit = await commitUpload()
      } catch {
        try {
          // A Durable Object RPC can commit successfully and still lose its response.
          // Retrying the idempotent commit avoids deleting an object that is already referenced.
          commit = await commitUpload()
        } catch (error) {
          await env.ATTACHMENTS.delete(storageKey)
          await cancelUploadLease().catch(() => undefined)
          throw error
        }
      }
      if (commit.status === 'committed') {
        return Response.json({ id: attachmentId, size: contentLength }, { status: 201 })
      }
      if (shouldDeleteUploadedAttachmentObject(storageKey, commit)) {
        await env.ATTACHMENTS.delete(storageKey)
      }
      if (commit.status === 'unauthorized') {
        throw new HttpError(401, '设备认证已失效。')
      }
      const identicalRetry = commit.attachment.uploadedBy === context.deviceId
        && commit.attachment.sha256 === sha256
        && commit.attachment.size === contentLength
      if (!identicalRetry) throw new HttpError(409, 'Attachment IDs are immutable and already in use.')
      return Response.json({ id: attachmentId, size: commit.attachment.size }, { status: 200 })
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      const resolved = await context.stub.resolveAttachmentStorageKey(
        context.deviceId,
        context.token,
        attachmentId
      )
      if (!resolved) throw new HttpError(401, '设备认证已失效。')
      if (!resolved.storageKey) throw new HttpError(404, 'Attachment not found.')
      const object = await env.ATTACHMENTS.get(resolved.storageKey)
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
    const context = relayRequestContext(request, env, url)
    const canRevoke = await context.stub.authorizeAccountRevocation(context.deviceId, context.token)
    if (!canRevoke) throw new HttpError(401, '设备认证失败。')
    const authorized = await context.stub.revokeAccount(context.deviceId, context.token)
    if (!authorized) throw new HttpError(401, '设备认证失败。')
    await deleteAccountAttachments(env, context.accountId)
    await context.stub.completeAccountRevocationCleanup(context.deviceId, context.token)
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
      if (status >= 500) {
        console.error(JSON.stringify({ message: 'companion relay request failed', status, error: message }))
      }
      return Response.json({ error: status === 500 ? 'Internal relay error.' : message }, { status })
    }
  }
} satisfies ExportedHandler<Env>
