import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AccountProjectShare, AccountState } from '../../shared/account'
import { generateSharedProjectKey, type SharedProjectBaselineChunk,
  type SharedProjectEncryptedEvent } from '../../shared/project-sharing-events'
import { createTestDatabase } from '../test-support/project-fixtures'
import type { AccountService } from './account-service'
import type { ProjectSharingKeyStore } from './project-sharing-key-store'
import { ProjectSharingTransport } from './project-sharing-transport'
import { WorkspaceFilesService } from './workspace-files'
import { persistInputAttachments } from './agent-attachments'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('project sharing transport', () => {
  it('round-trips a paged encrypted baseline without publishing local paths or native sessions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fuddy-project-baseline-'))
    directories.push(root)
    const database = createTestDatabase(join(root, 'app.sqlite'))
    const project = database.listProjects().find((item) => item.id === 'vows')!
    const share: AccountProjectShare = {
      projectId: crypto.randomUUID(), localProjectId: project.shared!.id,
      role: 'owner', executionHostId: 'host-id', keyAuthorityHostId: 'host-id', permissionRevision: 1, keyEpoch: 1
    }
    const runId = crypto.randomUUID()
    const now = new Date().toISOString()
    database.createAgentRun({
      id: runId, projectId: project.id, provider: 'codex', title: 'Shared Chat', status: 'idle',
      visibility: 'published', createdByUserId: 'owner-user',
      createdBySnapshot: { displayName: 'Owner', avatarRef: null },
      sessionId: 'secret-session', workingDirectory: '/private/workspace',
      startedAt: now, completedAt: null, summary: '', draftPrompt: null,
      createdAt: now, updatedAt: now
    })
    const files = new WorkspaceFilesService(database, join(root, 'files'))
    const attachedMessageId = crypto.randomUUID()
    const persisted = persistInputAttachments(database, files, database.getAgentRun(runId),
      attachedMessageId, [{ id: crypto.randomUUID(), name: 'proof.txt',
        mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,cHJvb2Y=' }])
    database.createAgentRunMessage({
      id: attachedMessageId, runId, role: 'user', content: '见附件', eventType: null,
      toolName: null, metadata: null, attachments: persisted.descriptors, createdAt: now,
      authorUserId: 'owner-user', authorSnapshot: { displayName: 'Owner', avatarRef: null }
    })
    database.createAgentRunMessage({
      id: crypto.randomUUID(), runId, role: 'user', content: '请帮我看', eventType: null,
      toolName: null, metadata: { privateToolInput: '/private/workspace' }, createdAt: now,
      authorUserId: 'owner-user', authorSnapshot: { displayName: 'Owner', avatarRef: null }
    })
    database.archiveAgentRun(runId)
    const state = { user: { id: 'owner-user' }, device: { id: 'device-id', platform: 'macos', hostId: 'host-id' } }
    let baseline: any = null
    const chunks = new Map<number, SharedProjectBaselineChunk>()
    const events: SharedProjectEncryptedEvent[] = []
    const uploaded = new Map<string, { ciphertext: Uint8Array; runId: string;
      requestId: string | null; kind: string; keyEpoch: number; uploadedByUserId: string }>()
    const account = {
      getState: () => state as AccountState,
      getProjectShare: async () => share,
      registerProjectPublisher: async () => 'host-id',
      registerSharedChat: async () => undefined,
      beginProjectBaseline: async (_projectId: string, baselineId: string, keyEpoch: number, chunkCount: number) => {
        baseline = { baselineId, projectId: share.projectId, sourceDeviceId: 'device-id',
          keyEpoch, watermark: 0, chunkCount, createdAt: now }
        return baseline
      },
      putProjectBaselineChunk: async (_projectId: string, chunk: SharedProjectBaselineChunk) => {
        chunks.set(chunk.index, chunk)
      },
      commitProjectBaseline: async () => undefined,
      listProjectBaselines: async () => baseline ? [baseline] : [],
      listProjectPublishers: async () => [{ sourceDeviceId: 'device-id', hostName: '执行 Mac' }],
      listProjectBaselineChunks: async (_projectId: string, _baselineId: string,
        afterIndex: number, limit: number) => {
        const page = [...chunks.values()].filter((chunk) => chunk.index > afterIndex)
          .sort((a, b) => a.index - b.index).slice(0, limit)
        return { chunks: page, nextIndex: page.at(-1)?.index ?? afterIndex }
      },
      publishProjectEvent: async (_projectId: string, event: Omit<SharedProjectEncryptedEvent,
        'projectId' | 'sequence' | 'createdAt' | 'actorUserId' | 'sourceDeviceId'>) => {
        const stored = { ...event, projectId: share.projectId, sequence: events.length + 1,
          actorUserId: 'owner-user', sourceDeviceId: 'device-id', createdAt: now }
        events.push(stored)
        return stored
      },
      listProjectEvents: async (_projectId: string, after: number) => {
        const page = events.filter((event) => event.sequence > after)
        return { events: page, nextCursor: page.at(-1)?.sequence ?? after }
      },
      uploadProjectAttachment: async (input: { attachmentId: string; ciphertext: Uint8Array;
        runId: string; requestId: string | null; kind: string; keyEpoch: number }) => {
        uploaded.set(input.attachmentId, { ...input, uploadedByUserId: 'owner-user' })
      },
      downloadProjectAttachment: async (_projectId: string, attachmentId: string) =>
        uploaded.get(attachmentId) ?? null
    } as unknown as AccountService
    const key = generateSharedProjectKey()
    const keys = { getReadable: async () => key } as unknown as ProjectSharingKeyStore
    const transport = new ProjectSharingTransport(database, account, keys, files)
    await transport.publishBaseline(share.projectId)
    expect(chunks.size).toBeGreaterThan(0)
    const ciphertext = JSON.stringify([...chunks.values()])
    expect(ciphertext).not.toContain('/private/workspace')
    expect(ciphertext).not.toContain('secret-session')
    const read = await transport.readProject(share.projectId)
    expect(read.project.id).toBe(share.projectId)
    expect(read.chats).toMatchObject([{ id: runId, createdByUserId: 'owner-user', archivedAt: expect.any(String) }])
    expect(read.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: '请帮我看', authorUserId: 'owner-user' })
    ]))
    const attached = read.messages.find((message) => message.id === attachedMessageId)?.attachments
    expect(attached).toMatchObject([{ filename: 'proof.txt', kind: 'artifact' }])
    expect((await transport.downloadForDisplay(share.projectId, attached![0])).dataUrl)
      .toBe('data:text/plain;base64,cHJvb2Y=')
    expect(JSON.stringify(read)).not.toContain('/private/workspace')
    expect(JSON.stringify(read)).not.toContain('secret-session')
    const inputId = crypto.randomUUID()
    const requestId = crypto.randomUUID()
    const descriptor = (await transport.uploadInputs(share.projectId, runId, requestId, [{
      id: inputId, name: 'note.txt', mimeType: 'text/plain',
      dataUrl: 'data:text/plain;base64,aGVsbG8='
    }]))[0]
    expect(descriptor.id).toMatch(/^[a-f0-9]{64}$/u)
    expect((await transport.downloadInput(share, descriptor, runId, requestId, 'owner-user')).dataUrl)
      .toBe('data:text/plain;base64,aGVsbG8=')
    await expect(transport.downloadInput(share, descriptor, runId, requestId,
      'another-user')).rejects.toThrow('上传者')
    await expect(transport.downloadInput(share, descriptor, runId,
      crypto.randomUUID(), 'owner-user')).rejects.toThrow('不属于')
    database.close()
  })
})
