import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { CompanionPairingClaimResult } from '../../shared/companion-sync'
import { defaultCompanionRelayUrl } from '../../shared/companion-sync'
import { CompanionSyncService } from './companion-sync'
import type { CredentialVault } from './credential-vault'
import { AppDatabase } from './database'
import type { TaskDispatcher } from './task-dispatcher'

const enabled = process.env.RUN_COMPANION_RELAY_SMOKE === '1'
const test = enabled ? it : it.skip
const directories: string[] = []

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

function authenticatedUrl(path: string, accountId: string, deviceId: string): string {
  const url = new URL(path, defaultCompanionRelayUrl)
  url.searchParams.set('accountId', accountId)
  url.searchParams.set('deviceId', deviceId)
  return url.toString()
}

describe('CompanionSyncService live relay', () => {
  test('pairs, publishes a snapshot, and executes an iPhone command on the Mac', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'project-agent-companion-live-'))
    directories.push(directory)
    const database = new AppDatabase(join(directory, 'app.sqlite'))
    const secrets = new Map<string, string>()
    const credentials = {
      set: (key: string, value: string) => { secrets.set(key, value) },
      get: (key: string) => secrets.get(key) ?? null,
      delete: (key: string) => { secrets.delete(key) }
    } as unknown as CredentialVault
    const now = new Date().toISOString()
    database.createAgentRun({
      id: 'companion-live-run',
      projectId: null,
      provider: 'pi',
      title: 'Before remote rename',
      status: 'idle',
      sessionId: null,
      workingDirectory: directory,
      startedAt: now,
      completedAt: null,
      summary: 'Ready',
      createdAt: now,
      updatedAt: now
    })
    database.createBriefingMessage({
      id: 'companion-live-image-message',
      briefingId: null,
      role: 'assistant',
      content: 'Image attached',
      attachments: [{
        id: 'companion-live-image',
        name: 'pixel.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgo='
      }],
      taskContext: null,
      createdAt: now
    })
    writeFileSync(join(directory, 'report.txt'), 'Existing Agent artifact')
    database.upsertAgentRunArtifact({
      id: 'companion-live-artifact',
      runId: 'companion-live-run',
      projectId: null,
      relativePath: 'report.txt',
      label: 'report.txt',
      mimeType: 'text/plain',
      createdAt: now
    })
    const service = new CompanionSyncService(
      database,
      credentials,
      {} as TaskDispatcher,
      async () => ({ accepted: true })
    )
    const pairingSession = await service.beginPairing(defaultCompanionRelayUrl, 'Integration Test Mac')
    const pairingPayload = JSON.parse(pairingSession.pairingPayload) as {
      accountId: string
      pairingSecret: string
    }
    const phoneId = crypto.randomUUID()
    const claimResponse = await fetch(`${defaultCompanionRelayUrl}/v1/pairings/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: pairingPayload.accountId,
        pairingSecret: pairingPayload.pairingSecret,
        deviceId: phoneId,
        deviceName: 'Integration Test iPhone'
      })
    })
    expect(claimResponse.status).toBe(201)
    const phone = await claimResponse.json() as CompanionPairingClaimResult
    const eventsResponse = await fetch(authenticatedUrl('/v1/events?after=0', pairingPayload.accountId, phoneId), {
      headers: { Authorization: `Bearer ${phone.deviceToken}` }
    })
    const eventPage = await eventsResponse.json() as { events: Array<{ type: string; payload: Record<string, unknown> }> }
    const snapshotEvent = eventPage.events.find((event) => event.type === 'snapshot.created')
    const snapshotAttachments = snapshotEvent?.payload.attachments as Array<Record<string, unknown>>
    expect(snapshotAttachments).toContainEqual(expect.objectContaining({
      id: 'companion-live-artifact',
      filename: 'report.txt',
      mimeType: 'text/plain'
    }))
    const messageEvent = eventPage.events.find((event) => event.type === 'work-assistant-message.created')
    const attachments = messageEvent?.payload.attachments as Array<Record<string, unknown>>
    expect(attachments[0]).toMatchObject({ id: 'companion-live-image', filename: 'pixel.png', mimeType: 'image/png' })
    expect(attachments[0]).not.toHaveProperty('dataUrl')
    const attachmentResponse = await fetch(authenticatedUrl(
      '/v1/attachments/companion-live-image',
      pairingPayload.accountId,
      phoneId
    ), { headers: { Authorization: `Bearer ${phone.deviceToken}` } })
    expect(attachmentResponse.status).toBe(200)
    expect((await attachmentResponse.arrayBuffer()).byteLength).toBeGreaterThan(0)
    const artifactResponse = await fetch(authenticatedUrl(
      '/v1/attachments/companion-live-artifact',
      pairingPayload.accountId,
      phoneId
    ), { headers: { Authorization: `Bearer ${phone.deviceToken}` } })
    expect(artifactResponse.status).toBe(200)
    expect(await artifactResponse.text()).toBe('Existing Agent artifact')

    const commandResponse = await fetch(authenticatedUrl('/v1/commands', pairingPayload.accountId, phoneId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${phone.deviceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        protocolVersion: 1,
        type: 'agent.rename-session',
        payload: { runId: 'companion-live-run', title: 'Renamed from iPhone' },
        createdAt: new Date().toISOString()
      })
    })
    expect(commandResponse.status).toBe(201)
    await service.syncNow()
    expect(database.getAgentRun('companion-live-run').title).toBe('Renamed from iPhone')
    expect(service.getStatus().pendingEvents).toBe(0)
    await service.disconnect()
    database.close()
  }, 30_000)
})
