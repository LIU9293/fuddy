import { DurableObject } from 'cloudflare:workers'
import type {
  CompanionCommand,
  CompanionCommandInput,
  CompanionCommandUpdate,
  CompanionDevice,
  CompanionDeviceRole,
  CompanionEventPage,
  CompanionPairingClaimInput,
  CompanionPairingClaimResult,
  CompanionPresence,
  CompanionSocketMessage,
  CompanionSyncEvent,
  CompanionSyncEventInput
} from '../../../src/shared/companion-sync'
import { companionProtocolVersion } from '../../../src/shared/companion-sync'

interface DeviceRow extends Record<string, SqlStorageValue> {
  id: string
  role: CompanionDeviceRole
  platform: 'macos' | 'ios'
  name: string
  token_hash: string
  public_key: string | null
  created_at: string
  last_seen_at: string | null
  revoked_at: string | null
}

interface EventRow extends Record<string, SqlStorageValue> {
  sequence: number
  event_id: string
  protocol_version: number
  type: string
  entity_type: CompanionSyncEvent['entityType']
  entity_id: string
  revision: number
  payload_json: string
  source_device_id: string
  occurred_at: string
}

interface CommandRow extends Record<string, SqlStorageValue> {
  command_id: string
  protocol_version: number
  type: CompanionCommand['type']
  payload_json: string
  source_device_id: string
  status: CompanionCommand['status']
  result_json: string | null
  error: string | null
  created_at: string
  updated_at: string
}

interface SocketAttachment {
  deviceId: string
  role: CompanionDeviceRole
}

function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function secretHash(secret: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)))
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16)
  }
  return bytes
}

function secretsEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  const leftBytes = hexToBytes(left)
  const rightBytes = hexToBytes(right)
  let difference = 0
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index]
  }
  return difference === 0
}

function mapDevice(row: DeviceRow): CompanionDevice {
  return {
    id: row.id,
    role: row.role,
    platform: row.platform,
    name: row.name,
    publicKey: row.public_key,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at
  }
}

function mapEvent(row: EventRow): CompanionSyncEvent {
  return {
    eventId: row.event_id,
    sequence: row.sequence,
    protocolVersion: row.protocol_version,
    type: row.type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    revision: row.revision,
    payload: JSON.parse(row.payload_json) as unknown,
    sourceDeviceId: row.source_device_id,
    occurredAt: row.occurred_at
  }
}

function mapCommand(row: CommandRow): CompanionCommand {
  return {
    commandId: row.command_id,
    protocolVersion: row.protocol_version,
    type: row.type,
    payload: JSON.parse(row.payload_json) as unknown,
    sourceDeviceId: row.source_device_id,
    status: row.status,
    result: row.result_json ? JSON.parse(row.result_json) as unknown : null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class AccountRelay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairing (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        secret_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        claimed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        platform TEXT NOT NULL,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        public_key TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        protocol_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        source_device_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_sequence_idx ON events(sequence);
      CREATE TABLE IF NOT EXISTS commands (
        command_id TEXT PRIMARY KEY,
        protocol_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        source_device_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS commands_status_idx ON commands(status, created_at);
      INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at) VALUES (1, datetime('now'));
    `)
    const deviceColumns = this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(devices)').toArray()
    if (!deviceColumns.some((column) => column.name === 'push_token')) {
      this.ctx.storage.sql.exec('ALTER TABLE devices ADD COLUMN push_token TEXT')
    }
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at) VALUES (2, datetime('now'));
    `)
  }

  async initializePairing(input: {
    macDeviceId: string
    macDeviceName: string
    macToken: string
    pairingSecret: string
    publicKey: string | null
    expiresAt: string
    createdAt: string
  }): Promise<void> {
    const tokenHash = await secretHash(input.macToken)
    const pairingHash = await secretHash(input.pairingSecret)
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO pairing (id, secret_hash, expires_at, claimed_at) VALUES (1, ?, ?, NULL)`,
      pairingHash,
      input.expiresAt
    )
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO devices (
        id, role, platform, name, token_hash, public_key, created_at, last_seen_at, revoked_at
      ) VALUES (?, 'mac', 'macos', ?, ?, ?, ?, NULL, NULL)`,
      input.macDeviceId,
      input.macDeviceName,
      tokenHash,
      input.publicKey,
      input.createdAt
    )
  }

  async claimPairing(input: CompanionPairingClaimInput): Promise<
    { result: CompanionPairingClaimResult; error: null } | { result: null; error: string }
  > {
    const pairing = this.ctx.storage.sql.exec<{
      secret_hash: string
      expires_at: string
      claimed_at: string | null
    }>('SELECT secret_hash, expires_at, claimed_at FROM pairing WHERE id = 1').toArray()[0]
    const suppliedHash = await secretHash(input.pairingSecret)
    if (!pairing || pairing.claimed_at || Date.parse(pairing.expires_at) <= Date.now() || !secretsEqual(pairing.secret_hash, suppliedHash)) {
      return { result: null, error: '配对信息无效或已经过期。' }
    }
    const now = new Date().toISOString()
    const deviceToken = randomToken()
    const tokenHash = await secretHash(deviceToken)
    this.ctx.storage.sql.exec(
      `INSERT INTO devices (
        id, role, platform, name, token_hash, public_key, created_at, last_seen_at, revoked_at
      ) VALUES (?, 'ios', 'ios', ?, ?, ?, ?, NULL, NULL)`,
      input.deviceId,
      input.deviceName,
      tokenHash,
      input.publicKey ?? null,
      now
    )
    this.ctx.storage.sql.exec('UPDATE pairing SET claimed_at = ? WHERE id = 1', now)
    const row = this.ctx.storage.sql.exec<DeviceRow>('SELECT * FROM devices WHERE id = ?', input.deviceId).one()
    return {
      result: {
        protocolVersion: companionProtocolVersion,
        accountId: input.accountId,
        device: mapDevice(row),
        deviceToken
      },
      error: null
    }
  }

  async authorize(deviceId: string, token: string, requiredRole?: CompanionDeviceRole): Promise<CompanionDevice | null> {
    const row = this.ctx.storage.sql.exec<DeviceRow>(
      'SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL',
      deviceId
    ).toArray()[0]
    const suppliedHash = await secretHash(token)
    if (!row || !secretsEqual(row.token_hash, suppliedHash) || (requiredRole && row.role !== requiredRole)) {
      return null
    }
    const lastSeenAt = new Date().toISOString()
    this.ctx.storage.sql.exec('UPDATE devices SET last_seen_at = ? WHERE id = ?', lastSeenAt, deviceId)
    return { ...mapDevice(row), lastSeenAt }
  }

  async appendEvent(deviceId: string, token: string, input: CompanionSyncEventInput): Promise<CompanionSyncEvent> {
    await this.requireAuthorization(deviceId, token, 'mac')
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO events (
        event_id, protocol_version, type, entity_type, entity_id, revision,
        payload_json, source_device_id, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.eventId,
      input.protocolVersion,
      input.type,
      input.entityType,
      input.entityId,
      input.revision,
      JSON.stringify(input.payload),
      deviceId,
      input.occurredAt
    )
    const event = mapEvent(this.ctx.storage.sql.exec<EventRow>(
      'SELECT * FROM events WHERE event_id = ?',
      input.eventId
    ).one())
    this.broadcast({ type: 'sync.event', event })
    this.ctx.waitUntil(this.sendBackgroundPush(event))
    return event
  }

  async registerPushToken(deviceId: string, token: string, pushToken: string): Promise<void> {
    await this.requireAuthorization(deviceId, token, 'ios')
    this.ctx.storage.sql.exec('UPDATE devices SET push_token = ? WHERE id = ?', pushToken.toLowerCase(), deviceId)
  }

  async listEvents(deviceId: string, token: string, after: number, limit: number): Promise<CompanionEventPage> {
    await this.requireAuthorization(deviceId, token)
    const events = this.ctx.storage.sql.exec<EventRow>(
      'SELECT * FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?',
      after,
      limit
    ).toArray().map(mapEvent)
    return { events, lastSequence: events.at(-1)?.sequence ?? after }
  }

  async createCommand(deviceId: string, token: string, input: CompanionCommandInput): Promise<CompanionCommand> {
    await this.requireAuthorization(deviceId, token, 'ios')
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO commands (
        command_id, protocol_version, type, payload_json, source_device_id,
        status, result_json, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, ?)`,
      input.commandId,
      input.protocolVersion,
      input.type,
      JSON.stringify(input.payload),
      deviceId,
      input.createdAt,
      input.createdAt
    )
    const command = mapCommand(this.ctx.storage.sql.exec<CommandRow>(
      'SELECT * FROM commands WHERE command_id = ?',
      input.commandId
    ).one())
    this.broadcast({ type: 'command.created', command }, 'role:mac')
    return command
  }

  async listPendingCommands(deviceId: string, token: string): Promise<CompanionCommand[]> {
    await this.requireAuthorization(deviceId, token, 'mac')
    return this.ctx.storage.sql.exec<CommandRow>(
      `SELECT * FROM commands WHERE status IN ('queued', 'delivered', 'executing') ORDER BY created_at ASC LIMIT 100`
    ).toArray().map(mapCommand)
  }

  async updateCommand(
    deviceId: string,
    token: string,
    commandId: string,
    update: CompanionCommandUpdate
  ): Promise<CompanionCommand> {
    await this.requireAuthorization(deviceId, token, 'mac')
    const updatedAt = new Date().toISOString()
    this.ctx.storage.sql.exec(
      `UPDATE commands SET status = ?, result_json = ?, error = ?, updated_at = ? WHERE command_id = ?`,
      update.status,
      update.result === undefined ? null : JSON.stringify(update.result),
      update.error ?? null,
      updatedAt,
      commandId
    )
    const command = mapCommand(this.ctx.storage.sql.exec<CommandRow>(
      'SELECT * FROM commands WHERE command_id = ?',
      commandId
    ).one())
    this.broadcast({ type: 'command.updated', command })
    return command
  }

  getPresence(): CompanionPresence {
    return {
      macOnline: this.ctx.getWebSockets('role:mac').length > 0,
      iosDevicesOnline: this.ctx.getWebSockets('role:ios').length,
      updatedAt: new Date().toISOString()
    }
  }

  async revokeAccount(deviceId: string, token: string): Promise<void> {
    await this.requireAuthorization(deviceId, token, 'mac')
    const revokedAt = new Date().toISOString()
    this.ctx.storage.sql.exec('UPDATE devices SET revoked_at = ?, token_hash = ?', revokedAt, '')
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.close(1000, 'Account disconnected') } catch { /* Already closed. */ }
    }
    this.ctx.storage.sql.exec('DELETE FROM commands')
    this.ctx.storage.sql.exec('DELETE FROM events')
    this.ctx.storage.sql.exec('DELETE FROM pairing')
    this.ctx.storage.sql.exec('DELETE FROM devices')
  }

  getLastSequence(): number {
    return this.ctx.storage.sql.exec<{ sequence: number | null }>(
      'SELECT MAX(sequence) AS sequence FROM events'
    ).one().sequence ?? 0
  }

  fetch(request: Request): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json({ error: 'WebSocket upgrade required.' }, { status: 426 })
    }
    const deviceId = request.headers.get('X-Companion-Device-Id')
    const role = request.headers.get('X-Companion-Device-Role') as CompanionDeviceRole | null
    if (!deviceId || (role !== 'mac' && role !== 'ios')) {
      return Response.json({ error: 'Missing trusted device context.' }, { status: 401 })
    }
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server, [`device:${deviceId}`, `role:${role}`])
    server.serializeAttachment({ deviceId, role } satisfies SocketAttachment)
    server.send(JSON.stringify({
      type: 'sync.ready',
      presence: this.getPresence(),
      lastSequence: this.getLastSequence()
    } satisfies CompanionSocketMessage))
    this.broadcastPresence()
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') return
    if (message === 'ping') {
      ws.send('pong')
      return
    }
    ws.send(JSON.stringify({ type: 'error', message: 'WebSocket 仅用于服务端事件推送，请通过 HTTP API 写入。' } satisfies CompanionSocketMessage))
  }

  webSocketClose(): void {
    this.broadcastPresence()
  }

  webSocketError(): void {
    this.broadcastPresence()
  }

  private broadcast(message: CompanionSocketMessage, tag?: string): void {
    const payload = JSON.stringify(message)
    for (const socket of this.ctx.getWebSockets(tag)) {
      try {
        socket.send(payload)
      } catch {
        // The close/error callback will update presence.
      }
    }
  }

  private async requireAuthorization(
    deviceId: string,
    token: string,
    requiredRole?: CompanionDeviceRole
  ): Promise<CompanionDevice> {
    const device = await this.authorize(deviceId, token, requiredRole)
    if (!device) throw new Error('设备认证失败。')
    return device
  }

  private broadcastPresence(): void {
    this.broadcast({ type: 'presence.updated', presence: this.getPresence() })
  }

  private async sendBackgroundPush(event: CompanionSyncEvent): Promise<void> {
    if (!this.env.APNS_TEAM_ID || !this.env.APNS_KEY_ID || !this.env.APNS_PRIVATE_KEY || !this.env.APNS_TOPIC) return
    const tokens = this.ctx.storage.sql.exec<{ push_token: string }>(`
      SELECT push_token FROM devices
      WHERE role = 'ios' AND revoked_at IS NULL AND push_token IS NOT NULL
    `).toArray()
    if (tokens.length === 0) return
    const jwt = await createApnsJwt(this.env.APNS_TEAM_ID, this.env.APNS_KEY_ID, this.env.APNS_PRIVATE_KEY)
    const host = this.env.APNS_ENVIRONMENT === 'production'
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com'
    await Promise.all(tokens.map(async ({ push_token: pushToken }) => {
      const response = await fetch(`${host}/3/device/${pushToken}`, {
        method: 'POST',
        headers: {
          authorization: `bearer ${jwt}`,
          'apns-topic': this.env.APNS_TOPIC as string,
          'apns-push-type': 'background',
          'apns-priority': '5',
          'apns-collapse-id': `companion-${event.entityType}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ aps: { 'content-available': 1 }, sequence: event.sequence })
      })
      if (!response.ok) {
        console.error(JSON.stringify({
          message: 'companion APNs delivery failed',
          status: response.status,
          deviceTokenSuffix: pushToken.slice(-6)
        }))
      }
    }))
  }
}

function base64Url(input: ArrayBuffer | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function pemBytes(pem: string): ArrayBuffer {
  const encoded = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '')
  const binary = atob(encoded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer
}

async function createApnsJwt(teamId: string, keyId: string, privateKey: string): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: 'ES256', kid: keyId }))
  const claims = base64Url(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1_000) }))
  const signingInput = `${header}.${claims}`
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemBytes(privateKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput)
  )
  return `${signingInput}.${base64Url(signature)}`
}
