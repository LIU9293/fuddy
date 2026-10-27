import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CliAgentRuntime, CliAgentTurnInput } from './cli-agent-runtime'
import type { PiTaskHarness } from './pi-task-harness'
import { createTestDatabase } from '../test-support/project-fixtures'
import { TaskDispatcher } from './task-dispatcher'
import { WorkspaceFilesService } from './workspace-files'

const temporaryDirectories: string[] = []
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('durable Chat turn dispatch', () => {
  it('keeps the first accepted author identity when a queued request is retried', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fuddy-author-snapshot-'))
    temporaryDirectories.push(root)
    const database = createTestDatabase(join(root, 'app.sqlite'))
    const runTurn = vi.fn(async (input: CliAgentTurnInput) => ({
      text: `回复 ${input.prompt}`, sessionId: 'session-1'
    }))
    const dispatcher = new TaskDispatcher(database, {} as PiTaskHarness,
      new WorkspaceFilesService(database, join(root, 'files')),
      { runTurn } as unknown as CliAgentRuntime)
    const runId = dispatcher.createDraft({ projectId: null, title: '作者快照' }).run.id
    const requestId = crypto.randomUUID()
    database.enqueueAgentTurn({
      requestId, runId, prompt: '你好', attachments: [], requestedByUserId: 'member',
      authorSnapshot: { displayName: '加入时的名字', avatarRef: null }
    })
    await dispatcher.sendMessage(runId, '你好', undefined, requestId, [], undefined,
      { userId: 'member', snapshot: { displayName: '改过的名字', avatarRef: null } })
    expect(database.listAgentRunMessages(runId).find((message) => message.id === requestId))
      .toMatchObject({ authorUserId: 'member', authorSnapshot: { displayName: '加入时的名字' } })
    database.close()
  })

  it('serializes turns, deduplicates a request and cancels an unstarted member turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fuddy-serialized-turns-'))
    temporaryDirectories.push(root)
    const database = createTestDatabase(join(root, 'app.sqlite'))
    const project = database.listProjects().find((item) => item.id === 'vows')!
    database.updateProject({ ...project, profile: { ...project.profile,
      workspaceRoots: [{ id: 'primary', label: '测试', path: root }],
      primaryWorkspaceRootId: 'primary', defaultAgent: 'codex'
    } })
    let releaseFirst = (): void => undefined
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const runTurn = vi.fn(async (input: CliAgentTurnInput) => {
      await firstGate
      return { text: `回复 ${input.prompt}`, sessionId: 'session-1' }
    })
    const dispatcher = new TaskDispatcher(database, {} as PiTaskHarness,
      new WorkspaceFilesService(database, join(root, 'files')),
      { runTurn } as unknown as CliAgentRuntime)
    const runId = dispatcher.createDraft({ projectId: 'vows', title: '共享 Chat' }).run.id
    const owner = { userId: 'owner', snapshot: { displayName: '所有者', avatarRef: null } }
    const member = { userId: 'member', snapshot: { displayName: '成员', avatarRef: null } }
    const firstId = crypto.randomUUID()
    const secondId = crypto.randomUUID()
    const first = dispatcher.sendMessage(runId, '第一条', undefined, firstId, [], undefined, owner)
    const second = dispatcher.sendMessage(runId, '第二条', undefined, secondId, [], undefined, member)
    const retry = dispatcher.sendMessage(runId, '第二条', undefined, secondId, [], undefined, member)
    expect(database.listAgentTurnsForRun(runId).map((turn) => turn.status)).toEqual(['running', 'queued'])
    expect(() => dispatcher.cancelQueuedTurn(secondId, 'owner')).toThrow('只能取消自己')
    expect(dispatcher.cancelQueuedTurn(secondId, 'member')).toBe(true)
    releaseFirst()
    await first
    await expect(second).rejects.toThrow('已停止')
    await expect(retry).rejects.toThrow('已停止')
    expect(runTurn).toHaveBeenCalledTimes(1)
    expect(database.getAgentTurn(firstId)?.status).toBe('completed')
    expect(database.getAgentTurn(secondId)?.status).toBe('cancelled')
    expect(database.listAgentRunMessages(runId).filter((message) => message.role === 'user'))
      .toMatchObject([{ id: firstId, authorUserId: 'owner' }])
    database.close()
  })

  it('steers a queued message into the active turn without starting a second turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fuddy-steer-turn-'))
    temporaryDirectories.push(root)
    const database = createTestDatabase(join(root, 'app.sqlite'))
    const project = database.listProjects().find((item) => item.id === 'vows')!
    database.updateProject({ ...project, profile: { ...project.profile,
      workspaceRoots: [{ id: 'primary', label: '测试', path: root }], primaryWorkspaceRootId: 'primary', defaultAgent: 'codex'
    } })
    let releaseFirst = (): void => undefined
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const steer = vi.fn(async () => undefined)
    const runTurn = vi.fn(async (input: CliAgentTurnInput) => {
      input.onSteerReady?.(steer)
      await firstGate
      input.onSteerReady?.(null)
      return { text: '已按新方向完成', sessionId: 'session-1' }
    })
    const dispatcher = new TaskDispatcher(database, {} as PiTaskHarness,
      new WorkspaceFilesService(database, join(root, 'files')),
      { runTurn } as unknown as CliAgentRuntime)
    const runId = dispatcher.createDraft({ projectId: 'vows', title: 'Steer' }).run.id
    const owner = { userId: 'owner', snapshot: { displayName: '所有者', avatarRef: null } }
    const firstId = crypto.randomUUID()
    const secondId = crypto.randomUUID()
    const first = dispatcher.sendMessage(runId, '第一条', undefined, firstId, [], undefined, owner)
    await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(1))
    const second = dispatcher.sendMessage(runId, '改一下方向', undefined, secondId, [], undefined, owner)
    expect(database.getAgentTurn(secondId)?.status).toBe('queued')
    await expect(dispatcher.steerQueuedTurn(secondId, 'other')).rejects.toThrow('只能 Steer 自己')
    await dispatcher.steerQueuedTurn(secondId, 'owner')
    expect(steer).toHaveBeenCalledWith('改一下方向', [], secondId)
    expect(database.getAgentTurn(secondId)?.status).toBe('completed')
    expect(database.listAgentRunMessages(runId).find(message => message.id === secondId))
      .toMatchObject({ role: 'user', content: '改一下方向', authorUserId: 'owner' })
    releaseFirst()
    await Promise.all([first, second])
    expect(runTurn).toHaveBeenCalledTimes(1)
    database.close()
  })

  it('keeps the queued message when the active provider rejects Steer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fuddy-steer-rejected-'))
    temporaryDirectories.push(root)
    const database = createTestDatabase(join(root, 'app.sqlite'))
    const project = database.listProjects().find((item) => item.id === 'vows')!
    database.updateProject({ ...project, profile: { ...project.profile,
      workspaceRoots: [{ id: 'primary', label: '测试', path: root }], primaryWorkspaceRootId: 'primary', defaultAgent: 'codex'
    } })
    let releaseFirst = (): void => undefined
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const runTurn = vi.fn(async (input: CliAgentTurnInput) => {
      if (input.prompt === '第一条') {
        input.onSteerReady?.(async () => { throw new Error('activeTurnNotSteerable') })
        await firstGate
      }
      return { text: `回复 ${input.prompt}`, sessionId: 'session-1' }
    })
    const dispatcher = new TaskDispatcher(database, {} as PiTaskHarness,
      new WorkspaceFilesService(database, join(root, 'files')),
      { runTurn } as unknown as CliAgentRuntime)
    const runId = dispatcher.createDraft({ projectId: 'vows', title: 'Steer 失败' }).run.id
    const first = dispatcher.sendMessage(runId, '第一条')
    await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(1))
    const requestId = crypto.randomUUID()
    const second = dispatcher.sendMessage(runId, '继续处理', undefined, requestId)
    await expect(dispatcher.steerQueuedTurn(requestId)).rejects.toThrow('activeTurnNotSteerable')
    expect(database.getAgentTurn(requestId)?.status).toBe('queued')
    releaseFirst()
    await Promise.all([first, second])
    expect(runTurn).toHaveBeenCalledTimes(2)
    expect(database.getAgentTurn(requestId)?.status).toBe('completed')
    database.close()
  })
})
