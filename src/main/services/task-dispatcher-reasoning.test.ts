import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CliAgentRuntime, CliAgentTurnInput } from './cli-agent-runtime'
import { AppDatabase } from './database'
import type { PiTaskHarness } from './pi-task-harness'
import { TaskDispatcher } from './task-dispatcher'
import { WorkspaceFilesService } from './workspace-files'

describe('TaskDispatcher reasoning timeline', () => {
  it('persists separate reasoning segments before their individual tool calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'project-agent-reasoning-'))
    const database = new AppDatabase(join(root, 'app.sqlite'))
    try {
      const project = database.listProjects().find((item) => item.id === 'vows')!
      database.updateProject({
        ...project,
        profile: {
          ...project.profile,
          workspaceRoots: [{ id: 'primary', label: 'Primary', path: root }],
          primaryWorkspaceRootId: 'primary'
        }
      })
      const cli = {
        runTurn: vi.fn(async (input: CliAgentTurnInput) => {
          input.onUpdate({ type: 'reasoning_delta', segmentId: 'thinking-1', delta: '先读取说明，' })
          input.onUpdate({ type: 'reasoning_delta', segmentId: 'thinking-1', delta: '确认约束。' })
          input.onUpdate({ type: 'tool', toolCallId: 'tool-1', toolName: 'Read', status: 'running', detail: 'AGENTS.md' })
          input.onTool('Read', 'AGENTS.md content')
          input.onUpdate({ type: 'tool', toolCallId: 'tool-1', toolName: 'Read', status: 'completed', detail: 'AGENTS.md content' })
          input.onUpdate({ type: 'reasoning_delta', segmentId: 'thinking-2', delta: '再检查实现。' })
          input.onUpdate({ type: 'tool', toolCallId: 'tool-2', toolName: 'Read', status: 'running', detail: 'src/index.ts' })
          input.onTool('Read', 'src/index.ts content')
          return { text: '检查完成。', sessionId: 'session-1' }
        })
      } as unknown as CliAgentRuntime
      const dispatcher = new TaskDispatcher(
        database,
        {} as PiTaskHarness,
        new WorkspaceFilesService(database, join(root, 'files')),
        cli
      )

      const result = await dispatcher.dispatch({ projectId: 'vows', provider: 'codex', prompt: '检查项目' })
      expect(result.detail.messages.map((message) => [message.role, message.eventType, message.toolName])).toEqual([
        ['user', null, null],
        ['assistant', 'reasoning', null],
        ['tool', 'tool', 'Read'],
        ['assistant', 'reasoning', null],
        ['tool', 'tool', 'Read'],
        ['assistant', null, null]
      ])
      expect(result.detail.messages[1]).toMatchObject({ content: '先读取说明，确认约束。', metadata: { segmentId: 'thinking-1' } })
      expect(result.detail.messages[3]).toMatchObject({ content: '再检查实现。', metadata: { segmentId: 'thinking-2' } })
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('promotes visible progress text before a tool into its own thinking segment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'project-agent-visible-thinking-'))
    const database = new AppDatabase(join(root, 'app.sqlite'))
    try {
      const project = database.listProjects().find((item) => item.id === 'vows')!
      database.updateProject({
        ...project,
        profile: {
          ...project.profile,
          workspaceRoots: [{ id: 'primary', label: 'Primary', path: root }],
          primaryWorkspaceRootId: 'primary'
        }
      })
      const cli = {
        runTurn: vi.fn(async (input: CliAgentTurnInput) => {
          input.onUpdate({ type: 'message_delta', messageId: 'message-1', delta: '我先读取项目说明，再核对配置。' })
          input.onUpdate({ type: 'tool', toolCallId: 'tool-1', toolName: 'Read', status: 'running', detail: 'README.md' })
          input.onTool('Read', 'README.md content')
          input.onUpdate({ type: 'tool', toolCallId: 'tool-1', toolName: 'Read', status: 'completed', detail: 'README.md content' })
          input.onUpdate({ type: 'message_delta', messageId: 'message-1', delta: '检查完成，没有修改文件。' })
          return { text: '我先读取项目说明，再核对配置。检查完成，没有修改文件。', sessionId: 'session-1' }
        })
      } as unknown as CliAgentRuntime
      const dispatcher = new TaskDispatcher(
        database,
        {} as PiTaskHarness,
        new WorkspaceFilesService(database, join(root, 'files')),
        cli
      )

      const result = await dispatcher.dispatch({ projectId: 'vows', provider: 'claude', prompt: '只读检查' })
      expect(result.detail.messages.map((message) => [message.role, message.eventType, message.toolName])).toEqual([
        ['user', null, null],
        ['assistant', 'reasoning', null],
        ['tool', 'tool', 'Read'],
        ['assistant', null, null]
      ])
      expect(result.detail.messages[1]).toMatchObject({
        content: '我先读取项目说明，再核对配置。',
        metadata: { segmentId: 'visible-thinking-0' }
      })
      expect(result.detail.messages[3].content).toBe('检查完成，没有修改文件。')
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
