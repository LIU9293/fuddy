import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentRunStreamUpdate } from '../../shared/contracts'
import type { CliAgentRuntime, CliAgentTurnInput } from './cli-agent-runtime'
import { AppDatabase } from './database'
import { createTestDatabase } from '../test-support/project-fixtures'
import type { PiTaskHarness } from './pi-task-harness'
import { TaskDispatcher } from './task-dispatcher'
import { WorkspaceFilesService } from './workspace-files'

function createDispatcher(
  root: string,
  runTurn: (input: CliAgentTurnInput) => Promise<{ text: string; sessionId: string | null }>
): { database: AppDatabase; dispatcher: TaskDispatcher; runId: string } {
  const database = createTestDatabase(join(root, 'app.sqlite'))
  const project = database.listProjects().find((item) => item.id === 'vows')!
  database.updateProject({
    ...project,
    profile: {
      ...project.profile,
      workspaceRoots: [{ id: 'primary', label: 'Primary', path: root }],
      primaryWorkspaceRootId: 'primary'
    }
  })
  const dispatcher = new TaskDispatcher(
    database,
    {} as PiTaskHarness,
    new WorkspaceFilesService(database, join(root, 'files')),
    { runTurn: vi.fn(runTurn) } as unknown as CliAgentRuntime
  )
  const runId = dispatcher.createDraft({ projectId: 'vows', provider: 'codex', title: 'Queue test' }).run.id
  return { database, dispatcher, runId }
}

describe('TaskDispatcher Agent Run turn queue', () => {
  it('runs messages for the same Agent Run sequentially', async () => {
    const root = mkdtempSync(join(tmpdir(), 'project-agent-turn-queue-'))
    const releases: Array<() => void> = []
    const startedPrompts: string[] = []
    const { database, dispatcher, runId } = createDispatcher(root, async (input) => {
      startedPrompts.push(input.prompt)
      await new Promise<void>((resolve) => releases.push(resolve))
      return { text: `完成 ${startedPrompts.length}`, sessionId: 'queue-session' }
    })
    try {
      const first = dispatcher.sendMessage(runId, '第一条消息')
      const secondUpdates: AgentRunStreamUpdate[] = []
      const second = dispatcher.sendMessage(runId, '第二条消息', (update) => secondUpdates.push(update))

      await vi.waitFor(() => expect(startedPrompts).toHaveLength(1))
      expect(secondUpdates).toContainEqual({ type: 'status', status: 'queued' })
      releases.shift()?.()
      await first
      await vi.waitFor(() => expect(startedPrompts).toHaveLength(2))
      releases.shift()?.()
      const detail = await second

      expect(detail.messages.filter((message) => message.role === 'user').map((message) => message.content))
        .toEqual(['第一条消息', '第二条消息'])
      expect(detail.run.status).toBe('idle')
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not start a queued turn after its caller cancels authorization', async () => {
    const root = mkdtempSync(join(tmpdir(), 'project-agent-turn-cancelled-queue-'))
    let releaseFirst!: () => void
    const startedPrompts: string[] = []
    const { database, dispatcher, runId } = createDispatcher(root, async (input) => {
      startedPrompts.push(input.prompt)
      await new Promise<void>((resolve) => { releaseFirst = resolve })
      return { text: '完成', sessionId: 'queue-session' }
    })
    try {
      const first = dispatcher.sendMessage(runId, '第一条消息')
      await vi.waitFor(() => expect(startedPrompts).toHaveLength(1))
      const cancellation = new AbortController()
      const second = dispatcher.sendMessage(
        runId,
        '不应开始的消息',
        () => undefined,
        undefined,
        [],
        cancellation.signal
      )
      cancellation.abort(new Error('账户连接已停止'))

      releaseFirst()
      await first
      await expect(second).rejects.toThrow('账户连接已停止')
      expect(startedPrompts).toHaveLength(1)
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stops only the active reply without failing the Session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'project-agent-turn-stop-'))
    let receivedSignal: AbortSignal | null = null
    const { database, dispatcher, runId } = createDispatcher(root, async (input) => {
      receivedSignal = input.abortController.signal
      await new Promise<void>((_resolve, reject) => {
        input.abortController.signal.addEventListener('abort', () => reject(input.abortController.signal.reason), { once: true })
      })
      return { text: 'unreachable', sessionId: null }
    })
    try {
      const sending = dispatcher.sendMessage(runId, '请执行一个长任务')
      await vi.waitFor(() => expect(receivedSignal).not.toBeNull())
      const stopped = await dispatcher.stopMessage(runId)
      const result = await sending

      expect((receivedSignal as AbortSignal | null)?.aborted).toBe(true)
      expect(stopped.run.status).toBe('idle')
      expect(result.run.status).toBe('idle')
      expect(result.messages.some((message) => message.eventType === 'error')).toBe(false)
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
