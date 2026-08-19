import { SELF, env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import type {
  CompanionEncryptedCommand,
  CompanionEncryptedEventPage,
  CompanionEncryptedSyncEvent,
  CompanionEventBatchResult,
  CompanionPairingClaimResult,
  CompanionPairingStartResult,
} from '../../../src/shared/companion-sync'
import { companionMinimumProtocolVersion, companionProtocolVersion } from '../../../src/shared/companion-sync'
import { enforceRateLimit, maximumEncryptedEventPayloadBytes } from '../src/request-guards'

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
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `test-${crypto.randomUUID()}` },
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
  it('keys public pairing limits by client address and rejects exhausted bindings', async () => {
    const limit = vi.fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false })
    const binding = { limit } as unknown as RateLimit
    const request = new Request('https://relay.test/v1/pairings', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.10' }
    })

    await expect(enforceRateLimit(binding, request, 'pairing-start')).resolves.toBeUndefined()
    await expect(enforceRateLimit(binding, request, 'pairing-start')).rejects.toMatchObject({ status: 429 })
    expect(limit).toHaveBeenCalledTimes(2)
    expect(limit).toHaveBeenCalledWith({ key: 'pairing-start:203.0.113.10' })
  })

  it('reports protocol health', async () => {
    const response = await SELF.fetch('https://relay.test/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ok',
      minimumProtocolVersion: companionMinimumProtocolVersion,
      protocolVersion: companionProtocolVersion,
      build: '2026-08-18.1'
    })
  })

  it('serves the canonical Relay path and keeps it in the pairing payload', async () => {
    const health = await SELF.fetch('https://relay.test/api/relay/health')
    expect(health.status).toBe(200)

    const response = await SELF.fetch('https://relay.test/api/relay/v1/pairings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `test-${crypto.randomUUID()}` },
      body: JSON.stringify({ macDeviceId: 'canonical-mac', macDeviceName: 'Canonical Mac' })
    })
    expect(response.status).toBe(201)
    const pairing = await response.json<CompanionPairingStartResult>()
    expect(JSON.parse(pairing.pairingPayload)).toMatchObject({
      relayUrl: 'https://relay.test/api/relay'
    })
  })

  it('pairs devices and rejects a second claim', async () => {
    const { pairing, phone } = await pairedDevices()
    expect(pairing.minimumProtocolVersion).toBe(companionMinimumProtocolVersion)
    expect(JSON.parse(pairing.pairingPayload)).toMatchObject({ minimumProtocolVersion: companionMinimumProtocolVersion })
    expect(phone.minimumProtocolVersion).toBe(companionMinimumProtocolVersion)
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

  it('lets an iPhone revoke its own Relay token when it signs out', async () => {
    const { pairing, phone } = await pairedDevices()
    const revoke = await SELF.fetch(
      authenticatedUrl('/v1/devices/self', pairing.accountId, phone.device.id),
      { method: 'DELETE', headers: { Authorization: `Bearer ${phone.deviceToken}` } }
    )
    expect(revoke.status).toBe(204)

    const rejected = await SELF.fetch(
      authenticatedUrl('/v1/events?after=0', pairing.accountId, phone.device.id),
      { headers: { Authorization: `Bearer ${phone.deviceToken}` } }
    )
    expect(rejected.status).toBe(401)
  })

  it('lets a client validate its current Relay identity', async () => {
    const { pairing, phone } = await pairedDevices()
    const response = await SELF.fetch(
      authenticatedUrl('/v1/device', pairing.accountId, phone.device.id),
      { headers: { Authorization: `Bearer ${phone.deviceToken}` } }
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      device: { id: phone.device.id, role: 'ios' }
    })

    const rejected = await SELF.fetch(
      authenticatedUrl('/v1/device', pairing.accountId, phone.device.id),
      { headers: { Authorization: 'Bearer wrong-token' } }
    )
    expect(rejected.status).toBe(401)
  })

  it('lets the private administration path revoke a device without a Mac bearer token', async () => {
    const { pairing, phone } = await pairedDevices()
    const stub = env.ACCOUNT_RELAY.getByName(pairing.accountId)
    await expect(stub.revokeDeviceByAuthority(phone.device.id)).resolves.toBe(true)

    const rejected = await SELF.fetch(
      authenticatedUrl('/v1/events?after=0', pairing.accountId, phone.device.id),
      { headers: { Authorization: `Bearer ${phone.deviceToken}` } }
    )
    expect(rejected.status).toBe(401)
  })

  it('discards nonterminal commands queued by a revoked device', async () => {
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
    const queued = await SELF.fetch(authenticatedUrl('/v1/commands', pairing.accountId, phone.device.id), {
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
    expect(queued.status).toBe(201)

    const stub = env.ACCOUNT_RELAY.getByName(pairing.accountId)
    await expect(stub.revokeDeviceByAuthority(phone.device.id)).resolves.toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(messages.map((value) => JSON.parse(value) as unknown)).toContainEqual({
      type: 'commands.revoked',
      commandIds: [commandId]
    })
    socket!.close()
    await evictDurableObject(stub)

    const pending = await SELF.fetch(
      authenticatedUrl('/v1/commands/pending', pairing.accountId, pairing.macDeviceId),
      { headers: { Authorization: `Bearer ${pairing.macToken}` } }
    )
    expect(pending.status).toBe(200)
    await expect(pending.json<{
      commands: CompanionEncryptedCommand[]
      revokedCommandIds: string[]
    }>()).resolves.toEqual({ commands: [], revokedCommandIds: [commandId] })
    await expect(runInDurableObject(stub, (_instance, state) => (
      state.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM commands WHERE command_id = ?',
        commandId
      ).one().count
    ))).resolves.toBe(0)
  })

  it('lets an authenticated Mac enroll multiple account devices without a pairing secret', async () => {
    const pairingResponse = await SELF.fetch('https://relay.test/v1/pairings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `test-${crypto.randomUUID()}` },
      body: JSON.stringify({ macDeviceId: 'account-mac', macDeviceName: 'Account Mac' })
    })
    const pairing = await pairingResponse.json<CompanionPairingStartResult>()
    const enroll = (deviceId: string) => SELF.fetch(
      authenticatedUrl('/v1/devices/enroll', pairing.accountId, pairing.macDeviceId),
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${pairing.macToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, deviceName: `Phone ${deviceId}`, publicKey: 'account-device-public-key' })
      }
    )

    const first = await enroll('account-ios-1')
    const second = await enroll('account-ios-2')
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    await expect(first.json()).resolves.toMatchObject({
      accountId: pairing.accountId,
      device: { id: 'account-ios-1', role: 'ios' }
    })

    const unauthorized = await SELF.fetch(
      authenticatedUrl('/v1/devices/enroll', pairing.accountId, pairing.macDeviceId),
      {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'account-ios-3', deviceName: 'Unauthorized' })
      }
    )
    expect(unauthorized.status).toBe(401)

    const firstPayload = await (await enroll('account-ios-revoked')).json<CompanionPairingClaimResult>()
    const revoke = await SELF.fetch(
      authenticatedUrl('/v1/devices/account-ios-revoked', pairing.accountId, pairing.macDeviceId),
      { method: 'DELETE', headers: { Authorization: `Bearer ${pairing.macToken}` } }
    )
    expect(revoke.status).toBe(204)
    const rejected = await SELF.fetch(
      authenticatedUrl('/v1/events?after=0', pairing.accountId, firstPayload.device.id),
      { headers: { Authorization: `Bearer ${firstPayload.deviceToken}` } }
    )
    expect(rejected.status).toBe(401)
  })

  it('does not let a delayed grant revocation revoke a newer phone enrollment', async () => {
    const pairingResponse = await SELF.fetch('https://relay.test/v1/pairings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `test-${crypto.randomUUID()}` },
      body: JSON.stringify({ macDeviceId: 'generation-mac', macDeviceName: 'Generation Mac' })
    })
    const pairing = await pairingResponse.json<CompanionPairingStartResult>()
    const enroll = async (grantId: string): Promise<CompanionPairingClaimResult> => {
      const response = await SELF.fetch(
        authenticatedUrl('/v1/devices/enroll', pairing.accountId, pairing.macDeviceId),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${pairing.macToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId: 'generation-phone',
            deviceName: 'Generation Phone',
            publicKey: 'account-device-public-key',
            grantId
          })
        }
      )
      expect(response.status).toBe(201)
      return response.json<CompanionPairingClaimResult>()
    }

    await enroll('grant-old')
    const replacement = await enroll('grant-new')
    const stub = env.ACCOUNT_RELAY.getByName(pairing.accountId)
    await expect(stub.revokeDeviceByAuthority('generation-phone', 'grant-old')).resolves.toBe(false)
    const staleMacRevocation = await SELF.fetch(
      `${authenticatedUrl(
        '/v1/devices/generation-phone',
        pairing.accountId,
        pairing.macDeviceId
      )}&grantId=grant-old`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${pairing.macToken}` } }
    )
    expect(staleMacRevocation.status).toBe(204)
    const stillAuthorized = await SELF.fetch(
      authenticatedUrl('/v1/events?after=0', pairing.accountId, 'generation-phone'),
      { headers: { Authorization: `Bearer ${replacement.deviceToken}` } }
    )
    expect(stillAuthorized.status).toBe(200)

    await expect(stub.revokeDeviceByAuthority('generation-phone', 'grant-new')).resolves.toBe(true)
    const revoked = await SELF.fetch(
      authenticatedUrl('/v1/events?after=0', pairing.accountId, 'generation-phone'),
      { headers: { Authorization: `Bearer ${replacement.deviceToken}` } }
    )
    expect(revoked.status).toBe(401)
  })

  it('does not let an old account revocation delete a reactivated Relay generation', async () => {
    const { pairing } = await pairedDevices()
    const stub = env.ACCOUNT_RELAY.getByName(pairing.accountId)
    await stub.setAccountGeneration(1)
    await stub.setAccountGeneration(2)

    await expect(stub.revokeAccountByAuthority(1)).resolves.toBe(false)
    const stillAuthorized = await SELF.fetch(
      authenticatedUrl('/v1/events?after=0', pairing.accountId, pairing.macDeviceId),
      { headers: { Authorization: `Bearer ${pairing.macToken}` } }
    )
    expect(stillAuthorized.status).toBe(200)

    await expect(stub.revokeAccountByAuthority(2)).resolves.toBe(true)
    const revoked = await SELF.fetch(
      authenticatedUrl('/v1/events?after=0', pairing.accountId, pairing.macDeviceId),
      { headers: { Authorization: `Bearer ${pairing.macToken}` } }
    )
    expect(revoked.status).toBe(401)
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
    expect(page).toMatchObject({ minimumProtocolVersion: companionMinimumProtocolVersion, protocolVersion: companionProtocolVersion })
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

  it('rejects oversized encrypted event values before Durable Object persistence', async () => {
    const { pairing, phone } = await pairedDevices()
    const oversizedEvent = {
      eventId: crypto.randomUUID(),
      protocolVersion: companionProtocolVersion,
      type: 'agent-message.created',
      entityType: 'agent-message' as const,
      entityId: 'oversized-message',
      revision: 1,
      payload: {
        ...encryptedPayload,
        ciphertext: 'x'.repeat(maximumEncryptedEventPayloadBytes)
      },
      occurredAt: new Date().toISOString()
    }
    const headers = {
      Authorization: `Bearer ${pairing.macToken}`,
      'Content-Type': 'application/json'
    }

    const single = await SELF.fetch(authenticatedUrl('/v1/events', pairing.accountId, pairing.macDeviceId), {
      method: 'POST',
      headers,
      body: JSON.stringify(oversizedEvent)
    })
    expect(single.status).toBe(413)
    expect(await single.json()).toMatchObject({ error: expect.stringContaining('1900000 byte Relay limit') })

    const batch = await SELF.fetch(authenticatedUrl('/v1/events/batch', pairing.accountId, pairing.macDeviceId), {
      method: 'POST',
      headers,
      body: JSON.stringify({ events: [oversizedEvent] })
    })
    expect(batch.status).toBe(413)

    const pageResponse = await SELF.fetch(authenticatedUrl('/v1/events?after=0', pairing.accountId, phone.device.id), {
      headers: { Authorization: `Bearer ${phone.deviceToken}` }
    })
    expect((await pageResponse.json<CompanionEncryptedEventPage>()).events).toEqual([])
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

  it('preserves retained encrypted events and commands across the protocol-v4 migration', async () => {
    const { pairing, phone } = await pairedDevices()
    const stub = env.ACCOUNT_RELAY.getByName(pairing.accountId)
    const now = new Date().toISOString()
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO events (
          event_id, protocol_version, type, entity_type, entity_id, revision,
          payload_json, source_device_id, occurred_at
        ) VALUES (?, 3, 'agent-run.updated', 'agent-run', ?, 1, ?, ?, ?)`,
        'legacy-event',
        'legacy-run',
        JSON.stringify(encryptedPayload),
        pairing.macDeviceId,
        now
      )
      state.storage.sql.exec(
        `INSERT INTO commands (
          command_id, protocol_version, type, payload_json, source_device_id,
          status, result_json, error, created_at, updated_at
        ) VALUES (?, 3, 'agent.send-message', ?, ?, 'queued', NULL, NULL, ?, ?)`,
        'legacy-command',
        JSON.stringify(encryptedPayload),
        phone.device.id,
        now,
        now
      )
      state.storage.sql.exec('DELETE FROM _sql_schema_migrations WHERE id = 5')
    })
    await evictDurableObject(stub)

    const pendingResponse = await SELF.fetch(authenticatedUrl(
      '/v1/commands/pending', pairing.accountId, pairing.macDeviceId
    ), {
      headers: { Authorization: `Bearer ${pairing.macToken}` }
    })
    expect(pendingResponse.status).toBe(200)
    expect(await pendingResponse.json<{ commands: CompanionEncryptedCommand[] }>()).toMatchObject({
      commands: [{ commandId: 'legacy-command', protocolVersion: 3, status: 'queued' }]
    })

    const pageResponse = await SELF.fetch(authenticatedUrl('/v1/events?after=0', pairing.accountId, phone.device.id), {
      headers: { Authorization: `Bearer ${phone.deviceToken}` }
    })
    expect(pageResponse.status).toBe(200)
    expect((await pageResponse.json<CompanionEncryptedEventPage>()).events).toEqual([
      expect.objectContaining({ eventId: 'legacy-event', protocolVersion: 3 })
    ])
    expect(await runInDurableObject(stub, (_instance, state) => (
      state.storage.sql.exec<{ id: number }>(
        'SELECT id FROM _sql_schema_migrations WHERE id = 5'
      ).one().id
    ))).toBe(5)
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
    expect(retry.status).toBe(409)

    const identicalRetry = await SELF.fetch(macUrl, {
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
    expect(identicalRetry.status).toBe(200)

    const refreshed = await SELF.fetch(authenticatedUrl(`/v1/attachments/${attachmentId}`, pairing.accountId, phone.device.id), {
      headers: { Authorization: `Bearer ${phone.deviceToken}` }
    })
    expect(refreshed.status).toBe(200)
    expect(await refreshed.text()).toBe(content)
  })

  it('does not commit an attachment upload that races account revocation', async () => {
    const { pairing, phone } = await pairedDevices()
    const attachmentId = crypto.randomUUID()
    const content = new TextEncoder().encode('attachment racing account revocation')
    const sha256 = await crypto.subtle.digest('SHA-256', content)
      .then((digest) => Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join(''))
    const body = new FixedLengthStream(content.byteLength)
    const writer = body.writable.getWriter()
    const upload = SELF.fetch(authenticatedUrl(
      `/v1/attachments/${attachmentId}`,
      pairing.accountId,
      phone.device.id
    ), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${phone.deviceToken}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(content.byteLength),
        'X-Content-SHA256': sha256,
        'X-Companion-Encryption': 'A256GCM'
      },
      body: body.readable
    })

    const midpoint = Math.floor(content.byteLength / 2)
    await writer.write(content.slice(0, midpoint))
    const revoke = await SELF.fetch(
      authenticatedUrl('/v1/account', pairing.accountId, pairing.macDeviceId),
      { method: 'DELETE', headers: { Authorization: `Bearer ${pairing.macToken}` } }
    )
    expect(revoke.status).toBe(204)
    await writer.write(content.slice(midpoint))
    await writer.close()

    await expect(upload).resolves.toMatchObject({ status: 401 })
    await expect(env.ATTACHMENTS.list({ prefix: `${pairing.accountId}/` }))
      .resolves.toMatchObject({ objects: [] })
  })

  it('cleans up only a revoked device upload when another device commits the same attachment', async () => {
    const { pairing, phone } = await pairedDevices()
    const attachmentId = crypto.randomUUID()
    const content = new TextEncoder().encode('attachment committed by the remaining device')
    const sha256 = await crypto.subtle.digest('SHA-256', content)
      .then((digest) => Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join(''))
    const body = new FixedLengthStream(content.byteLength)
    const writer = body.writable.getWriter()
    const staleUpload = SELF.fetch(authenticatedUrl(
      `/v1/attachments/${attachmentId}`,
      pairing.accountId,
      phone.device.id
    ), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${phone.deviceToken}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(content.byteLength),
        'X-Content-SHA256': sha256,
        'X-Companion-Encryption': 'A256GCM'
      },
      body: body.readable
    })

    const midpoint = Math.floor(content.byteLength / 2)
    await writer.write(content.slice(0, midpoint))
    const revoke = await SELF.fetch(authenticatedUrl(
      `/v1/devices/${phone.device.id}`,
      pairing.accountId,
      pairing.macDeviceId
    ), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${pairing.macToken}` }
    })
    expect(revoke.status).toBe(204)

    const winningUpload = await SELF.fetch(authenticatedUrl(
      `/v1/attachments/${attachmentId}`,
      pairing.accountId,
      pairing.macDeviceId
    ), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${pairing.macToken}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(content.byteLength),
        'X-Content-SHA256': sha256,
        'X-Companion-Encryption': 'A256GCM'
      },
      body: content
    })
    expect(winningUpload.status).toBe(201)

    await writer.write(content.slice(midpoint))
    await writer.close()
    await expect(staleUpload).resolves.toMatchObject({ status: 401 })

    const download = await SELF.fetch(authenticatedUrl(
      `/v1/attachments/${attachmentId}`,
      pairing.accountId,
      pairing.macDeviceId
    ), {
      headers: { Authorization: `Bearer ${pairing.macToken}` }
    })
    expect(download.status).toBe(200)
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(content)
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
