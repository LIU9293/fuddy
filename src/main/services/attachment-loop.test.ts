import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createTestDatabase, testProject } from '../test-support/project-fixtures'
import { WorkspaceFilesService } from './workspace-files'
import { TaskDispatcher } from './task-dispatcher'
import { CompanionSyncService } from './companion-sync'
import { buildCodexTurnStartParams, type CliAgentRuntime } from './cli-agent-runtime'
import type { PiTaskHarness } from './pi-task-harness'
import type { CredentialVault } from './credential-vault'
import { companionProtocolVersion, type CompanionAttachmentDescriptor, type CompanionCommand } from '../../shared/companion-sync'
import { companionAccountKeyId, companionAttachmentAssociatedData, companionCommandAssociatedData, generateCompanionAccountKey,
  sealCompanionAttachment, sealCompanionJson, openCompanionAttachment } from '../../shared/companion-crypto'

describe('phone attachment → Mac Agent → encrypted output loop', () => {
  it.each([false, true])('delivers bytes and replays idempotently (tampered=%s)', async tampered => {
    const root = mkdtempSync(join(tmpdir(), 'fuddy-phone-attachment-loop-'))
    const database = createTestDatabase(join(root, 'test.sqlite'), [testProject('project', 'Project', root)])
    const key = generateCompanionAccountKey()
    const now = new Date().toISOString()
    database.setSetting('companion.mac-configuration', { relayUrl: 'https://relay.example.com', accountId: 'test-account',
      macDeviceId: 'test-mac', pairedAt: now, encryptionKeyId: await companionAccountKeyId(key) })
    const files = new WorkspaceFilesService(database, join(root, 'files'))
    const bytes = Buffer.from('phone image bytes')
    const document = Buffer.from('phone document content')
    const descriptor = (id: string, name: string, mimeType: string, data: Buffer): CompanionAttachmentDescriptor => ({
      id, filename: name, mimeType, size: data.length, sha256: createHash('sha256').update(data).digest('hex'),
      messageId: null, artifactId: null, width: null, height: null, thumbnailAttachmentId: null, createdAt: now
    })
    const inputs = [descriptor('image', 'phone.png', 'image/png', bytes), descriptor('document', 'notes.txt', 'text/plain', document)]
    const objects = new Map<string, Uint8Array>()
    for (const [index, data] of [bytes, document].entries()) objects.set(inputs[index].id,
      await sealCompanionAttachment(key, data, companionAttachmentAssociatedData('test-account', inputs[index].id)))
    if (tampered) inputs[0].sha256 = '0'.repeat(64)
    const runTurn = vi.fn<CliAgentRuntime['runTurn']>(async input => {
      expect(input.prompt).toBe('检查图片和文档')
      expect(input.attachments).toHaveLength(2)
      expect(buildCodexTurnStartParams('session', input.prompt, null, input.attachments).input).toEqual([
        { type: 'text', text: expect.stringContaining('notes.txt') },
        { type: 'localImage', path: input.attachments![0].path }
      ])
      expect(readFileSync(input.attachments![0].path)).toEqual(bytes)
      expect(readFileSync(input.attachments![1].path)).toEqual(document)
      writeFileSync(join(root, 'result.png'), bytes)
      writeFileSync(join(root, 'report.md'), '# 已读取两个附件')
      input.onSessionId('native-session')
      return { text: '![结果](result.png)\n[报告](report.md)', sessionId: 'native-session' }
    })
    const dispatcher = new TaskDispatcher(database, {} as PiTaskHarness, files, { runTurn } as unknown as CliAgentRuntime)
    const run = dispatcher.createDraft({ projectId: 'project', provider: 'codex', title: 'Phone input' }).run
    const command: CompanionCommand = { commandId: 'phone-command', protocolVersion: companionProtocolVersion, type: 'agent.send-message',
      payload: { runId: run.id, prompt: '检查图片和文档', attachments: inputs, clientMessageId: 'phone-message' },
      sourceDeviceId: 'phone', status: 'queued', result: null, error: null, createdAt: now, updatedAt: now }
    const wire = { ...command, payload: await sealCompanionJson(key, command.payload, companionCommandAssociatedData(command)) }
    let remoteStatus = 'queued', sequence = 0
    const json = (value: unknown, status = 200) => Response.json(value, { status })
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, options: RequestInit = {}) => {
      const path = new URL(String(url)).pathname
      const method = options.method ?? 'GET'
      if (path === '/v1/commands/pending') return json({ commands: remoteStatus === 'queued' ? [wire] : [] })
      if (path === '/v1/commands/phone-command') { remoteStatus = JSON.parse(String(options.body)).status; return json({}) }
      if (path === '/v1/events/batch') return json({ accepted: JSON.parse(String(options.body)).events.map((event: { eventId: string }) => ({ eventId: event.eventId, sequence: ++sequence })), lastSequence: sequence }, 201)
      if (path.startsWith('/v1/attachments/')) {
        const id = path.split('/').at(-1)!
        if (method === 'PUT') {
          if (objects.has(id)) return json({ error: 'immutable ID' }, 409)
          objects.set(id, new Uint8Array(await new Response(options.body).arrayBuffer()))
          return json({ id }, 201)
        }
        const object = objects.get(id)
        return object ? new Response(Buffer.from(object)) : json({ error: 'missing' }, 404)
      }
      throw new Error(`Unexpected test relay request ${method} ${path}`)
    }))
    const credentials = { get: (ref: string) => ref.startsWith('companion.account-key:') ? key : 'test-token' } as CredentialVault
    const service = new CompanionSyncService(database, credentials, dispatcher, async () => ({}), join(root, 'incoming'), () => 'codex', files)
    try {
      await service.syncNow()
      await vi.waitFor(() => expect(database.getCompanionCommand(command.commandId)?.status).toBe(tampered ? 'failed' : 'completed'))
      if (tampered) {
        expect(runTurn).not.toHaveBeenCalled()
        expect(database.getCompanionCommand(command.commandId)?.error).toContain('哈希')
      } else {
        await service.syncNow()
        const detail = database.getAgentRunDetail(run.id)
        const user = detail.messages.find(message => message.id === 'phone-message')!
        const answer = detail.messages.find(message => message.role === 'assistant')!
        expect(user.content).toBe('检查图片和文档')
        expect(user.attachments).toHaveLength(2)
        expect(answer.attachments).toHaveLength(2)
        for (const file of [...user.attachments!, ...answer.attachments!]) {
          const plaintext = await openCompanionAttachment(key, objects.get(file.id)!, companionAttachmentAssociatedData('test-account', file.id))
          expect(plaintext.length).toBe(file.size)
          expect(createHash('sha256').update(plaintext).digest('hex')).toBe(file.sha256)
        }
        remoteStatus = 'queued'
        await service.syncNow()
        await vi.waitFor(() => expect(remoteStatus).toBe('completed'))
        expect(runTurn).toHaveBeenCalledOnce()
      }
    } finally {
      await service.stopAndDrain()
      database.close(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true })
    }
  })
})
