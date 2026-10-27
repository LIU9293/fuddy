import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '../../services/database'
import { createTestDatabase } from '../../test-support/project-fixtures'

const temporaryDirectories: string[] = []
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fuddy-turn-queue-'))
  temporaryDirectories.push(directory)
  return join(directory, 'app.sqlite')
}

function createRun(database: AppDatabase): string {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  database.createAgentRun({
    id, projectId: null, provider: 'pi', title: '队列测试', status: 'draft', sessionId: null,
    workingDirectory: null, startedAt: null, completedAt: null, summary: '等待首次消息',
    draftPrompt: null, createdAt: now, updatedAt: now
  })
  return id
}

describe('durable agent turn queue', () => {
  it('persists pending turns, deduplicates requests and cancels only before execution', () => {
    const path = databasePath()
    const database = createTestDatabase(path)
    const runId = createRun(database)
    const input = {
      requestId: crypto.randomUUID(), runId, prompt: '第一条', attachments: [],
      requestedByUserId: 'member-1', authorSnapshot: { displayName: '成员', avatarRef: null }
    }
    expect(database.enqueueAgentTurn(input)).toMatchObject({ status: 'queued', requestedByUserId: 'member-1' })
    expect(database.enqueueAgentTurn({ ...input, authorSnapshot: { displayName: '新名字', avatarRef: null } }))
      .toMatchObject({ status: 'queued' })
    expect(() => database.enqueueAgentTurn({ ...input, prompt: '伪造内容' })).toThrow('请求 ID')
    database.close()

    const reopened = new AppDatabase(path)
    expect(reopened.listQueuedAgentTurns()).toHaveLength(1)
    expect(reopened.cancelQueuedAgentTurn(input.requestId)).toBe(true)
    expect(reopened.cancelQueuedAgentTurn(input.requestId)).toBe(false)
    expect(reopened.claimAgentTurn(input.requestId)).toBe(false)
    reopened.close()
  })

  it('does not replay a turn whose provider may have started before a crash', () => {
    const path = databasePath()
    const database = createTestDatabase(path)
    const runId = createRun(database)
    const firstId = crypto.randomUUID()
    const secondId = crypto.randomUUID()
    for (const requestId of [firstId, secondId]) database.enqueueAgentTurn({
      requestId, runId, prompt: requestId, attachments: [], requestedByUserId: null, authorSnapshot: null
    })
    expect(database.claimAgentTurn(firstId)).toBe(true)
    database.close()

    const reopened = new AppDatabase(path)
    expect(reopened.recoverInterruptedAgentTurns()).toBe(1)
    expect(reopened.getAgentTurn(firstId)?.status).toBe('interrupted')
    expect(reopened.listQueuedAgentTurns().map((turn) => turn.requestId)).toEqual([secondId])
    reopened.close()
  })

  it('claims Steer once and never replays an uncertain delivery after a crash', () => {
    const path = databasePath()
    const database = createTestDatabase(path)
    const runId = createRun(database)
    const requestId = crypto.randomUUID()
    database.enqueueAgentTurn({ requestId, runId, prompt: '改一下方向', attachments: [], requestedByUserId: null, authorSnapshot: null })
    expect(database.claimAgentTurnForSteer(requestId)).toBe(true)
    expect(database.claimAgentTurn(requestId)).toBe(false)
    database.close()

    const reopened = new AppDatabase(path)
    expect(reopened.recoverInterruptedAgentTurns()).toBe(1)
    expect(reopened.getAgentTurn(requestId)?.status).toBe('interrupted')
    expect(reopened.listQueuedAgentTurns()).toEqual([])
    reopened.close()
  })
})
