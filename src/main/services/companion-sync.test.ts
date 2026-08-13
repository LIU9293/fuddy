import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { CompanionCommand, CompanionEncryptedCommand, CompanionMacConfiguration, CompanionSyncEventInput } from '../../shared/companion-sync'
import { companionProtocolVersion } from '../../shared/companion-sync'
import {
  companionAccountKeyId,
  companionCommandAssociatedData,
  generateCompanionAccountKey,
  sealCompanionJson
} from '../../shared/companion-crypto'
import type { AgentRunMessage } from '../../shared/contracts'
import {
  companionAgentMessageForRelay,
  companionAttachmentStorageId,
  companionCommandUpdateForRelay,
  companionCommandRecovery,
  companionConnectedFallbackSyncIntervalMs,
  companionEventBatchMaximumBytes,
  companionEventBatchMaximumCount,
  companionFallbackSyncIntervalForState,
  companionFallbackSyncIntervalMs,
  companionReconnectDelayMs,
  companionRequestTimeoutMs,
  companionSocketHeartbeatIntervalMs,
  companionSocketHeartbeatShouldReconnect,
  companionSocketMessageRequestsSync,
  companionToolSummaryMaximumCharacters,
  partitionCompanionEventBatches,
  CompanionSyncService
} from './companion-sync'
import type { CredentialVault } from './credential-vault'
import { AppDatabase } from './database'
import { createTestDatabase } from '../test-support/project-fixtures'
import type { TaskDispatcher } from './task-dispatcher'
import { WorkspaceFilesService } from './workspace-files'

const directories: string[] = []
const testEncryptionKey = generateCompanionAccountKey()

async function encryptedCommand(command: CompanionCommand): Promise<CompanionEncryptedCommand> {
  return {
    ...command,
    payload: await sealCompanionJson(
      testEncryptionKey,
      command.payload,
      companionCommandAssociatedData(command)
    ),
    result: null,
    error: null
  }
}

function testCredentials(): CredentialVault {
  return {
    get: (reference: string) => reference.startsWith('companion.account-key:') ? testEncryptionKey : 'test-token'
  } as unknown as CredentialVault
}

afterAll(() => {
  vi.unstubAllGlobals()
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('Companion sync transport policy', () => {
  it('uses stable content-versioned IDs for artifact attachments', () => {
    const first = companionAttachmentStorageId('artifact-1', 'a'.repeat(64))
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(companionAttachmentStorageId('artifact-1', 'A'.repeat(64))).toBe(first)
    expect(companionAttachmentStorageId('artifact-1', 'b'.repeat(64))).not.toBe(first)
    expect(companionAttachmentStorageId('artifact-2', 'a'.repeat(64))).not.toBe(first)
  })

  it('uses a one-minute fallback instead of high-frequency polling', () => {
    expect(companionFallbackSyncIntervalMs).toBe(60_000)
    expect(companionConnectedFallbackSyncIntervalMs).toBe(300_000)
    expect(companionFallbackSyncIntervalForState('connected')).toBe(300_000)
    expect(companionFallbackSyncIntervalForState('disconnected')).toBe(60_000)
  })

  it('partitions relay events by count and serialized byte size', () => {
    const event = (index: number, payload = 'small'): CompanionSyncEventInput => ({
      eventId: `event-${index}`,
      protocolVersion: companionProtocolVersion,
      type: 'agent-message.created',
      entityType: 'agent-message' as const,
      entityId: `message-${index}`,
      revision: index,
      payload,
      occurredAt: new Date().toISOString()
    } as unknown as CompanionSyncEventInput)
    const byCount = partitionCompanionEventBatches(
      Array.from({ length: companionEventBatchMaximumCount + 1 }, (_, index) => event(index))
    )
    expect(byCount.map((batch) => batch.length)).toEqual([companionEventBatchMaximumCount, 1])

    const byBytes = partitionCompanionEventBatches([
      event(1, 'a'.repeat(companionEventBatchMaximumBytes / 2)),
      event(2, 'b'.repeat(companionEventBatchMaximumBytes / 2))
    ])
    expect(byBytes).toHaveLength(2)
  })

  it('keeps full tool output local and sends only a bounded relay summary', () => {
    const message: AgentRunMessage = {
      id: 'tool-1',
      runId: 'run-1',
      role: 'tool',
      content: `first line\n${'secret-output '.repeat(100)}`,
      eventType: 'tool',
      toolName: 'Bash',
      metadata: { status: 'failed', arguments: { command: 'private command' } },
      createdAt: new Date().toISOString()
    }
    const relayMessage = companionAgentMessageForRelay(message)
    expect(relayMessage.content.length).toBeLessThanOrEqual(companionToolSummaryMaximumCharacters + 1)
    expect(relayMessage.content).not.toContain('\n')
    expect(relayMessage.metadata).toBeNull()
    expect(relayMessage.toolStatus).toBe('failed')
    expect(message.content.length).toBeGreaterThan(relayMessage.content.length)
  })

  it('backs WebSocket reconnects off to one minute', () => {
    expect([0, 1, 2, 3, 10].map(companionReconnectDelayMs)).toEqual([
      5_000,
      15_000,
      60_000,
      60_000,
      60_000
    ])
  })

  it('reconnects a realtime socket after one missed heartbeat response', () => {
    expect(companionSocketHeartbeatIntervalMs).toBe(20_000)
    expect(companionSocketHeartbeatShouldReconnect(false)).toBe(false)
    expect(companionSocketHeartbeatShouldReconnect(true)).toBe(true)
  })

  it('bounds relay requests and catches up as soon as a socket reconnects', () => {
    expect(companionRequestTimeoutMs).toBe(30_000)
    expect(companionSocketMessageRequestsSync({
      type: 'sync.ready',
      lastSequence: 3,
      presence: { macOnline: true, iosDevicesOnline: 1, updatedAt: new Date().toISOString() }
    })).toBe(true)
    expect(companionSocketMessageRequestsSync({ type: 'presence.updated', presence: {
      macOnline: true,
      iosDevicesOnline: 1,
      updatedAt: new Date().toISOString()
    } })).toBe(false)
  })

  it('never replays a command that may already have produced side effects', () => {
    expect(companionCommandRecovery(null)).toBe('execute')
    expect(companionCommandRecovery('queued')).toBe('execute')
    expect(companionCommandRecovery('executing')).toBe('fail-interrupted')
    expect(companionCommandRecovery('completed')).toBe('ack-terminal')
    expect(companionCommandRecovery('failed')).toBe('ack-terminal')
  })

  it('keeps every command result behind the encrypted event channel', () => {
    const largeResult = { detail: 'x'.repeat(3 * 1024 * 1024) }
    expect(companionCommandUpdateForRelay('agent.send-message', {
      status: 'completed',
      result: largeResult
    })).toEqual({ status: 'completed' })
    expect(companionCommandUpdateForRelay('artifact.request-upload', {
      status: 'completed',
      result: largeResult
    })).toEqual({ status: 'completed' })
  })

  it('continues publishing Agent progress while a remote turn is still running', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'project-agent-companion-sync-'))
    directories.push(directory)
    const database = createTestDatabase(join(directory, 'app.sqlite'))
    const configuration: CompanionMacConfiguration = {
      relayUrl: 'https://relay.example.com',
      accountId: 'test-account',
      macDeviceId: 'test-mac',
      pairedAt: new Date().toISOString(),
      encryptionKeyId: await companionAccountKeyId(testEncryptionKey)
    }
    database.setSetting('companion.mac-configuration', configuration)
    const credentials = testCredentials()
    let finishTurn: (() => void) | undefined
    const turn = new Promise<void>((resolve) => { finishTurn = resolve })
    const sendMessage = vi.fn(() => turn)
    const dispatcher = { sendMessage } as unknown as TaskDispatcher
    const now = new Date().toISOString()
    const command: CompanionCommand = {
      commandId: 'remote-agent-message',
      protocolVersion: companionProtocolVersion,
      type: 'agent.send-message',
      payload: {
        runId: 'run-from-phone',
        prompt: '请继续分析',
        clientMessageId: 'phone-message-id'
      },
      sourceDeviceId: 'test-phone',
      status: 'queued',
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now
    }
    const wireCommand = await encryptedCommand(command)
    let remoteStatus: CompanionCommand['status'] = 'queued'
    const publishedEventTypes: string[] = []
    const fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      const method = init.method ?? 'GET'
      if (url.pathname === '/v1/commands/pending' && method === 'GET') {
        return jsonResponse({ commands: remoteStatus === 'queued' ? [wireCommand] : [] })
      }
      if (url.pathname === `/v1/commands/${command.commandId}` && method === 'PATCH') {
        const update = JSON.parse(String(init.body)) as { status: CompanionCommand['status'] }
        remoteStatus = update.status
        return jsonResponse({ command: { ...command, status: remoteStatus } })
      }
      if (url.pathname === '/v1/events/batch' && method === 'POST') {
        const body = JSON.parse(String(init.body)) as { events: Array<{ type: string }> }
        publishedEventTypes.push(...body.events.map((event) => event.type))
        return jsonResponse({
          accepted: body.events.map((event, index) => ({ eventId: event.type, sequence: index + 1 })),
          lastSequence: body.events.length
        }, 201)
      }
      throw new Error(`Unexpected relay request: ${method} ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const service = new CompanionSyncService(
      database,
      credentials,
      dispatcher,
      async () => ({ accepted: true })
    )

    await service.syncNow()
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        'run-from-phone',
        '请继续分析',
        expect.any(Function),
        'phone-message-id'
      )
      expect(database.getCompanionCommand(command.commandId)?.status).toBe('executing')
    })

    database.enqueueCompanionSnapshot()
    await service.syncNow()
    expect(publishedEventTypes).toContain('snapshot.created')
    expect(database.getCompanionCommand(command.commandId)?.status).toBe('executing')

    finishTurn?.()
    await vi.waitFor(() => {
      expect(database.getCompanionCommand(command.commandId)?.status).toBe('completed')
    })
    service.stop()
    database.close()
  })

  it('uploads a project-file artifact when iPhone requests it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'project-agent-companion-artifact-'))
    directories.push(directory)
    const database = createTestDatabase(join(directory, 'app.sqlite'))
    const files = new WorkspaceFilesService(database, join(directory, 'project-files'))
    files.write('vows', 'notes/launch.md', '# Launch')
    const now = new Date().toISOString()
    database.createAgentRun({
      id: 'artifact-run',
      projectId: 'vows',
      provider: 'codex',
      title: 'Artifact run',
      status: 'idle',
      sessionId: null,
      workingDirectory: join(directory, 'run-workspace'),
      startedAt: now,
      completedAt: null,
      summary: '',
      draftPrompt: null,
      createdAt: now,
      updatedAt: now
    })
    database.upsertAgentRunArtifact({
      id: 'artifact-from-project-files',
      runId: 'artifact-run',
      projectId: 'vows',
      relativePath: 'notes/launch.md',
      label: 'launch.md',
      mimeType: 'text/markdown',
      createdAt: now
    })
    const configuration: CompanionMacConfiguration = {
      relayUrl: 'https://relay.example.com',
      accountId: 'test-account',
      macDeviceId: 'test-mac',
      pairedAt: now,
      encryptionKeyId: await companionAccountKeyId(testEncryptionKey)
    }
    database.setSetting('companion.mac-configuration', configuration)
    const credentials = testCredentials()
    const command: CompanionCommand = {
      commandId: 'request-project-artifact',
      protocolVersion: companionProtocolVersion,
      type: 'artifact.request-upload',
      payload: { artifactId: 'artifact-from-project-files' },
      sourceDeviceId: 'test-phone',
      status: 'queued',
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now
    }
    const wireCommand = await encryptedCommand(command)
    let remoteStatus: CompanionCommand['status'] = 'queued'
    let uploaded = false
    const plaintextSha256 = 'df1e79ca2a1b6778e23b1419d39f840201d65bd85531e9464bdd86bad678c046'
    const attachmentId = companionAttachmentStorageId('artifact-from-project-files', plaintextSha256)
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      const method = init.method ?? 'GET'
      if (url.pathname === '/v1/events/batch' && method === 'POST') {
        const body = JSON.parse(String(init.body)) as { events: unknown[] }
        return jsonResponse({
          accepted: body.events.map((_, index) => ({ eventId: `event-${index}`, sequence: index + 1 })),
          lastSequence: body.events.length
        }, 201)
      }
      if (url.pathname === '/v1/commands/pending' && method === 'GET') {
        return jsonResponse({ commands: remoteStatus === 'queued' ? [wireCommand] : [] })
      }
      if (url.pathname === `/v1/commands/${command.commandId}` && method === 'PATCH') {
        const update = JSON.parse(String(init.body)) as {
          status: CompanionCommand['status']
        }
        remoteStatus = update.status
        return jsonResponse({ ...wireCommand, status: remoteStatus })
      }
      if (url.pathname === `/v1/attachments/${attachmentId}` && method === 'PUT') {
        uploaded = true
        expect(new Headers(init.headers).get('Content-Type')).toBe('application/octet-stream')
        expect(new Headers(init.headers).get('X-Companion-Encryption')).toBe('A256GCM')
        return jsonResponse({ accepted: true }, 201)
      }
      throw new Error(`Unexpected relay request: ${method} ${url.pathname}`)
    }))
    const service = new CompanionSyncService(
      database,
      credentials,
      {} as TaskDispatcher,
      async () => ({ accepted: true }),
      join(directory, 'incoming'),
      () => 'codex',
      files
    )

    await service.syncNow()
    await vi.waitFor(() => {
      expect(uploaded).toBe(true)
      expect(remoteStatus).toBe('completed')
      expect(database.getCompanionCommand(command.commandId)?.result).toMatchObject({
        artifactId: 'artifact-from-project-files',
        attachment: {
          id: attachmentId,
          artifactId: 'artifact-from-project-files',
          filename: 'launch.md',
          mimeType: 'text/markdown',
          size: 8
        }
      })
    })
    service.stop()
    database.close()
  })
})
