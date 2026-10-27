import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CliAgentRuntime, CliAgentTurnInput } from './cli-agent-runtime'
import type { PiTaskHarness } from './pi-task-harness'
import { createTestDatabase } from '../test-support/project-fixtures'
import { TaskDispatcher } from './task-dispatcher'
import { WorkspaceFilesService } from './workspace-files'
import { AppDatabase } from './database'
import { persistInputAttachments } from './agent-attachments'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const actor = { userId: 'member', snapshot: { displayName: '原名字', avatarRef: null } }

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'fuddy-retry-'))
  roots.push(root)
  const databasePath = join(root, 'app.sqlite')
  const database = createTestDatabase(databasePath)
  const project = database.listProjects().find(item => item.id === 'vows')!
  database.updateProject({ ...project, profile: { ...project.profile,
    workspaceRoots: [{ id: 'primary', label: '测试', path: root }], primaryWorkspaceRootId: 'primary', defaultAgent: 'claude' } })
  const runTurn = vi.fn<(input: CliAgentTurnInput) => Promise<{ text: string; sessionId: string }>>()
  const createDispatcher = (db: AppDatabase) => new TaskDispatcher(db, {} as PiTaskHarness,
    new WorkspaceFilesService(db, join(root, 'files')), { runTurn } as unknown as CliAgentRuntime)
  const dispatcher = createDispatcher(database)
  const runId = dispatcher.createDraft({ projectId: 'vows', title: '重试测试' }).run.id
  return { root, database, databasePath, createDispatcher, dispatcher, runTurn, runId }
}

describe('failed Agent Run retries', () => {
  it('restores persisted input and session after restart, deduplicates clicks and preserves the original user message', async () => {
    const fixture = setup()
    const { runTurn, runId, databasePath } = fixture
    runTurn.mockImplementationOnce(async input => { input.onSessionId('native-session'); throw new Error('401 Invalid API key') })
    const attachments = [{ id: 'input-1', name: 'note.txt', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,aGVsbG8=' }]
    const failed = await fixture.dispatcher.sendMessage(runId, '原问题\n第二行', undefined, 'original-request', attachments, undefined, actor)
    expect(failed.run.status).toBe('failed')
    const error = failed.messages.findLast(message => message.eventType === 'error')!
    expect(error.requestId).toBe('original-request')
    const originalMessage = failed.messages.find(message => message.role === 'user')!
    fixture.database.close()
    const database = new AppDatabase(databasePath)
    const dispatcher = fixture.createDispatcher(database)
    let release = (): void => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    runTurn.mockImplementationOnce(async input => {
      expect(input.prompt).toBe('原问题\n第二行')
      expect(input.sessionId).toBe('native-session')
      expect(readFileSync(input.attachments![0].path, 'utf8')).toBe('hello')
      await gate
      return { text: '完成', sessionId: 'native-session' }
    })
    const renamedActor = { ...actor, snapshot: { displayName: '新名字', avatarRef: null } }
    const first = dispatcher.retryMessage(runId, error.id, undefined, undefined, renamedActor)
    const duplicate = dispatcher.retryMessage(runId, error.id, undefined, undefined, renamedActor)
    release()
    const [completed] = await Promise.all([first, duplicate])
    expect(runTurn).toHaveBeenCalledTimes(2)
    expect(completed.run.status).toBe('idle')
    expect(completed.messages.filter(message => message.role === 'user')).toEqual([originalMessage])
    expect(database.getAgentTurn('original-request')?.status).toBe('completed')
    await expect(dispatcher.retryMessage(runId, error.id)).rejects.toThrow('过期')
    expect(runTurn).toHaveBeenCalledTimes(2)
    database.close()
  })

  it('supports legacy errors without request IDs or a saved queue entry', async () => {
    const { root, database, dispatcher, runTurn, runId } = setup()
    const createdAt = new Date().toISOString()
    const input = { id: 'old-input', name: 'legacy.txt', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,aGVsbG8=' }
    const files = persistInputAttachments(database, new WorkspaceFilesService(database, join(root, 'files')),
      database.getAgentRun(runId), 'old-message', [input])
    database.createAgentRunMessage({ id: 'old-message', runId, role: 'user', content: ' 旧问题 ',
      eventType: null, toolName: null, metadata: null, createdAt, attachments: files.descriptors })
    database.createAgentRunMessage({ id: 'old-error', runId, role: 'system', content: '401',
      eventType: 'error', toolName: null, metadata: null, createdAt })
    database.updateAgentRun({ ...database.getAgentRun(runId), status: 'failed' })
    writeFileSync(files.runtime[0].path, 'modified')
    await expect(dispatcher.retryMessage(runId, 'old-error')).rejects.toThrow('附件校验失败')
    expect(runTurn).not.toHaveBeenCalled()
    expect(database.getAgentTurn('old-message')).toBeNull()
    writeFileSync(files.runtime[0].path, 'hello')
    runTurn.mockImplementation(async input => {
      expect(readFileSync(input.attachments![0].path, 'utf8')).toBe('hello')
      return { text: '完成', sessionId: 'legacy-session' }
    })
    const retried = await dispatcher.retryMessage(runId, 'old-error', undefined, undefined, actor)
    expect(retried.run.status).toBe('idle')
    expect(retried.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(runTurn.mock.calls[0][0].prompt).toBe('旧问题')
    database.close()
  })

  it('rejects another author and obsolete errors, and can retry a second failure', async () => {
    const { database, dispatcher, runTurn, runId } = setup()
    runTurn.mockRejectedValue(new Error('network unavailable'))
    const failed = await dispatcher.sendMessage(runId, '问题', undefined, 'request', [], undefined, actor)
    const firstError = failed.messages.findLast(message => message.eventType === 'error')!
    await expect(dispatcher.retryMessage(runId, firstError.id, undefined, undefined,
      { userId: 'other', snapshot: { displayName: '其他人', avatarRef: null } })).rejects.toThrow('只能重试自己')
    const failedAgain = await dispatcher.retryMessage(runId, firstError.id, undefined, undefined, actor)
    const nextError = failedAgain.messages.findLast(message => message.eventType === 'error')!
    expect(nextError.id).not.toBe(firstError.id)
    expect(database.getAgentTurn('request')?.status).toBe('failed')
    await expect(dispatcher.retryMessage(runId, firstError.id)).rejects.toThrow('过期')
    runTurn.mockResolvedValue({ text: '完成', sessionId: 'session' })
    const completed = await dispatcher.retryMessage(runId, nextError.id, undefined, undefined, actor)
    expect(completed.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(runTurn).toHaveBeenCalledTimes(3)
    database.close()
  })
})
