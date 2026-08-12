import { DurableObject } from 'cloudflare:workers'
import type {
  CompanionCommand,
  CompanionCommandInput,
  CompanionCommandUpdate,
  CompanionDevice,
  CompanionDeviceRole,
  CompanionEventBatchResult,
  CompanionEventPage,
  CompanionPairingClaimInput,
  CompanionPairingClaimResult,
  CompanionPresence,
  CompanionSocketMessage,
  CompanionSyncEvent,
  CompanionSyncEventInput
} from '../../../src/shared/companion-sync'
import { companionProtocolVersion } from '../../../src/shared/companion-sync'
import { agentTurnAlertRequest } from './push-notifications'

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

interface PushDeviceRow extends Record<string, SqlStorageValue> {
  id: string
  push_token: string
}

const lastSeenWriteIntervalMs = 5 * 60_000
const artifactCommandResultMaximumBytes = 128 * 1024

function persistedCommandUpdate(
  commandType: CompanionCommand['type'],
  update: CompanionCommandUpdate
): CompanionCommandUpdate {
  if (commandType !== 'artifact.request-upload' || update.result === undefined) {
    const { result: _discardedResult, ...statusOnlyUpdate } = update
    return statusOnlyUpdate
  }
  const serialized = JSON.stringify(update.result)
  if (new TextEncoder().encode(serialized).byteLength <= artifactCommandResultMaximumBytes) return update
  return {
    status: 'failed',
    error: '附件上传结果过大，Relay 未保存；请从 iPhone 重新请求附件。'
  }
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
  private apnsAuthorization: { value: string; expiresAt: number } | null = null

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
    const suppliedHash = await secretHash(input.pairingSecret)
    const pairing = this.ctx.storage.sql.exec<{
      secret_hash: string
      expires_at: string
      claimed_at: string | null
    }>('SELECT secret_hash, expires_at, claimed_at FROM pairing WHERE id = 1').toArray()[0]
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
    const suppliedHash = await secretHash(token)
    const row = this.ctx.storage.sql.exec<DeviceRow>(
      'SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL',
      deviceId
    ).toArray()[0]
    if (!row || !secretsEqual(row.token_hash, suppliedHash) || (requiredRole && row.role !== requiredRole)) {
      return null
    }
    const previousLastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0
    if (Date.now() - previousLastSeen < lastSeenWriteIntervalMs) return mapDevice(row)
    const lastSeenAt = new Date().toISOString()
    this.ctx.storage.sql.exec('UPDATE devices SET last_seen_at = ? WHERE id = ?', lastSeenAt, deviceId)
    return { ...mapDevice(row), lastSeenAt }
  }

  async appendEvent(
    deviceId: string,
    token: string,
    input: CompanionSyncEventInput
  ): Promise<CompanionSyncEvent | null> {
    const device = await this.authorize(deviceId, token, 'mac')
    if (!device) return null
    const { event, inserted } = this.persistEvent(input, deviceId)
    if (inserted) this.notifyEventsAvailable([event])
    return event
  }

  async appendEvents(
    deviceId: string,
    token: string,
    inputs: CompanionSyncEventInput[]
  ): Promise<CompanionEventBatchResult | null> {
    const device = await this.authorize(deviceId, token, 'mac')
    if (!device) return null
    const persisted = this.ctx.storage.transactionSync(() => inputs.map((input) => this.persistEvent(input, deviceId)))
    const inserted = persisted.filter((result) => result.inserted).map((result) => result.event)
    if (inserted.length > 0) this.notifyEventsAvailable(inserted)
    const events = persisted.map((result) => result.event)
    return {
      accepted: events.map((event) => ({ eventId: event.eventId, sequence: event.sequence })),
      lastSequence: events.reduce((latest, event) => Math.max(latest, event.sequence), 0)
    }
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

  async syncPage(
    deviceId: string,
    token: string,
    after: number,
    limit: number
  ): Promise<CompanionEventPage | null> {
    const device = await this.authorize(deviceId, token)
    if (!device) return null
    const events = this.ctx.storage.sql.exec<EventRow>(
      'SELECT * FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?',
      after,
      limit
    ).toArray().map(mapEvent)
    return {
      events,
      lastSequence: events.at(-1)?.sequence ?? after,
      presence: this.getPresence()
    }
  }

  async createCommand(deviceId: string, token: string, input: CompanionCommandInput): Promise<CompanionCommand> {
    await this.requireAuthorization(deviceId, token, 'ios')
    const inserted = this.ctx.storage.sql.exec<CommandRow>(
      `INSERT OR IGNORE INTO commands (
        command_id, protocol_version, type, payload_json, source_device_id,
        status, result_json, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, ?) RETURNING *`,
      input.commandId,
      input.protocolVersion,
      input.type,
      JSON.stringify(input.payload),
      deviceId,
      input.createdAt,
      input.createdAt
    ).toArray()[0]
    const command = mapCommand(inserted ?? this.ctx.storage.sql.exec<CommandRow>(
      'SELECT * FROM commands WHERE command_id = ?', input.commandId
    ).one())
    if (inserted) this.broadcast({ type: 'command.created', command }, 'role:mac')
    return command
  }

  async listPendingCommands(deviceId: string, token: string): Promise<CompanionCommand[]> {
    await this.requireAuthorization(deviceId, token, 'mac')
    return this.ctx.storage.sql.exec<CommandRow>(
      `SELECT * FROM commands WHERE status IN ('queued', 'delivered', 'executing') ORDER BY created_at ASC LIMIT 100`
    ).toArray().map(mapCommand)
  }

  async pendingCommands(deviceId: string, token: string): Promise<CompanionCommand[] | null> {
    const device = await this.authorize(deviceId, token, 'mac')
    if (!device) return null
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
    const existing = this.ctx.storage.sql.exec<CommandRow>(
      'SELECT * FROM commands WHERE command_id = ?', commandId
    ).toArray()[0]
    if (!existing) throw new Error('远程命令不存在。')
    if (existing.status === 'completed' || existing.status === 'failed') {
      if (existing.status === update.status) return mapCommand(existing)
      throw new Error('远程命令已经结束，不能修改状态。')
    }
    const allowedTransitions: Record<CompanionCommand['status'], CompanionCommandUpdate['status'][]> = {
      queued: ['delivered', 'executing', 'completed', 'failed'],
      delivered: ['executing', 'completed', 'failed'],
      executing: ['completed', 'failed'],
      completed: [],
      failed: []
    }
    if (!allowedTransitions[existing.status].includes(update.status)) {
      throw new Error(`远程命令不能从 ${existing.status} 回退到 ${update.status}。`)
    }
    const persistedUpdate = persistedCommandUpdate(existing.type, update)
    const updatedAt = new Date().toISOString()
    const updated = this.ctx.storage.sql.exec<CommandRow>(
      `UPDATE commands SET status = ?, result_json = ?, error = ?, updated_at = ?
       WHERE command_id = ? RETURNING *`,
      persistedUpdate.status,
      persistedUpdate.result === undefined ? null : JSON.stringify(persistedUpdate.result),
      persistedUpdate.error ?? null,
      updatedAt,
      commandId
    ).one()
    const command = mapCommand(updated)
    const commandRevision = persistedUpdate.status === 'delivered' ? 1 : persistedUpdate.status === 'executing' ? 2 : 3
    const { event, inserted } = this.persistEvent({
      eventId: `${commandId}:${update.status}`,
      protocolVersion: companionProtocolVersion,
      type: 'command.updated',
      entityType: 'command',
      entityId: commandId,
      revision: commandRevision,
      payload: command,
      occurredAt: updatedAt
    }, deviceId)
    this.broadcast({ type: 'command.updated', command })
    if (inserted) this.notifyEvent(event, false)
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

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json({ error: 'WebSocket upgrade required.' }, { status: 426 })
    }
    const url = new URL(request.url)
    const deviceId = url.searchParams.get('deviceId')?.trim() ?? ''
    const authorization = request.headers.get('Authorization') ?? ''
    const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : ''
    if (!deviceId || !token) return Response.json({ error: '设备认证失败。' }, { status: 401 })
    const device = await this.authorize(deviceId, token)
    if (!device) return Response.json({ error: '设备认证失败。' }, { status: 401 })
    const role = device.role
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

  private persistEvent(
    input: CompanionSyncEventInput,
    sourceDeviceId: string
  ): { event: CompanionSyncEvent; inserted: boolean } {
    const inserted = this.ctx.storage.sql.exec<EventRow>(
      `INSERT OR IGNORE INTO events (
        event_id, protocol_version, type, entity_type, entity_id, revision,
        payload_json, source_device_id, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      input.eventId,
      input.protocolVersion,
      input.type,
      input.entityType,
      input.entityId,
      input.revision,
      JSON.stringify(input.payload),
      sourceDeviceId,
      input.occurredAt
    ).toArray()[0]
    const row = inserted ?? this.ctx.storage.sql.exec<EventRow>(
      'SELECT * FROM events WHERE event_id = ?', input.eventId
    ).one()
    return { event: mapEvent(row), inserted: inserted !== undefined }
  }

  private notifyEvent(event: CompanionSyncEvent, broadcast: boolean): void {
    if (broadcast) this.broadcast({ type: 'sync.event', event })
    const alert = agentTurnAlertRequest(event)
    this.ctx.waitUntil(alert ? this.sendAlertPush(event, alert) : this.sendBackgroundPush(event))
  }

  private notifyEventsAvailable(events: CompanionSyncEvent[]): void {
    const latest = events.reduce((current, event) => event.sequence > current.sequence ? event : current)
    this.broadcast({ type: 'sync.available', lastSequence: latest.sequence })
    const alerts = events.flatMap((event) => {
      const alert = agentTurnAlertRequest(event)
      return alert ? [{ event, alert }] : []
    })
    if (alerts.length > 0) {
      for (const { event, alert } of alerts) this.ctx.waitUntil(this.sendAlertPush(event, alert))
    } else {
      this.ctx.waitUntil(this.sendBackgroundPush(latest))
    }
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
    await this.sendPush(
      {
        pushType: 'background',
        priority: '5',
        collapseId: `companion-${event.entityType}`,
        body: { aps: { 'content-available': 1 }, sequence: event.sequence }
      },
      false
    )
  }

  private async sendAlertPush(
    event: CompanionSyncEvent,
    alert: { collapseId: string; body: Record<string, unknown> }
  ): Promise<void> {
    await this.sendPush({
      pushType: 'alert',
      priority: '10',
      collapseId: alert.collapseId,
      body: alert.body
    }, true)
  }

  private async sendPush(
    request: {
      pushType: 'alert' | 'background'
      priority: '5' | '10'
      collapseId: string
      body: Record<string, unknown>
    },
    includeConnectedDevices: boolean
  ): Promise<void> {
    if (!this.env.APNS_TEAM_ID || !this.env.APNS_KEY_ID || !this.env.APNS_PRIVATE_KEY || !this.env.APNS_TOPIC) return
    const devices = this.ctx.storage.sql.exec<PushDeviceRow>(`
      SELECT id, push_token FROM devices
      WHERE role = 'ios' AND revoked_at IS NULL AND push_token IS NOT NULL
    `).toArray().filter((device) => includeConnectedDevices || this.ctx.getWebSockets(`device:${device.id}`).length === 0)
    if (devices.length === 0) return
    const jwt = await this.apnsAuthorizationToken()
    const host = this.env.APNS_ENVIRONMENT === 'production'
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com'
    await Promise.all(devices.map(async ({ id: deviceId, push_token: pushToken }) => {
      const response = await fetch(`${host}/3/device/${pushToken}`, {
        method: 'POST',
        headers: {
          authorization: `bearer ${jwt}`,
          'apns-topic': this.env.APNS_TOPIC as string,
          'apns-push-type': request.pushType,
          'apns-priority': request.priority,
          'apns-collapse-id': request.collapseId,
          'content-type': 'application/json'
        },
        body: JSON.stringify(request.body)
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { reason?: unknown } | null
        const reason = typeof body?.reason === 'string' ? body.reason : 'Unknown'
        if (response.status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(reason)) {
          this.ctx.storage.sql.exec('UPDATE devices SET push_token = NULL WHERE id = ?', deviceId)
        }
        console.error(JSON.stringify({
          message: 'companion APNs delivery failed',
          status: response.status,
          reason,
          deviceId
        }))
      }
    }))
  }

  private async apnsAuthorizationToken(): Promise<string> {
    if (this.apnsAuthorization && this.apnsAuthorization.expiresAt > Date.now()) {
      return this.apnsAuthorization.value
    }
    const value = await createApnsJwt(
      this.env.APNS_TEAM_ID as string,
      this.env.APNS_KEY_ID as string,
      this.env.APNS_PRIVATE_KEY as string
    )
    this.apnsAuthorization = { value, expiresAt: Date.now() + 50 * 60_000 }
    return value
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
