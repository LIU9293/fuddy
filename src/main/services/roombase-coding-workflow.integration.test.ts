import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CliAgentRuntime } from './cli-agent-runtime'
import { AppDatabase } from './database'
import type { PiTaskHarness } from './pi-task-harness'
import { TaskDispatcher } from './task-dispatcher'
import { WorkspaceFilesService } from './workspace-files'

const enabled = process.env.RUN_ROOMBASE_CODING_WORKFLOW === '1'
const integration = enabled ? describe : describe.skip
const temporaryDirectories: string[] = []

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

integration('Roombase coding task delivery workflow', () => {
  it('routes the project default to Codex and persists the resumable result', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'project-agent-roombase-workflow-'))
    temporaryDirectories.push(stateRoot)
    const database = new AppDatabase(join(stateRoot, 'app.sqlite'))
    const roombase = database.listProjects().find((project) => project.id === 'roombase')
    expect(roombase).toBeDefined()
    expect(roombase?.profile.defaultAgent).toBe('codex')
    expect(existsSync(roombase?.profile.repoPath ?? '')).toBe(true)

    const files = new WorkspaceFilesService(database, join(stateRoot, 'project-files'))
    const dispatcher = new TaskDispatcher(
      database,
      {} as PiTaskHarness,
      files,
      new CliAgentRuntime({ getLaunchConfigs: async () => [] })
    )
    const updates: string[] = []
    const result = await dispatcher.dispatch({
      projectId: 'roombase',
      title: 'Roombase · Coding Agent workflow smoke',
      prompt: [
        '这是一次只读的任务投递链路测试。不要修改任何文件，不要访问网络。',
        '检查当前仓库根目录和 workspace/package 配置，确认你收到的是 Roombase 项目上下文。',
        '最终回复必须包含标记 PROJECT_AGENT_ROOMBASE_WORKFLOW_OK，并用一到两句话说明识别到的仓库结构。'
      ].join('\n')
    }, (update) => updates.push(update.type === 'status' ? `status:${update.status}` : update.type))

    expect(result.detail.run).toMatchObject({
      projectId: 'roombase',
      provider: 'codex',
      status: 'idle',
      workingDirectory: roombase?.profile.repoPath
    })
    expect(result.detail.run.sessionId).toBeTruthy()
    expect(result.message.length).toBeGreaterThan(0)
    expect(result.detail.messages.some((message) =>
      message.role === 'assistant' && message.content.includes('PROJECT_AGENT_ROOMBASE_WORKFLOW_OK')
    )).toBe(true)
    expect(updates).toContain('status:running')
    expect(updates).toContain('message_delta')
    expect(updates).toContain('status:idle')
    database.close()
  }, 180_000)
})
