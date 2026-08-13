import { SELF, env, runDurableObjectAlarm } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type {
  CompanionEncryptedCommand,
  CompanionEncryptedEventPage,
  CompanionEncryptedSyncEvent,
  CompanionEventBatchResult,
  CompanionPairingClaimResult,
  CompanionPairingStartResult,
} from '../../../src/shared/companion-sync'
import { companionProtocolVersion } from '../../../src/shared/companion-sync'

async function pairedDevices(): Promise<{
  pairing: CompanionPairingStartResult
  phone: CompanionPairingClaimResult
}> {
  const pairingResponse = await SELF.fetch('https://relay.test/v1/pairings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `test-${crypto.randomUUID()}` },
    body: JSON.stringify({ macDeviceId: 'mac-test', macDeviceName: 'Test Mac' })
  })
  expect(pairingResponse.status).toBe(201)
  const pairing = await pairingResponse.json<CompanionPairingStartResult>()
  const claimResponse = await SELF.fetch('https://relay.test/v1/pairings/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId: pairing.accountId,
      pairingSecret: pairing.pairingSecret,
      deviceId: 'ios-test',
      deviceName: 'Test iPhone'
    })
  })
  expect(claimResponse.status).toBe(201)
  return { pairing, phone: await claimResponse.json<CompanionPairingClaimResult>() }
}

function authenticatedUrl(path: string, accountId: string, deviceId: string): string {
  return `https://relay.test${path}${path.includes('?') ? '&' : '?'}accountId=${accountId}&deviceId=${deviceId}`
}

const encryptedPayload = {
  algorithm: 'A256GCM',
  keyId: 'keyidentifier123',
  nonce: '0123456789abcdef',
  ciphertext: 'opaque_ciphertext_AQID'
} as const

describe('companion relay', () => {
  it('rate limits public pairing creation by client address', async () => {
    const statuses: number[] = []
    for (let index = 0; index < 11; index += 1) {
      const response = await SELF.fetch('https://relay.test/v1/pairings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
        body: JSON.stringify({ macDeviceId: `mac-rate-${index}`, macDeviceName: 'Rate Test Mac' })
      })
      statuses.push(response.status)
    }
    expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true)
    expect(statuses[10]).toBe(429)
  })

  it('reports protocol health', async () => {
    const response = await SELF.fetch('https://relay.test/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ok',
      minimumProtocolVersion: 2,
      protocolVersion: companionProtocolVersion,
      build: '2026-08-13.1'
    })
  })

  it('pairs devices and rejects a second claim', async () => {
    const { pairing, phone } = await pairedDevices()
    expect(pairing.minimumProtocolVersion).toBe(2)
    expect(JSON.parse(pairing.pairingPayload)).toMatchObject({ minimumProtocolVersion: 2 })
    expect(phone.minimumProtocolVersion).toBe(2)
    expect(phone.accountId).toBe(pairing.accountId)
    expect(phone.device.role).toBe('ios')
    expect(phone.deviceToken.length).toBeGreaterThan(20)

    const repeated = await SELF.fetch('https://relay.test/v1/pairings/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: pairing.accountId,
        pairingSecret: pairing.pairingSecret,
        deviceId: 'ios-second',
        deviceName: 'Second iPhone'
      })
    })
    expect(repeated.status).toBe(400)
  })

  it('persists ordered Mac events and replays them to iOS', async () => {
    const { pairing, phone } = await pairedDevices()
    const input = {
      eventId: crypto.randomUUID(),
      protocolVersion: companionProtocolVersion,
      type: 'agent-run.updated',
      entityType: 'agent-run' as const,
      entityId: 'run-1',
      revision: 1,
      payload: encryptedPayload,
      occurredAt: new Date().toISOString()
    }
    const createdResponse = await SELF.fetch(authenticatedUrl('/v1/events', pairing.accountId, pairing.macDeviceId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${pairing.macToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json<CompanionEncryptedSyncEvent>()
    expect(created.sequence).toBe(1)

    const duplicateResponse = await SELF.fetch(authenticatedUrl('/v1/events', pairing.accountId, pairing.macDeviceId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${pairing.macToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    })
    expect((await duplicateResponse.json<CompanionEncryptedSyncEvent>()).sequence).toBe(created.sequence)

    const pageResponse = await SELF.fetch(authenticatedUrl('/v1/events?after=0', pairing.accountId, phone.device.id), {
      headers: { Authorization: `Bearer ${phone.deviceToken}` }
    })
    const page = await pageResponse.json<CompanionEncryptedEventPage>()
    expect(page).toMatchObject({ minimumProtocolVersion: 2, protocolVersion: companionProtocolVersion })
    expect(page.events).toHaveLength(1)
    expect(page.events[0]).toMatchObject(input)
    expect(page.presence).toMatchObject({ macOnline: false, iosDevicesOnline: 0 })
  })

  it('persists an idempotent event batch and emits one replay hint', async () => {
    const { pairing, phone } = await pairedDevices()
    const connect = await SELF.fetch(authenticatedUrl('/v1/connect', pairing.accountId, phone.device.id), {
      headers: { Authorization: `Bearer ${phone.deviceToken}`, Upgrade: 'websocket' }
    })
    expect(connect.status).toBe(101)
    const socket = connect.webSocket
    expect(socket).toBeDefined()
    socket!.accept()
    const messages: string[] = []
    socket!.addEventListener('message', (event) => { messages.push(String(event.data)) })

    const occurredAt = new Date().toISOString()
    const events = Array.from({ length: 3 }, (_, index) => ({
      eventId: crypto.randomUUID(),
      protocolVersion: companionProtocolVersion,
      type: 'agent-message.created',
      entityType: 'agent-message' as const,
      entityId: `message-${index}`,
      revision: index + 1,
      payload: { ...encryptedPayload, ciphertext: `opaque_${index}` },
      occurredAt
    }))
    const batchUrl = authenticatedUrl('/v1/events/batch', pairing.accountId, pairing.macDeviceId)
    const createdResponse = await SELF.fetch(batchUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pairing.macToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events })
    })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json<CompanionEventBatchResult>()
    expect(created.accepted.map((event) => event.sequence)).toEqual([1, 2, 3])
    expect(created.lastSequence).toBe(3)

    const duplicateResponse = await SELF.fetch(batchUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pairing.macToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events })
    })
    const duplicate = await duplicateResponse.json<CompanionEventBatchResult>()
    expect(duplicate.accepted.map((event) => event.sequence)).toEqual([1, 2, 3])

    const pageResponse = await SELF.fetch(authenticatedUrl('/v1/events?after=0', pairing.accountId, phone.device.id), {
      headers: { Authorization: `Bearer ${phone.deviceToken}` }
    })
    const page = await pageResponse.json<CompanionEncryptedEventPage>()
    expect(page.events.map((event) => event.entityId)).toEqual(['message-0', 'message-1', 'message-2'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    const replayHints = messages
      .map((message) => JSON.parse(message) as { type: string; lastSequence?: number })
      .filter((message) => message.type === 'sync.available')
    expect(replayHints).toEqual([{ type: 'sync.available', lastSequence: 3 }])
    socket!.close()
  })

  it('compacts only events behind an acknowledged snapshot and preserves reset replay', async () => {
    const { pairing, phone } = await pairedDevices()
    const occurredAt = new Date().toISOString()
    const definitions = [
      { type: 'snapshot.created', entityType: 'snapshot', entityId: 'current' },
      { type: 'agent-run.updated', entityType: 'agent-run', entityId: 'run-before-snapshot' },
      { type: 'snapshot.created', entityType: 'snapshot', entityId: 'current' },
      { type: 'agent-run.updated', entityType: 'agent-run', entityId: 'run-after-snapshot' }
    ] as const
    const events = definitions.map((definition, index) => ({
      eventId: crypto.randomUUID(),
      protocolVersion: companionProtocolVersion,
      ...definition,
      revision: index + 1,
      payload: { ...encryptedPayload, ciphertext: `opaque_compaction_${index}` },
      occurredAt
    }))
    const batch = await SELF.fetch(authenticatedUrl('/v1/events/batch', pairing.accountId, pairing.macDeviceId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${pairing.macToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events })
    })
    expect(batch.status).toBe(201)

    const acknowledge = await SELF.fetch(authenticatedUrl('/v1/events?after=4', pairing.accountId, phone.device.id), {
      headers: { Authorization: `Bearer ${phone.deviceToken}` }
    })
    expect(acknowledge.status).toBe(200)

    const reset = await SELF.fetch(authenticatedUrl('/v1/events?after=0', pairing.accountId, phone.device.id), {
      headers: { Authorization: `Bearer ${phone.deviceToken}` }
    })
    const page = await reset.json<CompanionEncryptedEventPage>()
    expect(page.events.map((event) => event.sequence)).toEqual([3, 4])
    expect(page.events[0]).toMatchObject({ type: 'snapshot.created', entityId: 'current' })
  })

  it('schedules recurring Durable Object maintenance after retained data changes', async () => {
    const { pairing } = await pairedDevices()
    const response = await SELF.fetch(authenticatedUrl('/v1/events', pairing.accountId, pairing.macDeviceId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${pairing.macToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: crypto.randomUUID(), protocolVersion: companionProtocolVersion,
        type: 'snapshot.created', entityType: 'snapshot', entityId: 'current', revision: 1,
        payload: encryptedPayload, occurredAt: new Date().toISOString()
      })
    })
    expect(response.status).toBe(201)
    const stub = env.ACCOUNT_RELAY.getByName(pairing.accountId)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
  })

  it('queues iOS commands and lets the Mac complete them idempotently', async () => {
    const { pairing, phone } = await pairedDevices()
    const commandId = crypto.randomUUID()
    const commandResponse = await SELF.fetch(authenticatedUrl('/v1/commands', pairing.accountId, phone.device.id), {
      method: 'POST',
      headers: { Authorization: `Bearer ${phone.deviceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId,
        protocolVersion: companionProtocolVersion,
        type: 'agent.send-message',
        payload: encryptedPayload,
        createdAt: new Date().toISOString()
      })
    })
    expect(commandResponse.status).toBe(201)
    const command = await commandResponse.json<CompanionEncryptedCommand>()
    expect(command.status).toBe('queued')

    const pendingResponse = await SELF.fetch(authenticatedUrl('/v1/commands/pending', pairing.accountId, pairing.macDeviceId), {
      headers: { Authorization: `Bearer ${pairing.macToken}` }
    })
    const pending = await pendingResponse.json<{ commands: CompanionEncryptedCommand[] }>()
    expect(pending.commands.map((item) => item.commandId)).toContain(commandId)

    const completedResponse = await SELF.fetch(authenticatedUrl(`/v1/commands/${commandId}`, pairing.accountId, pairing.macDeviceId), {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${pairing.macToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' })
    })
    const completed = await completedResponse.json<CompanionEncryptedCommand>()
    expect(completed.status).toBe('completed')
    expect(completed.result).toBeNull()

    expect(JSON.stringify(completed)).not.toContain('accepted')
  })

  it('rejects plaintext command outcomes and persists status only', async () => {
    const { pairing, phone } = await pairedDevices()
    const commandId = crypto.randomUUID()
    await SELF.fetch(authenticatedUrl('/v1/commands', pairing.accountId, phone.device.id), {
      method: 'POST',
      headers: { Authorization: `Bearer ${phone.deviceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId,
        protocolVersion: companionProtocolVersion,
        type: 'agent.send-message',
        payload: encryptedPayload,
        createdAt: new Date().toISOString()
      })
    })

    const completedResponse = await SELF.fetch(authenticatedUrl(
      `/v1/commands/${commandId}`,
      pairing.accountId,
      pairing.macDeviceId
    ), {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${pairing.macToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed', result: { detail: 'x'.repeat(3 * 1024 * 1024) } })
    })
    expect(completedResponse.status).toBe(400)
    const statusOnlyResponse = await SELF.fetch(authenticatedUrl(
      `/v1/commands/${commandId}`, pairing.accountId, pairing.macDeviceId
    ), {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${pairing.macToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' })
    })
    expect(statusOnlyResponse.status).toBe(200)
    const completed = await statusOnlyResponse.json<CompanionEncryptedCommand>()
    expect(completed).toMatchObject({ commandId, status: 'completed', result: null })
  })

  it('pushes queued commands to an authenticated Mac WebSocket', async () => {
    const { pairing, phone } = await pairedDevices()
    const connect = await SELF.fetch(authenticatedUrl('/v1/connect', pairing.accountId, pairing.macDeviceId), {
      headers: { Authorization: `Bearer ${pairing.macToken}`, Upgrade: 'websocket' }
    })
    expect(connect.status).toBe(101)
    const socket = connect.webSocket
    expect(socket).toBeDefined()
    socket!.accept()
    const messages: string[] = []
    socket!.addEventListener('message', (event) => { messages.push(String(event.data)) })

    const commandId = crypto.randomUUID()
    const commandResponse = await SELF.fetch(authenticatedUrl('/v1/commands', pairing.accountId, phone.device.id), {
      method: 'POST',
      headers: { Authorization: `Bearer ${phone.deviceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId,
        protocolVersion: companionProtocolVersion,
        type: 'artifact.request-upload',
        payload: encryptedPayload,
        createdAt: new Date().toISOString()
      })
    })
    expect(commandResponse.status).toBe(201)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(messages.some((value) => value.includes(commandId) && value.includes('command.created'))).toBe(true)
    socket!.close()
  })

  it('streams authenticated attachments through R2', async () => {
    const { pairing, phone } = await pairedDevices()
    const attachmentId = crypto.randomUUID()
    const macUrl = authenticatedUrl(`/v1/attachments/${attachmentId}`, pairing.accountId, pairing.macDeviceId)
    const content = 'attachment body'
    const sha256 = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
      .then((digest) => Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join(''))
    const put = await SELF.fetch(macUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${pairing.macToken}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(content.length),
        'X-Content-SHA256': sha256,
        'X-Companion-Encryption': 'A256GCM'
      },
      body: content
    })
    expect(put.status).toBe(201)

    const get = await SELF.fetch(authenticatedUrl(`/v1/attachments/${attachmentId}`, pairing.accountId, phone.device.id), {
      headers: { Authorization: `Bearer ${phone.deviceToken}` }
    })
    expect(get.status).toBe(200)
    expect(await get.text()).toBe(content)

    const phoneAttachmentId = crypto.randomUUID()
    const phoneUpload = await SELF.fetch(authenticatedUrl(`/v1/attachments/${phoneAttachmentId}`, pairing.accountId, phone.device.id), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${phone.deviceToken}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(content.length),
        'X-Content-SHA256': sha256,
        'X-Companion-Encryption': 'A256GCM'
      },
      body: content
    })
    expect(phoneUpload.status).toBe(201)

    const macDownload = await SELF.fetch(authenticatedUrl(`/v1/attachments/${phoneAttachmentId}`, pairing.accountId, pairing.macDeviceId), {
      headers: { Authorization: `Bearer ${pairing.macToken}` }
    })
    expect(macDownload.status).toBe(200)
    expect(await macDownload.text()).toBe(content)

    const overwrite = await SELF.fetch(authenticatedUrl(
      `/v1/attachments/${attachmentId}`,
      pairing.accountId,
      phone.device.id
    ), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${phone.deviceToken}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(content.length),
        'X-Content-SHA256': sha256,
        'X-Companion-Encryption': 'A256GCM'
      },
      body: content
    })
    expect(overwrite.status).toBe(409)

    const resealedContent = 'attachment body with a fresh nonce'
    const resealedSha256 = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(resealedContent))
      .then((digest) => Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join(''))
    const retry = await SELF.fetch(macUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${pairing.macToken}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(resealedContent.length),
        'X-Content-SHA256': resealedSha256,
        'X-Companion-Encryption': 'A256GCM'
      },
      body: resealedContent
    })
    expect(retry.status).toBe(200)

    const refreshed = await SELF.fetch(authenticatedUrl(`/v1/attachments/${attachmentId}`, pairing.accountId, phone.device.id), {
      headers: { Authorization: `Bearer ${phone.deviceToken}` }
    })
    expect(refreshed.status).toBe(200)
    expect(await refreshed.text()).toBe(resealedContent)
  })

  it('rejects malformed JSON and oversized bodies without relying on Content-Length', async () => {
    const invalid = await SELF.fetch('https://relay.test/v1/pairings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{'
    })
    expect(invalid.status).toBe(400)

    const oversized = await SELF.fetch('https://relay.test/v1/pairings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ macDeviceId: 'mac', macDeviceName: 'x'.repeat(5 * 1024 * 1024) })
    })
    expect(oversized.status).toBe(413)
  })

  it('registers an authenticated iOS APNs device token', async () => {
    const { pairing, phone } = await pairedDevices()
    const response = await SELF.fetch(authenticatedUrl('/v1/devices/push-token', pairing.accountId, phone.device.id), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${phone.deviceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a'.repeat(64) })
    })
    expect(response.status).toBe(204)
  })

  it('lets the Mac revoke the paired account and rejects old device tokens', async () => {
    const { pairing, phone } = await pairedDevices()
    const revoke = await SELF.fetch(authenticatedUrl('/v1/account', pairing.accountId, pairing.macDeviceId), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${pairing.macToken}` }
    })
    expect(revoke.status).toBe(204)
    const oldPhone = await SELF.fetch(authenticatedUrl('/v1/events?after=0', pairing.accountId, phone.device.id), {
      headers: { Authorization: `Bearer ${phone.deviceToken}` }
    })
    expect(oldPhone.status).toBe(401)
  })
})
