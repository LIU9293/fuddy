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
import {
  companionAttachmentObjectMaximumBytes,
  companionMinimumProtocolVersion,
  companionProtocolVersion
} from '../../../src/shared/companion-sync'

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

interface AttachmentRow extends Record<string, SqlStorageValue> {
  attachment_id: string
  storage_key: string
  uploaded_by: string
  sha256: string
  size: number
  account_generation: number | null
  created_at: string
}

interface AttachmentRecord {
  storageKey: string
  uploadedBy: string
  sha256: string
  size: number
}

type AttachmentCommitResult =
  | { status: 'committed' }
  | { status: 'unauthorized' }
  | { status: 'existing'; attachment: AttachmentRecord }

type AttachmentUploadLeaseResult =
  | {
    status: 'ready'
    leaseId: string
    accountGeneration: number | null
  }
  | { status: 'quota-exceeded' }
  | { status: 'account-unbound' }
  | { status: 'upload-in-progress' }
  | { status: 'existing'; attachment: AttachmentRecord }

export type RelayMutationResult<T> =
  | { status: 'accepted'; value: T }
  | { status: 'unauthorized' }
  | { status: 'account-unbound' }
  | { status: 'capacity-exceeded' }

interface AccountAuthorityRow extends Record<string, SqlStorageValue> {
  generation: number
  space_id: string | null
  binding_id: string | null
  binding_expires_at: string | null
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
const attachmentUploadLeaseDurationMs = 5 * 60_000
export const maximumRetainedEvents = 5_000
export const maximumAccountAttachmentBytes = 100 * 1024 * 1024 * 1024
export const maximumRetainedCommands = 1_000
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
        generation INTEGER NOT NULL,
        space_id TEXT,
        binding_id TEXT,
        binding_expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS account_binding_proofs (
        proof_hash TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_cleanup (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        device_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS revoked_commands (
        command_id TEXT PRIMARY KEY,
        revoked_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS revoked_commands_time_idx ON revoked_commands(revoked_at);
      CREATE TABLE IF NOT EXISTS attachments (
        attachment_id TEXT PRIMARY KEY,
        storage_key TEXT NOT NULL UNIQUE,
        uploaded_by TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        account_generation INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachment_upload_leases (
        lease_id TEXT PRIMARY KEY,
        attachment_id TEXT NOT NULL UNIQUE,
        device_id TEXT NOT NULL,
        size INTEGER NOT NULL,
        account_generation INTEGER,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attachment_upload_leases_expiry_idx
        ON attachment_upload_leases(expires_at);
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
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at) VALUES (8, datetime('now'));
    `)
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at) VALUES (9, datetime('now'));
    `)
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at) VALUES (10, datetime('now'));
    `)
    const authorityColumns = this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(account_authority)').toArray()
    if (!authorityColumns.some((column) => column.name === 'space_id')) {
      this.ctx.storage.sql.exec('ALTER TABLE account_authority ADD COLUMN space_id TEXT')
    }
    if (!authorityColumns.some((column) => column.name === 'binding_id')) {
      this.ctx.storage.sql.exec('ALTER TABLE account_authority ADD COLUMN binding_id TEXT')
    }
    if (!authorityColumns.some((column) => column.name === 'binding_expires_at')) {
      this.ctx.storage.sql.exec('ALTER TABLE account_authority ADD COLUMN binding_expires_at TEXT')
    }
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS account_binding_proofs (
        proof_hash TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at) VALUES (11, datetime('now'));
    `)
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at) VALUES (12, datetime('now'));
    `)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS attachment_upload_leases (
        lease_id TEXT PRIMARY KEY,
        attachment_id TEXT NOT NULL UNIQUE,
        device_id TEXT NOT NULL,
        size INTEGER NOT NULL,
        account_generation INTEGER,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attachment_upload_leases_expiry_idx
        ON attachment_upload_leases(expires_at);
      INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at) VALUES (13, datetime('now'));
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
    await this.ctx.storage.setAlarm(new Date(input.expiresAt))
  }

  private hasConfirmedAccountAuthority(): boolean {
    const authority = this.getAccountAuthority()
    return Boolean(authority?.space_id && authority.binding_id && authority.binding_expires_at === null)
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
  ): Promise<RelayMutationResult<CompanionDeviceEnrollmentResult>> {
    const mac = await this.authorize(macDeviceId, macToken, 'mac')
    if (!mac) return { status: 'unauthorized' }
    if (!this.hasConfirmedAccountAuthority()) return { status: 'account-unbound' }
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
      status: 'accepted',
      value: {
        minimumProtocolVersion: companionMinimumProtocolVersion,
        protocolVersion: companionProtocolVersion,
        accountId,
        device: mapDevice(row),
        deviceToken
      }
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
    this.ctx.storage.sql.exec('DELETE FROM attachment_upload_leases WHERE device_id = ?', deviceId)
    this.discardPendingCommandsFromDevice(deviceId)
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
    this.ctx.storage.sql.exec('DELETE FROM attachment_upload_leases WHERE device_id = ?', deviceId)
    this.discardPendingCommandsFromDevice(deviceId)
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
    this.ctx.storage.sql.exec('DELETE FROM attachment_upload_leases WHERE device_id = ?', deviceId)
    this.discardPendingCommandsFromDevice(deviceId)
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

  async createAttachmentUploadLease(
    deviceId: string,
    token: string,
    attachmentId: string,
    size: number
  ): Promise<AttachmentUploadLeaseResult | null> {
    const device = await this.authorize(deviceId, token)
    if (!device) return null
    if (!this.hasConfirmedAccountAuthority()) return { status: 'account-unbound' }
    if (!Number.isSafeInteger(size) || size <= 0 || size > companionAttachmentObjectMaximumBytes) {
      return { status: 'quota-exceeded' }
    }
    const existing = this.ctx.storage.sql.exec<AttachmentRow>(
      'SELECT * FROM attachments WHERE attachment_id = ?',
      attachmentId
    ).toArray()[0]
    if (existing) return { status: 'existing', attachment: this.mapAttachmentRecord(existing) }
    const now = new Date()
    const timestamp = now.toISOString()
    this.ctx.storage.sql.exec('DELETE FROM attachment_upload_leases WHERE expires_at <= ?', timestamp)
    const active = this.ctx.storage.sql.exec<{ lease_id: string }>(
      'SELECT lease_id FROM attachment_upload_leases WHERE attachment_id = ?',
      attachmentId
    ).toArray()[0]
    if (active) return { status: 'upload-in-progress' }
    const retainedBytes = this.ctx.storage.sql.exec<{ bytes: number | null }>(
      'SELECT SUM(size) AS bytes FROM attachments'
    ).one().bytes ?? 0
    const reservedBytes = this.ctx.storage.sql.exec<{ bytes: number | null }>(
      'SELECT SUM(size) AS bytes FROM attachment_upload_leases'
    ).one().bytes ?? 0
    if (retainedBytes + reservedBytes + size > maximumAccountAttachmentBytes) {
      return { status: 'quota-exceeded' }
    }
    const leaseId = crypto.randomUUID()
    const accountGeneration = this.getAccountGeneration()
    this.ctx.storage.sql.exec(
      `INSERT INTO attachment_upload_leases (
        lease_id, attachment_id, device_id, size, account_generation, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      leaseId,
      attachmentId,
      deviceId,
      size,
      accountGeneration,
      new Date(now.getTime() + attachmentUploadLeaseDurationMs).toISOString(),
      timestamp
    )
    return { status: 'ready', leaseId, accountGeneration }
  }

  async cancelAttachmentUploadLease(deviceId: string, token: string, leaseId: string): Promise<void> {
    const device = await this.authorize(deviceId, token)
    if (!device) return
    this.ctx.storage.sql.exec(
      'DELETE FROM attachment_upload_leases WHERE lease_id = ? AND device_id = ?',
      leaseId,
      deviceId
    )
  }

  async commitAttachmentUploadLease(
    deviceId: string,
    token: string,
    input: {
      attachmentId: string
      leaseId: string
      storageKey: string
      sha256: string
      size: number
      accountGeneration: number | null
    }
  ): Promise<AttachmentCommitResult> {
    const device = await this.authorize(deviceId, token)
    if (!device || this.getAccountGeneration() !== input.accountGeneration) {
      return { status: 'unauthorized' }
    }
    const existing = this.ctx.storage.sql.exec<AttachmentRow>(
      'SELECT * FROM attachments WHERE attachment_id = ?',
      input.attachmentId
    ).toArray()[0]
    if (existing) {
      this.ctx.storage.sql.exec(
        'DELETE FROM attachment_upload_leases WHERE lease_id = ? AND device_id = ?',
        input.leaseId,
        deviceId
      )
      return { status: 'existing', attachment: this.mapAttachmentRecord(existing) }
    }
    const lease = this.ctx.storage.sql.exec<{
      attachment_id: string
      device_id: string
      size: number
      account_generation: number | null
      expires_at: string
    }>(
      `SELECT attachment_id, device_id, size, account_generation, expires_at
       FROM attachment_upload_leases WHERE lease_id = ?`,
      input.leaseId
    ).toArray()[0]
    if (!lease
      || lease.attachment_id !== input.attachmentId
      || lease.device_id !== deviceId
      || lease.size !== input.size
      || lease.account_generation !== input.accountGeneration
      || lease.expires_at <= new Date().toISOString()) {
      return { status: 'unauthorized' }
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO attachments (
          attachment_id, storage_key, uploaded_by, sha256, size, account_generation, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.attachmentId,
        input.storageKey,
        deviceId,
        input.sha256,
        input.size,
        input.accountGeneration,
        new Date().toISOString()
      )
      this.ctx.storage.sql.exec('DELETE FROM attachment_upload_leases WHERE lease_id = ?', input.leaseId)
    })
    return { status: 'committed' }
  }

  async resolveAttachmentStorageKey(
    deviceId: string,
    token: string,
    attachmentId: string
  ): Promise<{ storageKey: string | null } | null> {
    const device = await this.authorize(deviceId, token)
    if (!device) return null
    const row = this.ctx.storage.sql.exec<AttachmentRow>(
      'SELECT * FROM attachments WHERE attachment_id = ?',
      attachmentId
    ).toArray()[0]
    return { storageKey: row?.storage_key ?? null }
  }

  async appendEvent(
    deviceId: string,
    token: string,
    input: CompanionEncryptedSyncEventInput
  ): Promise<RelayMutationResult<CompanionEncryptedSyncEvent>> {
    const device = await this.authorize(deviceId, token, 'mac')
    if (!device) return { status: 'unauthorized' }
    if (!this.hasConfirmedAccountAuthority()) return { status: 'account-unbound' }
    const { event, inserted } = this.persistEvent(input, deviceId)
    if (inserted) {
      if (event.type === 'snapshot.created') this.compactEventsToLatestSnapshot()
      this.trimEventRetention()
      this.notifyEventsAvailable([event])
      this.ctx.waitUntil(this.ensureMaintenanceAlarm())
    }
    return { status: 'accepted', value: event }
  }

  async appendEvents(
    deviceId: string,
    token: string,
    inputs: CompanionEncryptedSyncEventInput[]
  ): Promise<RelayMutationResult<CompanionEventBatchResult>> {
    const device = await this.authorize(deviceId, token, 'mac')
    if (!device) return { status: 'unauthorized' }
    if (!this.hasConfirmedAccountAuthority()) return { status: 'account-unbound' }
    const persisted = this.ctx.storage.transactionSync(() => inputs.map((input) => this.persistEvent(input, deviceId)))
    const inserted = persisted.filter((result) => result.inserted).map((result) => result.event)
    if (inserted.length > 0) {
      if (inserted.some((event) => event.type === 'snapshot.created')) {
        this.compactEventsToLatestSnapshot()
      }
      this.trimEventRetention()
      this.notifyEventsAvailable(inserted)
      this.ctx.waitUntil(this.ensureMaintenanceAlarm())
    }
    const events = persisted.map((result) => result.event)
    return {
      status: 'accepted',
      value: {
        accepted: events.map((event) => ({ eventId: event.eventId, sequence: event.sequence })),
        lastSequence: events.reduce((latest, event) => Math.max(latest, event.sequence), 0)
      }
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
      this.compactEventsToLatestSnapshot()
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

  async createCommand(
    deviceId: string,
    token: string,
    input: CompanionEncryptedCommandInput
  ): Promise<RelayMutationResult<CompanionEncryptedCommand>> {
    const device = await this.authorize(deviceId, token, 'ios')
    if (!device) return { status: 'unauthorized' }
    if (!this.hasConfirmedAccountAuthority()) return { status: 'account-unbound' }
    const revoked = this.ctx.storage.sql.exec<{ command_id: string }>(
      'SELECT command_id FROM revoked_commands WHERE command_id = ?', input.commandId
    ).toArray()[0]
    if (revoked) throw new Error('远程命令已被撤销，不能重复提交。')
    const existing = this.ctx.storage.sql.exec<{ command_id: string }>(
      'SELECT command_id FROM commands WHERE command_id = ?', input.commandId
    ).toArray()[0]
    if (!existing) {
      this.pruneTerminalCommands()
      this.pruneOldestTerminalCommandsForCapacity()
      const count = this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM commands').one().count
      if (count >= maximumRetainedCommands) return { status: 'capacity-exceeded' }
    }
    const payloadJson = JSON.stringify(input.payload)
    const inserted = this.ctx.storage.sql.exec<CommandRow>(
      `INSERT OR IGNORE INTO commands (
        command_id, protocol_version, type, payload_json, source_device_id,
        status, result_json, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, ?) RETURNING *`,
      input.commandId,
      input.protocolVersion,
      input.type,
      payloadJson,
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
    return { status: 'accepted', value: command }
  }

  async listPendingCommands(deviceId: string, token: string): Promise<CompanionEncryptedCommand[]> {
    await this.requireAuthorization(deviceId, token, 'mac')
    return this.ctx.storage.sql.exec<CommandRow>(
      `SELECT * FROM commands WHERE status IN ('queued', 'delivered', 'executing') ORDER BY created_at ASC LIMIT 100`
    ).toArray().map(mapCommand)
  }

  async pendingCommands(
    deviceId: string,
    token: string
  ): Promise<{ commands: CompanionEncryptedCommand[]; revokedCommandIds: string[] } | null> {
    const device = await this.authorize(deviceId, token, 'mac')
    if (!device) return null
    return {
      commands: this.ctx.storage.sql.exec<CommandRow>(
        `SELECT * FROM commands WHERE status IN ('queued', 'delivered', 'executing') ORDER BY created_at ASC LIMIT 100`
      ).toArray().map(mapCommand),
      revokedCommandIds: this.ctx.storage.sql.exec<{ command_id: string }>(
        'SELECT command_id FROM revoked_commands ORDER BY revoked_at DESC LIMIT ?',
        maximumRetainedCommands
      ).toArray().map((command) => command.command_id)
    }
  }

  async updateCommand(
    deviceId: string,
    token: string,
    commandId: string,
    update: CompanionCommandUpdate
  ): Promise<RelayMutationResult<CompanionEncryptedCommand>> {
    const device = await this.authorize(deviceId, token, 'mac')
    if (!device) return { status: 'unauthorized' }
    if (!this.hasConfirmedAccountAuthority()) return { status: 'account-unbound' }
    const existing = this.ctx.storage.sql.exec<CommandRow>(
      'SELECT * FROM commands WHERE command_id = ?', commandId
    ).toArray()[0]
    if (!existing) throw new Error('远程命令不存在。')
    if (existing.status === 'completed' || existing.status === 'failed') {
      if (existing.status === update.status) return { status: 'accepted', value: mapCommand(existing) }
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
    return { status: 'accepted', value: command }
  }

  getPresence(): CompanionPresence {
    return {
      macOnline: this.ctx.getWebSockets('role:mac').length > 0,
      iosDevicesOnline: this.ctx.getWebSockets('role:ios').length,
      updatedAt: new Date().toISOString()
    }
  }

  async revokeAccount(deviceId: string, token: string): Promise<boolean> {
    const suppliedHash = await secretHash(token)
    const cleanup = this.ctx.storage.sql.exec<{ device_id: string; token_hash: string }>(
      'SELECT device_id, token_hash FROM account_cleanup WHERE id = 1'
    ).toArray()[0]
    if (cleanup) {
      return cleanup.device_id === deviceId && secretsEqual(cleanup.token_hash, suppliedHash)
    }
    const mac = this.ctx.storage.sql.exec<DeviceRow>(
      `SELECT * FROM devices WHERE id = ? AND role = 'mac' AND revoked_at IS NULL`,
      deviceId
    ).toArray()[0]
    if (!mac || !secretsEqual(mac.token_hash, suppliedHash)) return false
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO account_cleanup (id, device_id, token_hash, created_at)
       VALUES (1, ?, ?, ?)`,
      deviceId,
      suppliedHash,
      new Date().toISOString()
    )
    return this.revokeAccountState(undefined, true)
  }

  async authorizeAccountRevocation(deviceId: string, token: string): Promise<boolean> {
    const suppliedHash = await secretHash(token)
    const cleanup = this.ctx.storage.sql.exec<{ device_id: string; token_hash: string }>(
      'SELECT device_id, token_hash FROM account_cleanup WHERE id = 1'
    ).toArray()[0]
    if (cleanup) {
      return cleanup.device_id === deviceId && secretsEqual(cleanup.token_hash, suppliedHash)
    }
    const mac = this.ctx.storage.sql.exec<DeviceRow>(
      `SELECT * FROM devices WHERE id = ? AND role = 'mac' AND revoked_at IS NULL`,
      deviceId
    ).toArray()[0]
    return Boolean(mac && secretsEqual(mac.token_hash, suppliedHash))
  }

  async completeAccountRevocationCleanup(deviceId: string, token: string): Promise<boolean> {
    const suppliedHash = await secretHash(token)
    const cleanup = this.ctx.storage.sql.exec<{ device_id: string; token_hash: string }>(
      'SELECT device_id, token_hash FROM account_cleanup WHERE id = 1'
    ).toArray()[0]
    if (!cleanup || cleanup.device_id !== deviceId || !secretsEqual(cleanup.token_hash, suppliedHash)) {
      return false
    }
    this.ctx.storage.sql.exec('DELETE FROM account_cleanup WHERE id = 1')
    return true
  }

  async createAccountBindingProof(
    deviceId: string,
    token: string
  ): Promise<{ proof: string; expiresAt: string }> {
    await this.requireAuthorization(deviceId, token, 'mac')
    const proof = randomToken()
    const proofHash = await secretHash(proof)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString()
    this.ctx.storage.sql.exec('DELETE FROM account_binding_proofs WHERE expires_at <= ?', now.toISOString())
    this.ctx.storage.sql.exec('DELETE FROM account_binding_proofs WHERE device_id = ?', deviceId)
    this.ctx.storage.sql.exec(
      `INSERT INTO account_binding_proofs (proof_hash, device_id, expires_at, created_at)
       VALUES (?, ?, ?, ?)`,
      proofHash,
      deviceId,
      expiresAt,
      now.toISOString()
    )
    return { proof, expiresAt }
  }

  async claimAccountBinding(
    spaceId: string,
    bindingId: string,
    generation: number,
    proof: string
  ): Promise<boolean> {
    if (!spaceId.trim() || !bindingId.trim() || !Number.isSafeInteger(generation) || generation < 1) return false
    const proofHash = await secretHash(proof)
    const now = new Date().toISOString()
    return this.ctx.storage.transactionSync(() => {
      const bindingProof = this.ctx.storage.sql.exec<{ device_id: string }>(
        `SELECT device_id FROM account_binding_proofs
         WHERE proof_hash = ? AND expires_at > ?`,
        proofHash,
        now
      ).toArray()[0]
      if (!bindingProof) return false
      const mac = this.ctx.storage.sql.exec<DeviceRow>(
        `SELECT * FROM devices WHERE id = ? AND role = 'mac' AND revoked_at IS NULL`,
        bindingProof.device_id
      ).toArray()[0]
      if (!mac) return false
      let current = this.getAccountAuthority()
      if (current?.binding_expires_at && current.binding_expires_at <= now) {
        this.ctx.storage.sql.exec(
          `UPDATE account_authority
           SET space_id = NULL, binding_id = NULL, binding_expires_at = NULL
           WHERE id = 1 AND binding_expires_at = ?`,
          current.binding_expires_at
        )
        current = this.getAccountAuthority()
      }
      if (current?.space_id && current.space_id !== spaceId) return false
      if (current && generation < current.generation) return false
      this.ctx.storage.sql.exec('DELETE FROM account_binding_proofs WHERE proof_hash = ?', proofHash)
      this.ctx.storage.sql.exec(
        `INSERT INTO account_authority (
          id, generation, space_id, binding_id, binding_expires_at
        ) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET generation = excluded.generation,
           space_id = excluded.space_id, binding_id = excluded.binding_id,
           binding_expires_at = excluded.binding_expires_at`,
        generation,
        spaceId,
        bindingId,
        new Date(Date.now() + 5 * 60_000).toISOString()
      )
      return true
    })
  }

  releaseAccountBinding(spaceId: string, bindingId: string): boolean {
    const released = this.ctx.storage.sql.exec(
      `UPDATE account_authority
       SET space_id = NULL, binding_id = NULL, binding_expires_at = NULL
       WHERE id = 1 AND space_id = ? AND binding_id = ?`,
      spaceId,
      bindingId
    )
    return released.rowsWritten > 0
  }

  confirmAccountBinding(spaceId: string, bindingId: string): boolean {
    const confirmed = this.ctx.storage.sql.exec(
      `UPDATE account_authority SET binding_expires_at = NULL
       WHERE id = 1 AND space_id = ? AND binding_id = ?`,
      spaceId,
      bindingId
    )
    return confirmed.rowsWritten > 0
  }

  setAccountGeneration(spaceId: string, bindingId: string | null, generation: number): boolean {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error('Relay account generation must be a positive integer.')
    }
    const updated = bindingId === null
      ? this.ctx.storage.sql.exec(
        `UPDATE account_authority SET generation = ?
         WHERE id = 1 AND space_id IS NULL AND binding_id IS NULL AND generation <= ?`,
        generation,
        generation
      )
      : this.ctx.storage.sql.exec(
        `UPDATE account_authority SET generation = ?, binding_expires_at = NULL
         WHERE id = 1 AND space_id = ? AND binding_id = ? AND generation <= ?`,
        generation,
        spaceId,
        bindingId,
        generation
      )
    return updated.rowsWritten > 0
  }

  async revokeAccountByAuthority(
    spaceId: string,
    bindingId: string | null,
    generation: number
  ): Promise<boolean> {
    const authority = this.getAccountAuthority()
    const ownerMatches = bindingId === null
      ? authority?.space_id === null && authority.binding_id === null
      : authority?.space_id === spaceId && authority.binding_id === bindingId
    if (!authority || !ownerMatches || authority.generation !== generation) return false
    return this.revokeAccountState(generation, false)
  }

  private revokeAccountState(generation: number | undefined, preserveDirectCleanup: boolean): boolean {
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
    this.ctx.storage.sql.exec('DELETE FROM revoked_commands')
    this.ctx.storage.sql.exec('DELETE FROM events')
    this.ctx.storage.sql.exec('DELETE FROM pairing')
    this.ctx.storage.sql.exec('DELETE FROM attachments')
    this.ctx.storage.sql.exec('DELETE FROM attachment_upload_leases')
    this.ctx.storage.sql.exec('DELETE FROM devices')
    if (!preserveDirectCleanup) this.ctx.storage.sql.exec('DELETE FROM account_cleanup')
    return true
  }

  getLastSequence(): number {
    return this.ctx.storage.sql.exec<{ sequence: number | null }>(
      'SELECT MAX(sequence) AS sequence FROM events'
    ).one().sequence ?? 0
  }

  private getAccountGeneration(): number | null {
    return this.ctx.storage.sql.exec<{ generation: number }>(
      'SELECT generation FROM account_authority WHERE id = 1'
    ).toArray()[0]?.generation ?? null
  }

  private getAccountAuthority(): AccountAuthorityRow | null {
    return this.ctx.storage.sql.exec<AccountAuthorityRow>(
      `SELECT generation, space_id, binding_id, binding_expires_at
       FROM account_authority WHERE id = 1`
    ).toArray()[0] ?? null
  }

  private discardPendingCommandsFromDevice(deviceId: string): void {
    const commandIds = this.ctx.storage.sql.exec<{ command_id: string }>(
      `SELECT command_id FROM commands
       WHERE source_device_id = ? AND status IN ('queued', 'delivered', 'executing')`,
      deviceId
    ).toArray().map((command) => command.command_id)
    const revokedAt = new Date().toISOString()
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO revoked_commands (command_id, revoked_at)
       SELECT command_id, ? FROM commands
       WHERE source_device_id = ? AND status IN ('queued', 'delivered', 'executing')`,
      revokedAt,
      deviceId
    )
    this.ctx.storage.sql.exec(
      `DELETE FROM commands
       WHERE source_device_id = ? AND status IN ('queued', 'delivered', 'executing')`,
      deviceId
    )
    if (commandIds.length > 0) {
      this.broadcast({ type: 'commands.revoked', commandIds }, 'role:mac')
    }
  }

  private mapAttachmentRecord(row: AttachmentRow): AttachmentRecord {
    return {
      storageKey: row.storage_key,
      uploadedBy: row.uploaded_by,
      sha256: row.sha256,
      size: row.size
    }
  }

  async alarm(): Promise<void> {
    const now = new Date()
    const timestamp = now.toISOString()
    const pairing = this.ctx.storage.sql.exec<{ expires_at: string }>(
      'SELECT expires_at FROM pairing WHERE id = 1'
    ).toArray()[0]
    const authority = this.getAccountAuthority()
    if (!this.hasConfirmedAccountAuthority() && pairing && pairing.expires_at <= timestamp) {
      if (authority?.binding_expires_at && authority.binding_expires_at > timestamp) {
        await this.ctx.storage.setAlarm(new Date(authority.binding_expires_at))
        return
      }
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.close(1000, 'Pairing expired') } catch { /* Already closed. */ }
      }
      this.revokeAccountState(undefined, false)
      this.ctx.storage.sql.exec('DELETE FROM account_binding_proofs')
      this.ctx.storage.sql.exec('DELETE FROM account_authority')
      return
    }
    this.compactEventsToLatestSnapshot()
    this.trimEventRetention()
    this.pruneTerminalCommands()
    this.pruneRevokedCommands()
    this.pruneExpiredAttachmentUploadLeases()
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

  private compactEventsToLatestSnapshot(): void {
    const snapshot = this.ctx.storage.sql.exec<{ sequence: number }>(`
      SELECT sequence FROM events
      WHERE type = 'snapshot.created'
      ORDER BY sequence DESC LIMIT 1
    `).toArray()[0]
    if (!snapshot) return
    this.ctx.storage.sql.exec('DELETE FROM events WHERE sequence < ?', snapshot.sequence)
  }

  private trimEventRetention(): void {
    let retainedCount = this.ctx.storage.sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM events'
    ).one().count
    if (retainedCount <= maximumRetainedEvents) return

    const latestSnapshotSequence = this.ctx.storage.sql.exec<{ sequence: number }>(
      `SELECT sequence FROM events WHERE type = 'snapshot.created' ORDER BY sequence DESC LIMIT 1`
    ).toArray()[0]?.sequence ?? null
    while (retainedCount > maximumRetainedEvents) {
      const candidates = this.ctx.storage.sql.exec<{ sequence: number }>(
        `SELECT sequence
         FROM events WHERE (? IS NULL OR sequence != ?)
         ORDER BY sequence ASC LIMIT 1000`,
        latestSnapshotSequence,
        latestSnapshotSequence
      ).toArray()
      if (candidates.length === 0) return
      let cutoff = candidates[0].sequence
      for (const candidate of candidates) {
        cutoff = candidate.sequence
        retainedCount -= 1
        if (retainedCount <= maximumRetainedEvents) break
      }
      if (latestSnapshotSequence === null) {
        this.ctx.storage.sql.exec('DELETE FROM events WHERE sequence <= ?', cutoff)
      } else {
        this.ctx.storage.sql.exec(
          'DELETE FROM events WHERE sequence <= ? AND sequence != ?',
          cutoff,
          latestSnapshotSequence
        )
      }
    }
  }

  private pruneTerminalCommands(): void {
    this.ctx.storage.sql.exec(`
      DELETE FROM commands
      WHERE status IN ('completed', 'failed')
        AND updated_at < datetime('now', ?)
    `, `-${terminalCommandRetentionDays} days`)
  }

  private pruneOldestTerminalCommandsForCapacity(): void {
    const count = this.ctx.storage.sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM commands'
    ).one().count
    if (count < maximumRetainedCommands) return
    this.ctx.storage.sql.exec(
      `DELETE FROM commands WHERE command_id IN (
         SELECT command_id FROM commands
         WHERE status IN ('completed', 'failed')
         ORDER BY updated_at ASC LIMIT 100
       )`
    )
  }

  private pruneExpiredAttachmentUploadLeases(): void {
    this.ctx.storage.sql.exec(
      'DELETE FROM attachment_upload_leases WHERE expires_at <= ?',
      new Date().toISOString()
    )
  }

  private pruneRevokedCommands(): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM revoked_commands WHERE revoked_at < datetime('now', ?)`,
      `-${terminalCommandRetentionDays} days`
    )
    this.ctx.storage.sql.exec(
      `DELETE FROM revoked_commands WHERE command_id IN (
        SELECT command_id FROM revoked_commands
        ORDER BY revoked_at DESC LIMIT -1 OFFSET ?
      )`,
      maximumRetainedCommands
    )
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
