import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CliAgentRuntime, CliAgentTurnInput } from './cli-agent-runtime'
import type { PiTaskHarness } from './pi-task-harness'
import { createTestDatabase } from '../test-support/project-fixtures'
import { TaskDispatcher } from './task-dispatcher'
import { AgentProviderRegistry, sharedCapabilities } from './agent-provider-registry'
import { WorkspaceFilesService } from './workspace-files'

const temporaryDirectories: string[] = []
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('durable Chat turn dispatch', () => {
  it('adopts a T3 follow-up using the identity reserved when it was steered', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fuddy-steer-fallback-'))
    temporaryDirectories.push(root)
    const database = createTestDatabase(join(root, 'app.sqlite'))
    let releaseFirst = (): void => undefined
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const nativeSteer = vi.fn(async () => 'deferred' as const)
    const execute = vi.fn()
    const registry = new AgentProviderRegistry([{
      provider: 'codex', capabilities: sharedCapabilities,
      recoverSteer: async () => 'deferred',
      async runTurn(input) {
        execute(input.requestId, input.executionStartedAt)
        if (input.prompt === 'start') {
          input.onSteerReady?.(nativeSteer)
          await firstGate
        }
        return { text: 'Done', sessionId: 'session' }
      }
    }])
    const dispatcher = new TaskDispatcher(database, null, new WorkspaceFilesService(database, join(root, 'files')),
      null, undefined, undefined, registry)
    const runId = dispatcher.createDraft({ projectId: null, provider: 'codex' }).run.id
    const first = dispatcher.sendMessage(runId, 'start', undefined, 'first-req')
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    const second = dispatcher.sendMessage(runId, 'follow-up', undefined, 'second-req')
    await dispatcher.steerQueuedTurn('second-req')
    const timestamp = database.getAgentTurn('second-req')?.startedAt
    expect(timestamp).toEqual(expect.any(String))
    expect(nativeSteer).toHaveBeenCalledWith('follow-up', [], 'second-req', timestamp)
    expect(database.hasAgentRunMessage(runId, 'second-req')).toBe(false)
    releaseFirst()
    await Promise.all([first, second])
    expect(execute).toHaveBeenNthCalledWith(2, 'second-req', timestamp)
    expect(database.listAgentRunMessages(runId).filter(message => message.id === 'second-req')).toHaveLength(1)
    database.close()
  })
  it('restores a T3 turn and commits the reply and projection sequence together', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fuddy-recover-t3-'))
    temporaryDirectories.push(root)
    const database = createTestDatabase(join(root, 'app.sqlite'))
    const files = new WorkspaceFilesService(database, join(root, 'files'))
    const runTurn = vi.fn(async (input: CliAgentTurnInput) => {
      expect(input.recoverCommittedTurn).toBe(true)
      input.onCommittedProjection?.(42, true, () => {
        input.onTool('runCommand', 'pwd', { engine: 't3', itemId: 'tool-1' })
      })
      return { text: '已完成', sessionId: 'restored-session' }
    })
    const cli = { runTurn } as unknown as CliAgentRuntime
    const initial = new TaskDispatcher(database, {} as PiTaskHarness, files, cli)
    const run = initial.createDraft({ projectId: null, title: '恢复 T3', provider: 'codex' }).run
    const requestId = crypto.randomUUID()
    database.enqueueAgentTurn({ requestId, runId: run.id, prompt: '请执行', attachments: [],
      requestedByUserId: null, authorSnapshot: null })
    database.claimAgentTurn(requestId)
    database.startAgentTurn({ id: requestId, requestId, runId: run.id, role: 'user', content: '请执行',
      eventType: null, toolName: null, metadata: null, createdAt: run.createdAt },
    { ...run, status: 'running', visibility: 'published' })

    expect(() => database.commitAgentProjection(requestId, 41, () => {
      database.createAgentRunMessage({ id: 'rolled-back', runId: run.id, role: 'assistant', content: '未提交',
        eventType: null, toolName: null, metadata: null, createdAt: run.createdAt })
      throw new Error('模拟事务失败')
    })).toThrow('模拟事务失败')
    expect(database.hasAgentRunMessage(run.id, 'rolled-back')).toBe(false)
    expect(database.getSetting(`agent.projection.${requestId}`, null)).toBeNull()

    const reopened = new TaskDispatcher(database, {} as PiTaskHarness, files, cli, undefined, undefined,
      undefined, undefined, () => true)
    const detail = await reopened.sendMessage(run.id, '请执行', undefined, requestId)
    expect(runTurn).toHaveBeenCalledTimes(1)
    expect(detail.run).toMatchObject({ status: 'idle', sessionId: 'restored-session' })
    expect(detail.messages.map(message => message.content)).toEqual(['请执行', 'pwd', '已完成'])
    expect(database.getAgentTurn(requestId)?.status).toBe('completed')
    expect(database.getSetting(`agent.projection.${requestId}`, null)).toBe(42)
    database.close()
  })

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
