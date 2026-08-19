import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SaveAutomationInput } from '../../shared/contracts'
import { AutomationRuntime, type AutomationActions } from './automation-runtime'
import { AppDatabase } from './database'
import { createTestDatabase } from '../test-support/project-fixtures'

const temporaryDirectories: string[] = []

function setup(overrides: Partial<AutomationActions> = {}): {
  database: AppDatabase
  runtime: AutomationRuntime
  actions: AutomationActions
} {
  const directory = mkdtempSync(join(tmpdir(), 'project-agent-automation-'))
  temporaryDirectories.push(directory)
  const database = createTestDatabase(join(directory, 'test.sqlite'))
  const actions: AutomationActions = {
    runAgentTask: vi.fn().mockResolvedValue({ summary: 'Agent 完成', agentRunId: 'run-1' }),
    runConnectors: vi.fn().mockResolvedValue('巡检完成'),
    checkGoals: vi.fn().mockResolvedValue('目标检查完成'),
    generateBriefing: vi.fn().mockResolvedValue('简报完成'),
    ...overrides
  }
  return { database, runtime: new AutomationRuntime(database, actions), actions }
}

function input(patch: Partial<SaveAutomationInput> = {}): SaveAutomationInput {
  return {
    projectId: 'vows',
    name: '每日巡检',
    scheduleDescription: '每天上午九点',
    cronExpression: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    action: 'run-connectors',
    prompt: '',
    agentProvider: 'pi',
    enabled: true,
    requiresConfirmation: false,
    maxRetries: 1,
    retryDelaySeconds: 0,
    ...patch
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('AutomationRuntime', () => {
  it('persists a valid job and calculates its next run', () => {
    const { database, runtime } = setup()
    const job = runtime.save(input())
    expect(job.status).toBe('idle')
    expect(job.nextRunAt).not.toBeNull()
    expect(database.listAutomations()).toHaveLength(1)
    database.close()
  })

  it('executes a manual run and records history', async () => {
    const { database, runtime, actions } = setup()
    const job = runtime.save(input())
    const result = await runtime.runNow(job.id)
    expect(actions.runConnectors).toHaveBeenCalledWith('vows', undefined)
    expect(result.run).toMatchObject({ status: 'completed', attempt: 1, summary: '巡检完成' })
    expect(database.listAutomationRuns(job.id)).toHaveLength(1)
    database.close()
  })

  it('retries failures and exposes the final error', async () => {
    const { database, runtime } = setup({
      runConnectors: vi.fn().mockRejectedValue(new Error('network down'))
    })
    const job = runtime.save(input({ maxRetries: 2 }))
    const result = await runtime.runNow(job.id)
    expect(result.run).toMatchObject({ status: 'failed', attempt: 3, error: 'network down' })
    expect(result.job).toMatchObject({ status: 'error', lastError: 'network down' })
    database.close()
  })

  it('passes cancellation into a running action and persists a stopped result', async () => {
    let receivedSignal: AbortSignal | undefined
    const runAgentTask = vi.fn(async (_job, cancellationSignal?: AbortSignal) => {
      receivedSignal = cancellationSignal
      await new Promise<void>((_resolve, reject) => {
        cancellationSignal?.addEventListener('abort', () => reject(cancellationSignal.reason), { once: true })
      })
      return { summary: '不应完成', agentRunId: 'run-1' }
    })
    const { database, runtime } = setup({ runAgentTask })
    const job = runtime.save(input({ action: 'agent-task', prompt: '继续任务' }))
    const controller = new AbortController()

    const running = runtime.runNow(job.id, controller.signal)
    await vi.waitFor(() => expect(receivedSignal).toBe(controller.signal))
    controller.abort(new Error('账户连接已停止，这次手机操作未继续执行。'))

    await expect(running).rejects.toThrow('账户连接已停止')
    expect(database.listAutomationRuns(job.id)[0]).toMatchObject({
      status: 'failed',
      error: '账户连接已停止，这次手机操作未继续执行。'
    })
    expect(database.getAutomation(job.id).status).toBe('error')
    database.close()
  })

  it('persists cancellation that happens during retry backoff', async () => {
    const runConnectors = vi.fn(async () => {
      throw new Error('temporary failure')
    })
    const { database, runtime } = setup({ runConnectors })
    const job = runtime.save(input({ maxRetries: 2, retryDelaySeconds: 60 }))
    const controller = new AbortController()

    const running = runtime.runNow(job.id, controller.signal)
    await vi.waitFor(() => expect(runConnectors).toHaveBeenCalledOnce())
    controller.abort(new Error('账户连接已停止，这次手机操作未继续执行。'))

    await expect(running).rejects.toThrow('账户连接已停止')
    expect(database.listAutomationRuns(job.id)[0]).toMatchObject({
      status: 'failed',
      error: '账户连接已停止，这次手机操作未继续执行。'
    })
    expect(database.getAutomation(job.id)).toMatchObject({
      status: 'error',
      lastError: '账户连接已停止，这次手机操作未继续执行。'
    })
    database.close()
  })

  it('gates scheduled runs until they are approved', async () => {
    const { database, runtime, actions } = setup()
    const job = runtime.save(input({ requiresConfirmation: true }))
    const scheduledAt = new Date(new Date(job.nextRunAt as string).getTime() + 1_000)
    const [pending] = await runtime.runDue(scheduledAt)
    expect(pending.run.status).toBe('awaiting-confirmation')
    expect(actions.runConnectors).not.toHaveBeenCalled()
    const approved = await runtime.approve(pending.run.id)
    expect(approved.run.status).toBe('completed')
    expect(actions.runConnectors).toHaveBeenCalledOnce()
    database.close()
  })
})
