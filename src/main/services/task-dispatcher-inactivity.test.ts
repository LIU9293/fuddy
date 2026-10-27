import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase } from '../test-support/project-fixtures'
import { TaskDispatcher, AGENT_RUN_INACTIVITY_TIMEOUT_MS } from './task-dispatcher'
import { WorkspaceFilesService } from './workspace-files'
import type { PiTaskHarness } from './pi-task-harness'
import type { CliAgentRuntime, CliAgentTurnInput, CliAgentTurnResult } from './cli-agent-runtime'

const cleanup: Array<() => void> = []
afterEach(() => { vi.useRealTimers(); cleanup.splice(0).reverse().forEach(fn => fn()) })

async function start() {
  vi.useFakeTimers()
  const root = mkdtempSync(join(tmpdir(), 'fuddy-inactivity-'))
  const database = createTestDatabase(join(root, 'test.sqlite'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }), () => database.close())
  let input!: CliAgentTurnInput
  let finish!: (result: CliAgentTurnResult) => void
  const runTurn = vi.fn((turn: CliAgentTurnInput) => {
    input = turn
    return new Promise<CliAgentTurnResult>((resolve, reject) => {
      finish = resolve
      turn.abortController.signal.addEventListener('abort', () => reject(turn.abortController.signal.reason), { once: true })
    })
  })
  const dispatcher = new TaskDispatcher(database, {} as PiTaskHarness, new WorkspaceFilesService(database, join(root, 'files')),
    { runTurn } as unknown as CliAgentRuntime)
  const run = dispatcher.createDraft({ projectId: null, provider: 'codex', title: 'Long tool', workingDirectory: root }).run
  const done = dispatcher.sendMessage(run.id, '执行任务')
  await vi.advanceTimersByTimeAsync(0)
  expect(runTurn).toHaveBeenCalledOnce()
  const tool = (id: string, status: 'running' | 'completed' | 'failed') => input.onUpdate({
    type: 'tool', toolCallId: id, toolName: 'command', status, detail: ''
  })
  return { input, finish, dispatcher, run, done, tool }
}

describe('Agent inactivity versus tool execution', () => {
  it('allows an hour-long silent tool and starts a fresh idle window only when all concurrent tools finish', async () => {
    const { input, done, tool } = await start()
    tool('one', 'running')
    tool('two', 'running')
    tool('one', 'running') // repeated progress must not increase the active count
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(input.abortController.signal.aborted).toBe(false)
    tool('one', 'completed')
    tool('one', 'completed') // duplicate terminal event must not clear another tool
    await vi.advanceTimersByTimeAsync(AGENT_RUN_INACTIVITY_TIMEOUT_MS * 2)
    expect(input.abortController.signal.aborted).toBe(false)
    tool('two', 'failed')
    await vi.advanceTimersByTimeAsync(AGENT_RUN_INACTIVITY_TIMEOUT_MS - 1)
    expect(input.abortController.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((await done).run.status).toBe('failed')
    expect(input.abortController.signal.reason.message).toContain('未检测到正在执行的工具')
  })

  it('accepts internal progress without adding it to visible messages, then times out if progress stops', async () => {
    const { input, done } = await start()
    for (let count = 0; count < 4; count++) {
      await vi.advanceTimersByTimeAsync(AGENT_RUN_INACTIVITY_TIMEOUT_MS - 1)
      input.onActivity?.()
      expect(input.abortController.signal.aborted).toBe(false)
    }
    await vi.advanceTimersByTimeAsync(AGENT_RUN_INACTIVITY_TIMEOUT_MS)
    const result = await done
    expect(result.run.status).toBe('failed')
    expect(result.messages.map(message => message.role)).toEqual(['user', 'system'])
  })

  it('still stops a long running tool immediately when the user requests it', async () => {
    const { input, done, tool, dispatcher, run } = await start()
    tool('long', 'running')
    await vi.advanceTimersByTimeAsync(AGENT_RUN_INACTIVITY_TIMEOUT_MS * 3)
    await dispatcher.stopMessage(run.id)
    expect(input.abortController.signal.aborted).toBe(true)
    expect((await done).run.status).toBe('idle')
  })

  it('cleans up the watchdog after successful completion and ignores late liveness callbacks', async () => {
    const { input, done, tool, finish } = await start()
    tool('long', 'running')
    await vi.advanceTimersByTimeAsync(AGENT_RUN_INACTIVITY_TIMEOUT_MS * 2)
    tool('long', 'completed')
    finish({ text: '完成', sessionId: 'native' })
    expect((await done).run.status).toBe('idle')
    input.onActivity?.()
    await vi.advanceTimersByTimeAsync(AGENT_RUN_INACTIVITY_TIMEOUT_MS * 2)
    expect(input.abortController.signal.aborted).toBe(false)
  })
})
