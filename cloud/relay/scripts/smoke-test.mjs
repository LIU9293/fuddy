import { createHash, randomUUID } from 'node:crypto'

const relayUrl = process.env.COMPANION_RELAY_URL ?? 'https://fuddy.ai/api/relay'

function relayEndpoint(path) {
  return new URL(path.replace(/^\/+/, ''), `${relayUrl.replace(/\/+$/, '')}/`)
}

function authenticatedUrl(path, accountId, deviceId) {
  const url = relayEndpoint(path)
  url.searchParams.set('accountId', accountId)
  url.searchParams.set('deviceId', deviceId)
  return url
}

async function json(response) {
  const body = await response.json()
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

const health = await json(await fetch(relayEndpoint('/health')))
if (health.protocolVersion !== 1) throw new Error('Unexpected protocol version')

const macDeviceId = randomUUID()
const pairing = await json(await fetch(relayEndpoint('/v1/pairings'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ macDeviceId, macDeviceName: 'Relay Smoke Test Mac' })
}))

const phone = await json(await fetch(relayEndpoint('/v1/pairings/claim'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    accountId: pairing.accountId,
    pairingSecret: pairing.pairingSecret,
    deviceId: randomUUID(),
    deviceName: 'Relay Smoke Test iPhone'
  })
}))

const eventId = randomUUID()
await json(await fetch(authenticatedUrl('/v1/events', pairing.accountId, macDeviceId), {
  method: 'POST',
  headers: { Authorization: `Bearer ${pairing.macToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    eventId,
    protocolVersion: 1,
    type: 'snapshot.created',
    entityType: 'snapshot',
    entityId: 'current',
    revision: Date.now(),
    payload: { projects: [], goals: [], decisions: [], runs: [], generatedAt: new Date().toISOString() },
    occurredAt: new Date().toISOString()
  })
}))

const page = await json(await fetch(authenticatedUrl('/v1/events?after=0', pairing.accountId, phone.device.id), {
  headers: { Authorization: `Bearer ${phone.deviceToken}` }
}))
if (page.events[0]?.eventId !== eventId) throw new Error('Event replay failed')

const commandId = randomUUID()
await json(await fetch(authenticatedUrl('/v1/commands', pairing.accountId, phone.device.id), {
  method: 'POST',
  headers: { Authorization: `Bearer ${phone.deviceToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    commandId,
    protocolVersion: 1,
    type: 'agent.rename-session',
    payload: { runId: 'smoke-test', title: 'Smoke Test' },
    createdAt: new Date().toISOString()
  })
}))
const commands = await json(await fetch(authenticatedUrl('/v1/commands/pending', pairing.accountId, macDeviceId), {
  headers: { Authorization: `Bearer ${pairing.macToken}` }
}))
if (!commands.commands.some((command) => command.commandId === commandId)) throw new Error('Command delivery failed')

const attachmentId = randomUUID()
const attachment = new TextEncoder().encode('Fuddy companion attachment smoke test')
const attachmentSha256 = createHash('sha256').update(attachment).digest('hex')
await json(await fetch(authenticatedUrl(`/v1/attachments/${attachmentId}`, pairing.accountId, macDeviceId), {
  method: 'PUT',
  headers: {
    Authorization: `Bearer ${pairing.macToken}`,
    'Content-Type': 'text/plain',
    'Content-Length': String(attachment.byteLength),
    'X-Content-SHA256': attachmentSha256
  },
  body: attachment
}))
const downloaded = await fetch(authenticatedUrl(`/v1/attachments/${attachmentId}`, pairing.accountId, phone.device.id), {
  headers: { Authorization: `Bearer ${phone.deviceToken}` }
})
if (await downloaded.text() !== new TextDecoder().decode(attachment)) throw new Error('Attachment round trip failed')

const revoked = await fetch(authenticatedUrl('/v1/account', pairing.accountId, macDeviceId), {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${pairing.macToken}` }
})
if (revoked.status !== 204) throw new Error('Account cleanup failed')
const oldPhone = await fetch(authenticatedUrl('/v1/events?after=0', pairing.accountId, phone.device.id), {
  headers: { Authorization: `Bearer ${phone.deviceToken}` }
})
if (oldPhone.status !== 401) throw new Error('Revoked phone token was still accepted')

console.info('Companion Relay smoke test passed: pairing, event replay, commands, R2 attachments, and account revocation are online.')
