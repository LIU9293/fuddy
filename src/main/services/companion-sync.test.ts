import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { CompanionCommand, CompanionMacConfiguration } from '../../shared/companion-sync'
import {
  companionCommandRecovery,
  companionFallbackSyncIntervalMs,
  companionReconnectDelayMs,
  companionRequestTimeoutMs,
  companionSocketHeartbeatIntervalMs,
  companionSocketHeartbeatShouldReconnect,
  companionSocketMessageRequestsSync,
  CompanionSyncService
} from './companion-sync'
import type { CredentialVault } from './credential-vault'
import { AppDatabase } from './database'
import type { TaskDispatcher } from './task-dispatcher'
import { WorkspaceFilesService } from './workspace-files'

const directories: string[] = []

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
  it('uses a one-minute fallback instead of high-frequency polling', () => {
    expect(companionFallbackSyncIntervalMs).toBe(60_000)
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

  it('continues publishing Agent progress while a remote turn is still running', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'project-agent-companion-sync-'))
    directories.push(directory)
    const database = new AppDatabase(join(directory, 'app.sqlite'))
    const configuration: CompanionMacConfiguration = {
      relayUrl: 'https://relay.example.com',
      accountId: 'test-account',
      macDeviceId: 'test-mac',
      pairedAt: new Date().toISOString()
    }
    database.setSetting('companion.mac-configuration', configuration)
    const credentials = {
      get: () => 'test-token'
    } as unknown as CredentialVault
    let finishTurn: (() => void) | undefined
    const turn = new Promise<void>((resolve) => { finishTurn = resolve })
    const sendMessage = vi.fn(() => turn)
    const dispatcher = { sendMessage } as unknown as TaskDispatcher
    const now = new Date().toISOString()
    const command: CompanionCommand = {
      commandId: 'remote-agent-message',
      protocolVersion: 1,
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
    let remoteStatus: CompanionCommand['status'] = 'queued'
    const publishedEventTypes: string[] = []
    const fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      const method = init.method ?? 'GET'
      if (url.pathname === '/v1/commands/pending' && method === 'GET') {
        return jsonResponse({ commands: remoteStatus === 'queued' ? [command] : [] })
      }
      if (url.pathname === `/v1/commands/${command.commandId}` && method === 'PATCH') {
        const update = JSON.parse(String(init.body)) as { status: CompanionCommand['status'] }
        remoteStatus = update.status
        return jsonResponse({ command: { ...command, status: remoteStatus } })
      }
      if (url.pathname === '/v1/events' && method === 'POST') {
        const event = JSON.parse(String(init.body)) as { type: string }
        publishedEventTypes.push(event.type)
        return jsonResponse({ accepted: true }, 201)
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
    const database = new AppDatabase(join(directory, 'app.sqlite'))
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
      pairedAt: now
    }
    database.setSetting('companion.mac-configuration', configuration)
    const credentials = { get: () => 'test-token' } as unknown as CredentialVault
    const command: CompanionCommand = {
      commandId: 'request-project-artifact',
      protocolVersion: 1,
      type: 'artifact.request-upload',
      payload: { artifactId: 'artifact-from-project-files' },
      sourceDeviceId: 'test-phone',
      status: 'queued',
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now
    }
    let remoteStatus: CompanionCommand['status'] = 'queued'
    let completedResult: Record<string, unknown> | undefined
    let uploaded = false
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      const method = init.method ?? 'GET'
      if (url.pathname === '/v1/events' && method === 'POST') return jsonResponse({ accepted: true }, 201)
      if (url.pathname === '/v1/commands/pending' && method === 'GET') {
        return jsonResponse({ commands: remoteStatus === 'queued' ? [command] : [] })
      }
      if (url.pathname === `/v1/commands/${command.commandId}` && method === 'PATCH') {
        const update = JSON.parse(String(init.body)) as {
          status: CompanionCommand['status']
          result?: Record<string, unknown>
        }
        remoteStatus = update.status
        if (update.status === 'completed') completedResult = update.result
        return jsonResponse({ ...command, status: remoteStatus, result: update.result ?? null })
      }
      if (url.pathname === '/v1/attachments/artifact-from-project-files' && method === 'PUT') {
        uploaded = true
        expect(new Headers(init.headers).get('Content-Type')).toBe('text/markdown')
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
      expect(completedResult).toMatchObject({
        artifactId: 'artifact-from-project-files',
        attachment: {
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
