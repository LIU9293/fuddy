import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CompanionCommand, CompanionSnapshotPayload } from '../../shared/companion-sync'
import { AppDatabase } from './database'
import { createTestDatabase } from '../test-support/project-fixtures'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createDatabase(): AppDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'project-agent-companion-'))
  temporaryDirectories.push(directory)
  return createTestDatabase(join(directory, 'app.sqlite'))
}

describe('companion sync persistence', () => {
  it('persists a full snapshot and incremental mutations in the outbox', () => {
    const database = createDatabase()
    const snapshot = database.enqueueCompanionSnapshot({
      workAssistant: '5.6 Medium',
      providers: {
        pi: '5.6',
        codex: '5.6 Sol High',
        claude: 'Claude Default',
        opencode: 'OpenCode Default'
      }
    })
    const project = database.listProjects()[0]
    database.updateProject({ ...project, focus: 'Companion validation' })
    const now = new Date().toISOString()
    database.createGoal({
      id: 'companion-goal-1',
      projectId: project.id,
      title: 'Companion goal',
      description: 'Validate goal synchronization',
      status: 'active',
      priority: 'P1',
      metric: { label: 'Done', unit: '%', baseline: 0, current: 0, target: 1 },
      deadline: null,
      nextCheckInAt: null,
      progress: 0,
      confidence: 1,
      agentSummary: 'Created for test',
      monitoringSources: [],
      milestones: [],
      checkIns: [],
      createdBy: 'user',
      createdAt: now,
      updatedAt: now,
      completedAt: null
    })
    database.createBriefingMessage({
      id: 'assistant-message-1',
      briefingId: null,
      role: 'assistant',
      content: 'Companion message',
      attachments: [],
      taskContext: null,
      createdAt: now
    })

    const events = database.listPendingCompanionEvents()
    expect(events.map((event) => event.type)).toEqual([
      'snapshot.created',
      'project.updated',
      'goal.created',
      'work-assistant-message.created'
    ])
    expect(snapshot.entityType).toBe('snapshot')
    expect(events[0].payload).toMatchObject({
      modelLabels: { workAssistant: '5.6 Medium', providers: { codex: '5.6 Sol High' } },
      projects: expect.any(Array),
      runs: expect.any(Array)
    })

    database.markCompanionEventPublished(snapshot.eventId, new Date().toISOString())
    expect(database.countPendingCompanionEvents()).toBe(3)
    database.close()
  })

  it('windows every chat snapshot at the newest 100 presentation blocks', () => {
    const database = createDatabase()
    const base = Date.UTC(2026, 0, 1)
    for (let index = 0; index < 220; index += 1) {
      database.createBriefingMessage({
        id: `message-${index}`,
        briefingId: null,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message ${index}`,
        attachments: [],
        taskContext: null,
        createdAt: new Date(base + index * 1_000).toISOString()
      })
    }

    expect(database.listBriefingMessages()).toHaveLength(200)
    expect(database.listBriefingMessages()[0]?.id).toBe('message-20')
    expect(database.listBriefingMessages().at(-1)?.id).toBe('message-219')

    const page = database.getCompanionChatPage('assistant', 'work-assistant')
    expect(page.records).toHaveLength(100)
    expect(page.records[0]?.assistantMessage?.id).toBe('message-120')
    expect(page.records.at(-1)?.assistantMessage?.id).toBe('message-219')
    expect(page.hasMore).toBe(true)

    const olderPage = database.getCompanionChatPage('assistant', 'work-assistant', page.nextBefore)
    expect(olderPage.records).toHaveLength(100)
    expect(olderPage.records[0]?.assistantMessage?.id).toBe('message-20')
    expect(olderPage.records.at(-1)?.assistantMessage?.id).toBe('message-119')
    expect(olderPage.hasMore).toBe(true)

    const oldestPage = database.getCompanionChatPage('assistant', 'work-assistant', olderPage.nextBefore)
    expect(oldestPage.records).toHaveLength(20)
    expect(oldestPage.records[0]?.assistantMessage?.id).toBe('message-0')
    expect(oldestPage.records.at(-1)?.assistantMessage?.id).toBe('message-19')
    expect(oldestPage.hasMore).toBe(false)

    const snapshot = database.enqueueCompanionSnapshot().payload as CompanionSnapshotPayload
    expect(snapshot.workAssistantMessages).toHaveLength(100)
    expect(snapshot.chatPages?.find((item) => item.chatId === 'work-assistant')).toEqual(page)
    database.close()
  })

  it('pages Agent display blocks without materializing the full Run detail', () => {
    const database = createDatabase()
    const base = Date.UTC(2026, 0, 1)
    database.createAgentRun({
      id: 'paged-agent-run',
      projectId: 'vows',
      provider: 'pi',
      title: 'Paged Agent Run',
      status: 'idle',
      sessionId: null,
      workingDirectory: '/tmp/paged-agent-run',
      startedAt: new Date(base).toISOString(),
      completedAt: null,
      summary: '',
      draftPrompt: null,
      createdAt: new Date(base).toISOString(),
      updatedAt: new Date(base).toISOString()
    })
    for (let index = 0; index < 20; index += 1) {
      database.createAgentRunMessage({
        id: `normal-${index}`,
        runId: 'paged-agent-run',
        role: 'user',
        content: `normal ${index}`,
        eventType: null,
        toolName: null,
        metadata: null,
        createdAt: new Date(base + index * 1_000).toISOString()
      })
    }
    database.createAgentRunMessage({
      id: 'reasoning-1', runId: 'paged-agent-run', role: 'assistant', content: 'reasoning',
      eventType: 'reasoning', toolName: null, metadata: null, createdAt: new Date(base + 20_000).toISOString()
    })
    database.createAgentRunMessage({
      id: 'tool-1', runId: 'paged-agent-run', role: 'tool', content: 'tool',
      eventType: 'tool', toolName: 'Read', metadata: null, createdAt: new Date(base + 21_000).toISOString()
    })
    for (let index = 20; index < 120; index += 1) {
      database.createAgentRunMessage({
        id: `normal-${index}`,
        runId: 'paged-agent-run',
        role: index === 20 ? 'assistant' : 'user',
        content: `normal ${index}`,
        eventType: null,
        toolName: null,
        metadata: null,
        createdAt: new Date(base + (index + 2) * 1_000).toISOString()
      })
    }
    const getDetail = vi.spyOn(database, 'getAgentRunDetail')

    const newest = database.getCompanionChatPage('agent', 'paged-agent-run')
    expect(newest.records).toHaveLength(100)
    expect(newest.records[0]?.agentMessages[0]?.id).toBe('normal-20')
    expect(newest.records.at(-1)?.agentMessages[0]?.id).toBe('normal-119')
    expect(newest.hasMore).toBe(true)

    const older = database.getCompanionChatPage('agent', 'paged-agent-run', newest.nextBefore)
    expect(older.records).toHaveLength(21)
    expect(older.records.at(-1)).toMatchObject({
      id: 'process-reasoning-1',
      completedAt: new Date(base + 22_000).toISOString(),
      agentMessages: [{ id: 'reasoning-1' }, { id: 'tool-1' }]
    })
    expect(older.hasMore).toBe(false)
    expect(getDetail).not.toHaveBeenCalled()
    database.close()
  })

  it('stores remote commands idempotently and preserves terminal results', () => {
    const database = createDatabase()
    const now = new Date().toISOString()
    const command: CompanionCommand = {
      commandId: 'command-1',
      protocolVersion: 1,
      type: 'agent.rename-session',
      payload: { runId: 'run-1', title: 'Renamed' },
      sourceDeviceId: 'ios-1',
      status: 'queued',
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now
    }
    database.upsertCompanionCommand(command)
    database.updateCompanionCommand(command.commandId, 'completed', { renamed: true })

    expect(database.getCompanionCommand(command.commandId)).toMatchObject({
      status: 'completed',
      result: { renamed: true }
    })
    const updated = database.getCompanionCommand(command.commandId)
    if (!updated) throw new Error('Expected persisted command.')
    database.enqueueCompanionCommandUpdate(updated)
    expect(database.listPendingCompanionEvents()).toEqual([
      expect.objectContaining({
        type: 'command.updated',
        payload: expect.objectContaining({ payload: {}, result: null })
      })
    ])
    database.close()
  })

  it('keeps iOS-consumed history results in command update events', () => {
    const database = createDatabase()
    const now = new Date().toISOString()
    const command: CompanionCommand<'chat.load-history'> = {
      commandId: 'history-command',
      protocolVersion: 3,
      type: 'chat.load-history',
      payload: { chatKind: 'agent', chatId: 'run-1', limit: 20 },
      sourceDeviceId: 'ios-1',
      status: 'completed',
      result: { chatId: 'run-1', chatKind: 'agent', records: [], hasMore: false, nextBefore: null },
      error: null,
      createdAt: now,
      updatedAt: now
    }

    database.enqueueCompanionCommandUpdate(command)

    expect(database.listPendingCompanionEvents()[0]?.payload).toMatchObject({
      payload: {},
      result: { chatId: 'run-1', records: [] }
    })
    database.close()
  })

  it('persists a terminal Agent turn notification event', () => {
    const database = createDatabase()
    database.enqueueAgentTurnSettled({
      runId: 'run-1',
      turnId: 'message-1',
      title: '整理产品数据',
      outcome: 'completed',
      summary: '已完成。',
      settledAt: '2026-08-12T05:00:00.000Z'
    })

    expect(database.listPendingCompanionEvents()).toEqual([
      expect.objectContaining({
        type: 'agent-turn.settled',
        entityType: 'agent-run',
        entityId: 'run-1',
        payload: expect.objectContaining({ turnId: 'message-1', outcome: 'completed' })
      })
    ])
    database.close()
  })

  it('replaces unsent history with an ordered split pairing baseline', () => {
    const database = createDatabase()
    const project = database.listProjects()[0]
    const now = new Date().toISOString()
    database.createAgentRun({
      id: 'pairing-run',
      projectId: project.id,
      provider: 'codex',
      title: 'Pairing run',
      status: 'draft',
      sessionId: null,
      workingDirectory: project.profile.repoPath,
      startedAt: null,
      completedAt: null,
      summary: '等待首次消息',
      draftPrompt: null,
      createdAt: now,
      updatedAt: now
    })
    database.upsertAgentRunArtifact({
      id: 'pairing-artifact',
      runId: 'pairing-run',
      projectId: project.id,
      relativePath: 'notes/result.md',
      label: 'result.md',
      mimeType: 'text/markdown',
      createdAt: now
    })
    database.updateProject({ ...project, focus: 'Pending before pairing' })
    expect(database.countPendingCompanionEvents()).toBeGreaterThan(1)

    const snapshot = database.enqueueCompanionPairingSnapshot()
    const pending = database.listPendingCompanionEvents()
    expect(pending[0]).toMatchObject({ eventId: snapshot.eventId, type: 'snapshot.created' })
    expect(pending.map((event) => event.type)).toEqual(expect.arrayContaining([
      'snapshot.created',
      'project.created',
      'agent-run.created',
      'artifact.updated',
      'chat-page.updated'
    ]))
    expect(pending).not.toContainEqual(expect.objectContaining({
      type: 'project.updated',
      payload: expect.objectContaining({ focus: 'Pending before pairing' })
    }))
    database.close()
  })

  it('preserves non-reconstructible pending events after a retention baseline', () => {
    const database = createDatabase()
    database.enqueueAgentTurnSettled({
      runId: 'offline-run',
      turnId: 'offline-turn',
      title: 'Offline run',
      outcome: 'completed',
      summary: 'Done.',
      settledAt: '2026-08-19T00:00:00.000Z'
    })

    database.enqueueCompanionPairingSnapshot(undefined, { preservePendingTransientEvents: true })

    const pending = database.listPendingCompanionEvents()
    expect(pending[0]?.type).toBe('snapshot.created')
    expect(pending.at(-1)).toMatchObject({
      type: 'agent-turn.settled',
      payload: expect.objectContaining({ turnId: 'offline-turn' })
    })
    database.close()
  })
})
