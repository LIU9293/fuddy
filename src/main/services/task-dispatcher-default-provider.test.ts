import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CliAgentRuntime, CliAgentTurnInput } from './cli-agent-runtime'
import { AppDatabase } from './database'
import type { PiTaskHarness } from './pi-task-harness'
import { TaskDispatcher } from './task-dispatcher'
import { WorkspaceFilesService } from './workspace-files'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('TaskDispatcher project agent defaults', () => {
  it('creates a draft session with the project defaults without sending its first message', () => {
    const root = mkdtempSync(join(tmpdir(), 'project-agent-draft-session-'))
    temporaryDirectories.push(root)
    const database = new AppDatabase(join(root, 'app.sqlite'))
    const roombase = database.listProjects().find((project) => project.id === 'roombase')!
    database.updateProject({
      ...roombase,
      profile: {
        ...roombase.profile,
        repoPath: root,
        workspaceRoots: [{ id: 'primary', label: 'Test', path: root }],
        primaryWorkspaceRootId: 'primary',
        defaultAgent: 'claude'
      }
    })
    const dispatcher = new TaskDispatcher(
      database,
      {} as PiTaskHarness,
      new WorkspaceFilesService(database, join(root, 'files')),
      {} as CliAgentRuntime
    )

    const decisionId = database.createDecision({
      projectId: 'roombase',
      title: '等待平台处理',
      summary: '生产仍有等待平台处理的事项。'
    }).id
    const detail = dispatcher.createDraft({
      projectId: 'roombase',
      decisionId,
      title: '处理 · 等待平台处理'
    })

    expect(detail.run).toMatchObject({
      projectId: 'roombase',
      decisionId,
      provider: 'claude',
      workingDirectory: root,
      title: '处理 · 等待平台处理',
      status: 'draft',
      summary: '等待首次消息'
    })
    expect(detail.run.draftPrompt).toBeNull()
    expect(detail.messages).toEqual([])
    database.close()
  })

  it('persists a draft prompt, clears it on first send, and registers changed project files as artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'project-agent-draft-prompt-'))
    temporaryDirectories.push(root)
    const database = new AppDatabase(join(root, 'app.sqlite'))
    const vows = database.listProjects().find((project) => project.id === 'vows')!
    database.updateProject({
      ...vows,
      profile: {
        ...vows.profile,
        repoPath: root,
        workspaceRoots: [{ id: 'primary', label: 'Vows', path: root }],
        primaryWorkspaceRootId: 'primary',
        defaultAgent: 'codex'
      }
    })
    const files = new WorkspaceFilesService(database, join(root, 'files'))
    const runTurn = vi.fn(async (input: CliAgentTurnInput) => {
      files.write('vows', 'marketing/social/setup.md', '# 已整理')
      return { text: '已整理宣传资料。', sessionId: 'draft-session' }
    })
    const dispatcher = new TaskDispatcher(
      database,
      {} as PiTaskHarness,
      files,
      { runTurn } as unknown as CliAgentRuntime
    )
    const draft = dispatcher.createDraft({
      projectId: 'vows',
      title: '整理社交媒体资料',
      draftPrompt: '先查找 Logo，再整理小红书和抖音资料。'
    })

    expect(draft.run.draftPrompt).toContain('查找 Logo')
    expect(draft.messages).toEqual([])

    const edited = database.updateAgentRunDraftPrompt(draft.run.id, '先复用已有 Logo，再整理两个平台的资料。')
    expect(edited.draftPrompt).toContain('复用已有 Logo')

    const completed = await dispatcher.sendMessage(draft.run.id, edited.draftPrompt!)

    expect(completed.run.draftPrompt).toBeNull()
    expect(completed.messages[0]).toMatchObject({ role: 'user', content: expect.stringContaining('复用已有 Logo') })
    expect(completed.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: 'marketing/social/setup.md' })
    ]))
    database.close()
  })

  it('uses the project default agent when dispatch omits provider', async () => {
    const root = mkdtempSync(join(tmpdir(), 'project-agent-default-provider-'))
    temporaryDirectories.push(root)
    const database = new AppDatabase(join(root, 'app.sqlite'))
    const roombase = database.listProjects().find((project) => project.id === 'roombase')
    expect(roombase).toBeDefined()
    database.updateProject({
      ...roombase!,
      profile: {
        ...roombase!.profile,
        repoPath: root,
        workspaceRoots: [{ id: 'primary', label: 'Test', path: root }],
        primaryWorkspaceRootId: 'primary',
        defaultAgent: 'opencode'
      }
    })
    const files = new WorkspaceFilesService(database, join(root, 'files'))
    const runTurn = vi.fn(async (input: CliAgentTurnInput) => ({
      text: `provider=${input.provider}`,
      sessionId: 'session-default-provider'
    }))
    const dispatcher = new TaskDispatcher(
      database,
      {} as PiTaskHarness,
      files,
      { runTurn } as unknown as CliAgentRuntime
    )

    const updates: string[] = []
    const result = await dispatcher.dispatch({
      projectId: 'roombase',
      workingDirectory: root,
      prompt: '检查默认 Agent 路由'
    }, (update) => updates.push(update.type))

    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'opencode',
      workingDirectory: root,
      workspaceRoots: [root]
    }))
    expect(result.detail.run).toMatchObject({
      projectId: 'roombase',
      provider: 'opencode',
      sessionId: 'session-default-provider',
      status: 'idle'
    })
    expect(updates[0]).toBe('created')
    database.close()
  })

  it('stops a turn and marks it failed after prolonged inactivity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'project-agent-inactivity-timeout-'))
    temporaryDirectories.push(root)
    const database = new AppDatabase(join(root, 'app.sqlite'))
    const files = new WorkspaceFilesService(database, join(root, 'files'))
    let aborted = false
    const runTurn = vi.fn((input: CliAgentTurnInput) => new Promise<never>((_resolve, reject) => {
      input.abortController.signal.addEventListener('abort', () => {
        aborted = true
        reject(input.abortController.signal.reason)
      }, { once: true })
    }))
    const dispatcher = new TaskDispatcher(
      database,
      {} as PiTaskHarness,
      files,
      { runTurn } as unknown as CliAgentRuntime,
      20
    )

    const result = await dispatcher.dispatch({
      projectId: null,
      provider: 'opencode',
      workingDirectory: root,
      prompt: '模拟无活动的 Agent'
    })

    expect(aborted).toBe(true)
    expect(result.detail.run.status).toBe('failed')
    expect(result.detail.run.summary).toContain('没有返回消息或工具活动')
    expect(result.detail.messages.at(-1)).toMatchObject({ role: 'system', eventType: 'error' })
    database.close()
  })

  it('recovers queued and running sessions left behind by an app restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'project-agent-recovery-'))
    temporaryDirectories.push(root)
    const database = new AppDatabase(join(root, 'app.sqlite'))
    const timestamp = new Date(Date.now() - 60_000).toISOString()
    database.createAgentRun({
      id: 'interrupted-run',
      projectId: null,
      provider: 'pi',
      title: 'Interrupted run',
      status: 'running',
      sessionId: null,
      workingDirectory: root,
      startedAt: timestamp,
      completedAt: null,
      summary: '运行中',
      draftPrompt: null,
      createdAt: timestamp,
      updatedAt: timestamp
    })

    new TaskDispatcher(
      database,
      {} as PiTaskHarness,
      new WorkspaceFilesService(database, join(root, 'files')),
      {} as CliAgentRuntime
    )

    const detail = database.getAgentRunDetail('interrupted-run')
    expect(detail.run.status).toBe('failed')
    expect(detail.run.summary).toContain('应用退出或重启中断')
    expect(detail.messages.at(-1)).toMatchObject({ role: 'system', eventType: 'error' })
    database.close()
  })

  it('renames sessions and archives them without deleting their history', () => {
    const root = mkdtempSync(join(tmpdir(), 'project-agent-archive-'))
    temporaryDirectories.push(root)
    const database = new AppDatabase(join(root, 'app.sqlite'))
    const timestamp = new Date().toISOString()
    database.createAgentRun({
      id: 'session-to-archive',
      projectId: null,
      provider: 'pi',
      title: 'Old title',
      status: 'idle',
      sessionId: 'pi-session',
      workingDirectory: root,
      startedAt: timestamp,
      completedAt: null,
      summary: 'Ready',
      draftPrompt: null,
      createdAt: timestamp,
      updatedAt: timestamp
    })

    expect(database.renameAgentRun('session-to-archive', 'New title').title).toBe('New title')
    database.archiveAgentRun('session-to-archive')

    expect(database.listRuns().some((run) => run.id === 'session-to-archive')).toBe(false)
    expect(database.getAgentRunDetail('session-to-archive').run).toMatchObject({
      title: 'New title',
      sessionId: 'pi-session'
    })
    database.close()
  })
})
