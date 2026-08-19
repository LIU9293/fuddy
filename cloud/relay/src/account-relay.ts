import { DurableObject } from 'cloudflare:workers'
import type {
  CompanionEncryptedCommand,
  CompanionEncryptedCommandInput,
  CompanionEncryptedEventPage,
  CompanionEncryptedSocketMessage,
  CompanionEncryptedSyncEvent,
  CompanionEncryptedSyncEventInput,
  CompanionCommandUpdate,
  CompanionDevice,
  CompanionDeviceEnrollmentInput,
  CompanionDeviceEnrollmentResult,
  CompanionDeviceRole,
  CompanionEventBatchResult,
  CompanionPairingClaimInput,
  CompanionPairingClaimResult,
  CompanionPresence,
} from '../../../src/shared/companion-sync'
import { companionMinimumProtocolVersion, companionProtocolVersion } from '../../../src/shared/companion-sync'

interface DeviceRow extends Record<string, SqlStorageValue> {
  id: string
  role: CompanionDeviceRole
  platform: 'macos' | 'ios'
  name: string
  token_hash: string
  public_key: string | null
  grant_generation: string | null
  created_at: string
  last_seen_at: string | null
  revoked_at: string | null
  last_ack_sequence: number
}

interface EventRow extends Record<string, SqlStorageValue> {
  sequence: number
  event_id: string
  protocol_version: number
  type: string
  entity_type: CompanionEncryptedSyncEvent['entityType']
  entity_id: string
  revision: number
  payload_json: string
  source_device_id: string
  occurred_at: string
}

interface CommandRow extends Record<string, SqlStorageValue> {
  command_id: string
  protocol_version: number
  type: CompanionEncryptedCommand['type']
  payload_json: string
  source_device_id: string
  status: CompanionEncryptedCommand['status']
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

interface PushRequest {
  pushType: 'alert' | 'background'
  priority: '5' | '10'
  collapseId: string
  body: Record<string, unknown>
}

const lastSeenWriteIntervalMs = 5 * 60_000
const maximumRetainedEvents = 50_000
const maximumRetainedCommands = 5_000
const terminalCommandRetentionDays = 30
const maintenanceIntervalMs = 24 * 60 * 60 * 1_000

export function agentTurnAlertPushRequest(event: CompanionEncryptedSyncEvent): PushRequest {
  return {
    pushType: 'alert',
    priority: '10',
    collapseId: `agent-turn-${event.entityId}`.slice(0, 64),
    body: {
      aps: {
        alert: { title: 'Agent Run 已结束', body: '打开 Fuddy 查看结果' },
        sound: 'default',
        'content-available': 1
      },
      sequence: event.sequence,
      runId: event.entityId
    }
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

function mapEvent(row: EventRow): CompanionEncryptedSyncEvent {
  return {
    eventId: row.event_id,
    sequence: row.sequence,
    protocolVersion: row.protocol_version,
    type: row.type as CompanionEncryptedSyncEvent['type'],
    entityType: row.entity_type,
    entityId: row.entity_id,
    revision: row.revision,
    payload: JSON.parse(row.payload_json) as unknown,
    sourceDeviceId: row.source_device_id,
    occurredAt: row.occurred_at
  } as unknown as CompanionEncryptedSyncEvent
}

function mapCommand(row: CommandRow): CompanionEncryptedCommand {
  return {
    commandId: row.command_id,
    protocolVersion: row.protocol_version,
    type: row.type,
    payload: JSON.parse(row.payload_json) as unknown,
    sourceDeviceId: row.source_device_id,
    status: row.status,
    // Business outcomes are delivered only inside Mac-authored encrypted
    // command.updated events. Relay command rows expose transport state only.
    result: null,
    error: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } as unknown as CompanionEncryptedCommand
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
        grant_generation TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS account_authority (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        generation INTEGER NOT NULL
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
    if (!deviceColumns.some((column) => column.name === 'last_ack_sequence')) {
      this.ctx.storage.sql.exec('ALTER TABLE devices ADD COLUMN last_ack_sequence INTEGER NOT NULL DEFAULT 0')
    }
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at) VALUES (3, datetime('now'));
    `)
    const encryptedProtocolMigration = this.ctx.storage.sql.exec<{ id: number }>(
      'SELECT id FROM _sql_schema_migrations WHERE id = 4'
    ).toArray()[0]
    if (!encryptedProtocolMigration) {
      // Protocol v1 persisted plaintext event payloads and command outcomes.
      // They cannot be upgraded without the account key, which Relay never has.
      this.ctx.storage.sql.exec(
        'DELETE FROM events WHERE protocol_version < ?',
        companionMinimumProtocolVersion
      )
      this.ctx.storage.sql.exec(
        'DELETE FROM commands WHERE protocol_version < ?',
        companionMinimumProtocolVersion
      )
      this.ctx.storage.sql.exec('UPDATE commands SET result_json = NULL, error = NULL')
      this.ctx.storage.sql.exec(
        `INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (4, datetime('now'))`
      )
    }
    const protocolV4Migration = this.ctx.storage.sql.exec<{ id: number }>(
      'SELECT id FROM _sql_schema_migrations WHERE id = 5'
    ).toArray()[0]
    if (!protocolV4Migration) {
      // Retained encrypted v2/v3 events remain replayable by the v4 iOS client,
      // and the v4 Mac explicitly drains retained encrypted commands. Do not
      // discard acknowledged Mac mutations or queued user actions here.
      this.ctx.storage.sql.exec(
        `INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (5, datetime('now'))`
      )
    }
    if (!deviceColumns.some((column) => column.name === 'grant_generation')) {
      this.ctx.storage.sql.exec('ALTER TABLE devices ADD COLUMN grant_generation TEXT')
    }
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at) VALUES (6, datetime('now'));
    `)
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at) VALUES (7, datetime('now'));
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
        minimumProtocolVersion: companionMinimumProtocolVersion,
        protocolVersion: companionProtocolVersion,
        accountId: input.accountId,
        device: mapDevice(row),
        deviceToken
      },
      error: null
    }
  }

  async enrollDevice(
    macDeviceId: string,
    macToken: string,
    accountId: string,
    input: CompanionDeviceEnrollmentInput
  ): Promise<CompanionDeviceEnrollmentResult | null> {
    const mac = await this.authorize(macDeviceId, macToken, 'mac')
    if (!mac) return null
    const now = new Date().toISOString()
    const deviceToken = randomToken()
    const tokenHash = await secretHash(deviceToken)
    this.ctx.storage.sql.exec(
      `INSERT INTO devices (
        id, role, platform, name, token_hash, public_key, grant_generation,
        created_at, last_seen_at, revoked_at
      ) VALUES (?, 'ios', 'ios', ?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(id) DO UPDATE SET
        role = 'ios', platform = 'ios', name = excluded.name, token_hash = excluded.token_hash,
        public_key = excluded.public_key, grant_generation = excluded.grant_generation,
        last_seen_at = NULL, revoked_at = NULL`,
      input.deviceId,
      input.deviceName,
      tokenHash,
      input.publicKey ?? null,
      input.grantId ?? null,
      now
    )
    const row = this.ctx.storage.sql.exec<DeviceRow>('SELECT * FROM devices WHERE id = ?', input.deviceId).one()
    return {
      minimumProtocolVersion: companionMinimumProtocolVersion,
      protocolVersion: companionProtocolVersion,
      accountId,
      device: mapDevice(row),
      deviceToken
    }
  }

  async revokeDevice(
    macDeviceId: string,
    macToken: string,
    deviceId: string,
    grantId?: string
  ): Promise<boolean> {
    const mac = await this.authorize(macDeviceId, macToken, 'mac')
    if (!mac || deviceId === macDeviceId) return false
    const device = this.ctx.storage.sql.exec<DeviceRow>(
      `SELECT * FROM devices WHERE id = ? AND role = 'ios' AND revoked_at IS NULL`,
      deviceId
    ).toArray()[0]
    if (!device) return true
    if (grantId && device.grant_generation && device.grant_generation !== grantId) return true
    this.ctx.storage.sql.exec(
      'UPDATE devices SET revoked_at = ?, token_hash = ? WHERE id = ?',
      new Date().toISOString(),
      '',
      deviceId
    )
    for (const socket of this.ctx.getWebSockets(`device:${deviceId}`)) {
      try { socket.close(1000, 'Device revoked') } catch { /* Already closed. */ }
    }
    this.broadcastPresence()
    return true
  }

  async revokeSelfDevice(deviceId: string, token: string): Promise<boolean> {
    const device = await this.authorize(deviceId, token, 'ios')
    if (!device) return false
    this.ctx.storage.sql.exec(
      'UPDATE devices SET revoked_at = ?, token_hash = ? WHERE id = ?',
      new Date().toISOString(),
      '',
      deviceId
    )
    for (const socket of this.ctx.getWebSockets(`device:${deviceId}`)) {
      try { socket.close(1000, 'Device signed out') } catch { /* Already closed. */ }
    }
    this.broadcastPresence()
    return true
  }

  async revokeDeviceByAuthority(deviceId: string, grantId?: string): Promise<boolean> {
    const device = this.ctx.storage.sql.exec<DeviceRow>(
      `SELECT * FROM devices WHERE id = ? AND role = 'ios' AND revoked_at IS NULL`,
      deviceId
    ).toArray()[0]
    if (!device) return true
    if (grantId && device.grant_generation && device.grant_generation !== grantId) return false
    this.ctx.storage.sql.exec(
      'UPDATE devices SET revoked_at = ?, token_hash = ? WHERE id = ?',
      new Date().toISOString(),
      '',
      deviceId
    )
    for (const socket of this.ctx.getWebSockets(`device:${deviceId}`)) {
      try { socket.close(1000, 'Device revoked') } catch { /* Already closed. */ }
    }
    this.broadcastPresence()
    return true
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
    input: CompanionEncryptedSyncEventInput
  ): Promise<CompanionEncryptedSyncEvent | null> {
    const device = await this.authorize(deviceId, token, 'mac')
    if (!device) return null
    this.requireEventCapacity([input])
    const { event, inserted } = this.persistEvent(input, deviceId)
    if (inserted) {
      this.notifyEventsAvailable([event])
      this.ctx.waitUntil(this.ensureMaintenanceAlarm())
    }
    return event
  }

  async appendEvents(
    deviceId: string,
    token: string,
    inputs: CompanionEncryptedSyncEventInput[]
  ): Promise<CompanionEventBatchResult | null> {
    const device = await this.authorize(deviceId, token, 'mac')
    if (!device) return null
    this.requireEventCapacity(inputs)
    const persisted = this.ctx.storage.transactionSync(() => inputs.map((input) => this.persistEvent(input, deviceId)))
    const inserted = persisted.filter((result) => result.inserted).map((result) => result.event)
    if (inserted.length > 0) {
      this.notifyEventsAvailable(inserted)
      this.ctx.waitUntil(this.ensureMaintenanceAlarm())
    }
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

  async listEvents(deviceId: string, token: string, after: number, limit: number): Promise<CompanionEncryptedEventPage> {
    await this.requireAuthorization(deviceId, token)
    const events = this.ctx.storage.sql.exec<EventRow>(
      'SELECT * FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?',
      after,
      limit
    ).toArray().map(mapEvent)
    return {
      minimumProtocolVersion: companionMinimumProtocolVersion,
      protocolVersion: companionProtocolVersion,
      events,
      lastSequence: events.at(-1)?.sequence ?? after
    }
  }

  async syncPage(
    deviceId: string,
    token: string,
    after: number,
    limit: number
  ): Promise<CompanionEncryptedEventPage | null> {
    const device = await this.authorize(deviceId, token)
    if (!device) return null
    if (device.role === 'ios') {
      const acknowledged = Math.min(Math.max(0, after), this.getLastSequence())
      this.ctx.storage.sql.exec(`
        UPDATE devices
        SET last_ack_sequence = MAX(last_ack_sequence, ?)
        WHERE id = ? AND role = 'ios' AND revoked_at IS NULL
      `, acknowledged, deviceId)
      this.compactAcknowledgedEvents()
    }
    const events = this.ctx.storage.sql.exec<EventRow>(
      'SELECT * FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?',
      after,
      limit
    ).toArray().map(mapEvent)
    return {
      minimumProtocolVersion: companionMinimumProtocolVersion,
      protocolVersion: companionProtocolVersion,
      events,
      lastSequence: events.at(-1)?.sequence ?? after,
      presence: this.getPresence()
    }
  }

  async createCommand(deviceId: string, token: string, input: CompanionEncryptedCommandInput): Promise<CompanionEncryptedCommand> {
    await this.requireAuthorization(deviceId, token, 'ios')
    const existing = this.ctx.storage.sql.exec<{ command_id: string }>(
      'SELECT command_id FROM commands WHERE command_id = ?', input.commandId
    ).toArray()[0]
    if (!existing) {
      const count = this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM commands').one().count
      if (count >= maximumRetainedCommands) throw new Error('账户命令存储已达到上限，请等待历史记录清理。')
    }
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
    if (inserted) {
      this.broadcast({ type: 'command.created', command }, 'role:mac')
      this.ctx.waitUntil(this.ensureMaintenanceAlarm())
    }
    return command
  }

  async listPendingCommands(deviceId: string, token: string): Promise<CompanionEncryptedCommand[]> {
    await this.requireAuthorization(deviceId, token, 'mac')
    return this.ctx.storage.sql.exec<CommandRow>(
      `SELECT * FROM commands WHERE status IN ('queued', 'delivered', 'executing') ORDER BY created_at ASC LIMIT 100`
    ).toArray().map(mapCommand)
  }

  async pendingCommands(deviceId: string, token: string): Promise<CompanionEncryptedCommand[] | null> {
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
  ): Promise<CompanionEncryptedCommand> {
    await this.requireAuthorization(deviceId, token, 'mac')
    const existing = this.ctx.storage.sql.exec<CommandRow>(
      'SELECT * FROM commands WHERE command_id = ?', commandId
    ).toArray()[0]
    if (!existing) throw new Error('远程命令不存在。')
    if (existing.status === 'completed' || existing.status === 'failed') {
      if (existing.status === update.status) return mapCommand(existing)
      throw new Error('远程命令已经结束，不能修改状态。')
    }
    const allowedTransitions: Record<CompanionEncryptedCommand['status'], CompanionCommandUpdate['status'][]> = {
      queued: ['delivered', 'executing', 'completed', 'failed'],
      delivered: ['executing', 'completed', 'failed'],
      executing: ['completed', 'failed'],
      completed: [],
      failed: []
    }
    if (!allowedTransitions[existing.status].includes(update.status)) {
      throw new Error(`远程命令不能从 ${existing.status} 回退到 ${update.status}。`)
    }
    const updatedAt = new Date().toISOString()
    const updated = this.ctx.storage.sql.exec<CommandRow>(
      `UPDATE commands SET status = ?, result_json = ?, error = ?, updated_at = ?
       WHERE command_id = ? RETURNING *`,
      update.status,
      null,
      null,
      updatedAt,
      commandId
    ).one()
    const command = mapCommand(updated)
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
    await this.revokeAccountByAuthority()
  }

  setAccountGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error('Relay account generation must be a positive integer.')
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO account_authority (id, generation) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET generation = excluded.generation
       WHERE excluded.generation > account_authority.generation`,
      generation
    )
  }

  async revokeAccountByAuthority(generation?: number): Promise<boolean> {
    const currentGeneration = this.ctx.storage.sql.exec<{ generation: number }>(
      'SELECT generation FROM account_authority WHERE id = 1'
    ).toArray()[0]?.generation
    if (generation !== undefined && currentGeneration !== undefined && generation !== currentGeneration) {
      return false
    }
    const revokedAt = new Date().toISOString()
    this.ctx.storage.sql.exec('UPDATE devices SET revoked_at = ?, token_hash = ?', revokedAt, '')
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.close(1000, 'Account disconnected') } catch { /* Already closed. */ }
    }
    this.ctx.storage.sql.exec('DELETE FROM commands')
    this.ctx.storage.sql.exec('DELETE FROM events')
    this.ctx.storage.sql.exec('DELETE FROM pairing')
    this.ctx.storage.sql.exec('DELETE FROM devices')
    return true
  }

  getLastSequence(): number {
    return this.ctx.storage.sql.exec<{ sequence: number | null }>(
      'SELECT MAX(sequence) AS sequence FROM events'
    ).one().sequence ?? 0
  }

  async alarm(): Promise<void> {
    this.compactAcknowledgedEvents()
    this.pruneTerminalCommands()
    const activeDevices = this.ctx.storage.sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM devices WHERE revoked_at IS NULL'
    ).one().count
    if (activeDevices > 0) await this.ctx.storage.setAlarm(Date.now() + maintenanceIntervalMs)
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
    } satisfies CompanionEncryptedSocketMessage))
    this.broadcastPresence()
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') return
    if (message === 'ping') {
      ws.send('pong')
      return
    }
    ws.send(JSON.stringify({ type: 'error', message: 'WebSocket 仅用于服务端事件推送，请通过 HTTP API 写入。' } satisfies CompanionEncryptedSocketMessage))
  }

  webSocketClose(): void {
    this.broadcastPresence()
  }

  webSocketError(): void {
    this.broadcastPresence()
  }

  private persistEvent(
    input: CompanionEncryptedSyncEventInput,
    sourceDeviceId: string
  ): { event: CompanionEncryptedSyncEvent; inserted: boolean } {
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

  private requireEventCapacity(inputs: CompanionEncryptedSyncEventInput[]): void {
    const uniqueIds = [...new Set(inputs.map((input) => input.eventId))]
    if (uniqueIds.length === 0) return
    const existing = uniqueIds.reduce((count, id) => count + (
      this.ctx.storage.sql.exec<{ event_id: string }>('SELECT event_id FROM events WHERE event_id = ?', id).toArray()[0]
        ? 1
        : 0
    ), 0)
    const retained = this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM events').one().count
    if (retained + uniqueIds.length - existing > maximumRetainedEvents) {
      throw new Error('账户事件存储已达到上限，请先让已配对设备完成同步。')
    }
  }

  private compactAcknowledgedEvents(): void {
    const devices = this.ctx.storage.sql.exec<{ last_ack_sequence: number }>(`
      SELECT last_ack_sequence FROM devices WHERE role = 'ios' AND revoked_at IS NULL
    `).toArray()
    if (devices.length === 0) return
    const minimumAck = Math.min(...devices.map((device) => device.last_ack_sequence))
    if (minimumAck <= 0) return
    const snapshot = this.ctx.storage.sql.exec<{ sequence: number }>(`
      SELECT sequence FROM events
      WHERE type = 'snapshot.created' AND sequence <= ?
      ORDER BY sequence DESC LIMIT 1
    `, minimumAck).toArray()[0]
    if (!snapshot) return
    this.ctx.storage.sql.exec('DELETE FROM events WHERE sequence < ?', snapshot.sequence)
  }

  private pruneTerminalCommands(): void {
    this.ctx.storage.sql.exec(`
      DELETE FROM commands
      WHERE status IN ('completed', 'failed')
        AND updated_at < datetime('now', ?)
    `, `-${terminalCommandRetentionDays} days`)
  }

  private async ensureMaintenanceAlarm(): Promise<void> {
    if (await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + maintenanceIntervalMs)
    }
  }

  private notifyEvent(event: CompanionEncryptedSyncEvent, broadcast: boolean): void {
    if (broadcast) this.broadcast({ type: 'sync.event', event })
    this.ctx.waitUntil(event.type === 'agent-turn.settled'
      ? this.sendAgentTurnAlertPush(event)
      : this.sendBackgroundPush(event))
  }

  private notifyEventsAvailable(events: CompanionEncryptedSyncEvent[]): void {
    const latest = events.reduce((current, event) => event.sequence > current.sequence ? event : current)
    this.broadcast({ type: 'sync.available', lastSequence: latest.sequence })
    const alerts = events.filter((event) => event.type === 'agent-turn.settled')
    if (alerts.length > 0) {
      for (const event of alerts) this.ctx.waitUntil(this.sendAgentTurnAlertPush(event))
    } else {
      this.ctx.waitUntil(this.sendBackgroundPush(latest))
    }
  }

  private broadcast(message: CompanionEncryptedSocketMessage, tag?: string): void {
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

  private async sendBackgroundPush(event: CompanionEncryptedSyncEvent): Promise<void> {
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

  private async sendAgentTurnAlertPush(event: CompanionEncryptedSyncEvent): Promise<void> {
    await this.sendPush(agentTurnAlertPushRequest(event), true)
  }

  private async sendPush(
    request: PushRequest,
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
