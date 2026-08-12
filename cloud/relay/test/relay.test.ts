import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type {
  CompanionCommand,
  CompanionEventBatchResult,
  CompanionEventPage,
  CompanionPairingClaimResult,
  CompanionPairingStartResult,
  CompanionSyncEvent
} from '../../../src/shared/companion-sync'
import { companionProtocolVersion } from '../../../src/shared/companion-sync'

async function pairedDevices(): Promise<{
  pairing: CompanionPairingStartResult
  phone: CompanionPairingClaimResult
}> {
  const pairingResponse = await SELF.fetch('https://relay.test/v1/pairings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

describe('companion relay', () => {
  it('reports protocol health', async () => {
    const response = await SELF.fetch('https://relay.test/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ok',
      protocolVersion: companionProtocolVersion,
      build: '2026-08-12.1'
    })
  })

  it('pairs devices and rejects a second claim', async () => {
    const { pairing, phone } = await pairedDevices()
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
      payload: { title: 'Remote Session', status: 'running' },
      occurredAt: new Date().toISOString()
    }
    const createdResponse = await SELF.fetch(authenticatedUrl('/v1/events', pairing.accountId, pairing.macDeviceId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${pairing.macToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json<CompanionSyncEvent>()
    expect(created.sequence).toBe(1)

    const duplicateResponse = await SELF.fetch(authenticatedUrl('/v1/events', pairing.accountId, pairing.macDeviceId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${pairing.macToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    })
    expect((await duplicateResponse.json<CompanionSyncEvent>()).sequence).toBe(created.sequence)

    const pageResponse = await SELF.fetch(authenticatedUrl('/v1/events?after=0', pairing.accountId, phone.device.id), {
      headers: { Authorization: `Bearer ${phone.deviceToken}` }
    })
    const page = await pageResponse.json<CompanionEventPage>()
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
      payload: { content: `message ${index}` },
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
    const page = await pageResponse.json<CompanionEventPage>()
    expect(page.events.map((event) => event.entityId)).toEqual(['message-0', 'message-1', 'message-2'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    const replayHints = messages
      .map((message) => JSON.parse(message) as { type: string; lastSequence?: number })
      .filter((message) => message.type === 'sync.available')
    expect(replayHints).toEqual([{ type: 'sync.available', lastSequence: 3 }])
    socket!.close()
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
        payload: { runId: 'run-1', prompt: '继续分析' },
        createdAt: new Date().toISOString()
      })
    })
    expect(commandResponse.status).toBe(201)
    const command = await commandResponse.json<CompanionCommand>()
    expect(command.status).toBe('queued')

    const pendingResponse = await SELF.fetch(authenticatedUrl('/v1/commands/pending', pairing.accountId, pairing.macDeviceId), {
      headers: { Authorization: `Bearer ${pairing.macToken}` }
    })
    const pending = await pendingResponse.json<{ commands: CompanionCommand[] }>()
    expect(pending.commands.map((item) => item.commandId)).toContain(commandId)

    const completedResponse = await SELF.fetch(authenticatedUrl(`/v1/commands/${commandId}`, pairing.accountId, pairing.macDeviceId), {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${pairing.macToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed', result: { accepted: true } })
    })
    const completed = await completedResponse.json<CompanionCommand>()
    expect(completed.status).toBe('completed')
    expect(completed.result).toBeNull()

    const updatesResponse = await SELF.fetch(authenticatedUrl('/v1/events?after=0', pairing.accountId, phone.device.id), {
      headers: { Authorization: `Bearer ${phone.deviceToken}` }
    })
    const updates = await updatesResponse.json<CompanionEventPage>()
    expect(updates.events).toHaveLength(1)
    expect(updates.events[0]).toMatchObject({
      type: 'command.updated',
      entityType: 'command',
      entityId: commandId,
      payload: { commandId, status: 'completed' }
    })
  })

  it('discards oversized non-artifact command results before SQLite persistence', async () => {
    const { pairing, phone } = await pairedDevices()
    const commandId = crypto.randomUUID()
    await SELF.fetch(authenticatedUrl('/v1/commands', pairing.accountId, phone.device.id), {
      method: 'POST',
      headers: { Authorization: `Bearer ${phone.deviceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId,
        protocolVersion: companionProtocolVersion,
        type: 'agent.send-message',
        payload: { runId: 'run-large', prompt: '继续分析' },
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
    expect(completedResponse.status).toBe(200)
    const completed = await completedResponse.json<CompanionCommand>()
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
        payload: { artifactId: 'artifact-1' },
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
        'Content-Type': 'text/plain',
        'Content-Length': String(content.length),
        'X-Content-SHA256': sha256
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
        'Content-Type': 'text/plain',
        'Content-Length': String(content.length),
        'X-Content-SHA256': sha256
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
        'Content-Type': 'text/plain',
        'Content-Length': String(content.length),
        'X-Content-SHA256': sha256
      },
      body: content
    })
    expect(overwrite.status).toBe(409)

    const retry = await SELF.fetch(macUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${pairing.macToken}`,
        'Content-Type': 'text/plain',
        'Content-Length': String(content.length),
        'X-Content-SHA256': sha256
      },
      body: content
    })
    expect(retry.status).toBe(200)
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
