import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CompanionCommand } from '../../shared/companion-sync'
import { AppDatabase } from './database'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createDatabase(): AppDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'project-agent-companion-'))
  temporaryDirectories.push(directory)
  return new AppDatabase(join(directory, 'app.sqlite'))
}

describe('companion sync persistence', () => {
  it('persists a full snapshot and incremental mutations in the outbox', () => {
    const database = createDatabase()
    const snapshot = database.enqueueCompanionSnapshot()
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
    expect(events[0].payload).toMatchObject({ projects: expect.any(Array), runs: expect.any(Array) })

    database.markCompanionEventPublished(snapshot.eventId, new Date().toISOString())
    expect(database.countPendingCompanionEvents()).toBe(3)
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
    database.close()
  })
})
