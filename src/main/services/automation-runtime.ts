import { randomUUID } from 'node:crypto'
import type {
  AutomationJob,
  AutomationRun,
  RunAutomationResult,
  SaveAutomationInput
} from '../../shared/contracts'
import { nextCronOccurrence } from './automation-cron'
import { AppDatabase } from './database'
import { cancellationError, throwIfCancelled } from './cancellation'

export interface AutomationActions {
  runAgentTask(job: AutomationJob, cancellationSignal?: AbortSignal): Promise<{ summary: string; agentRunId: string }>
  runConnectors(projectId: string | null, cancellationSignal?: AbortSignal): Promise<string>
  checkGoals(projectId: string | null, cancellationSignal?: AbortSignal): Promise<string>
  generateBriefing(projectId: string | null, cancellationSignal?: AbortSignal): Promise<string>
}

function wait(milliseconds: number, cancellationSignal?: AbortSignal): Promise<void> {
  if (!cancellationSignal) return new Promise((resolve) => setTimeout(resolve, milliseconds))
  throwIfCancelled(cancellationSignal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cancellationSignal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = (): void => {
      clearTimeout(timer)
      cancellationSignal.removeEventListener('abort', abort)
      reject(cancellationSignal.reason instanceof Error
        ? cancellationSignal.reason
        : new Error('这次操作已停止。'))
    }
    cancellationSignal.addEventListener('abort', abort, { once: true })
    if (cancellationSignal.aborted) abort()
  })
}

export class AutomationRuntime {
  private readonly changeListeners = new Set<() => void>()

  constructor(
    private readonly database: AppDatabase,
    private readonly actions: AutomationActions
  ) {
    const now = new Date()
    this.database.recoverInterruptedAutomations(now.toISOString())
    for (const job of this.database.listAutomations()) {
      if (job.enabled && job.nextRunAt && new Date(job.nextRunAt).getTime() <= now.getTime() && job.status === 'error') {
        this.database.updateAutomationRuntime(job.id, {
          status: 'error',
          lastRunAt: job.lastRunAt,
          nextRunAt: nextCronOccurrence(job.cronExpression, job.timezone, now).toISOString(),
          lastError: job.lastError
        })
      }
    }
  }

  onChanged(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  private notifyChanged(): void {
    for (const listener of this.changeListeners) listener()
  }

  save(input: SaveAutomationInput): AutomationJob {
    const now = new Date()
    const existing = input.id ? this.database.getAutomation(input.id) : null
    if (existing?.status === 'running') throw new Error('自动任务运行中，暂时不能修改。')
    if (input.projectId && !this.database.listProjects().some((project) => project.id === input.projectId)) {
      throw new Error('自动任务引用的项目不存在。')
    }
    if (input.action === 'agent-task' && !input.prompt.trim()) throw new Error('Agent 自动任务需要填写任务指令。')
    const nextRunAt = input.enabled ? nextCronOccurrence(input.cronExpression, input.timezone, now).toISOString() : null
    const timestamp = now.toISOString()
    const job: AutomationJob = {
      id: existing?.id ?? randomUUID(),
      projectId: input.projectId,
      name: input.name.trim(),
      scheduleDescription: input.scheduleDescription.trim(),
      cronExpression: input.cronExpression.trim(),
      timezone: input.timezone.trim(),
      action: input.action,
      prompt: input.prompt.trim(),
      agentProvider: input.agentProvider,
      enabled: input.enabled,
      requiresConfirmation: input.requiresConfirmation,
      maxRetries: input.maxRetries,
      retryDelaySeconds: input.retryDelaySeconds,
      status: input.enabled ? 'idle' : 'paused',
      lastRunAt: existing?.lastRunAt ?? null,
      nextRunAt,
      lastError: null,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    }
    const saved = this.database.saveAutomation(job)
    this.notifyChanged()
    return saved
  }

  setEnabled(id: string, enabled: boolean): AutomationJob {
    const existing = this.database.getAutomation(id)
    if (existing.status === 'running') throw new Error('自动任务运行中，暂时不能启停。')
    const next = enabled ? nextCronOccurrence(existing.cronExpression, existing.timezone, new Date()).toISOString() : null
    const updated = this.database.setAutomationEnabled(id, enabled, next)
    this.notifyChanged()
    return updated
  }

  async runNow(id: string, cancellationSignal?: AbortSignal): Promise<RunAutomationResult> {
    return this.execute(this.database.getAutomation(id), 'manual', undefined, cancellationSignal)
  }

  async approve(runId: string): Promise<RunAutomationResult> {
    const run = this.database.getAutomationRun(runId)
    if (run.status !== 'awaiting-confirmation') throw new Error('这条运行记录不在等待确认状态。')
    return this.execute(this.database.getAutomation(run.automationId), run.trigger, run)
  }

  async runDue(now = new Date()): Promise<RunAutomationResult[]> {
    const due = this.database.listAutomations().filter((job) =>
      job.enabled && job.nextRunAt !== null && new Date(job.nextRunAt).getTime() <= now.getTime()
    )
    const results: RunAutomationResult[] = []
    for (const job of due) {
      const nextRunAt = nextCronOccurrence(job.cronExpression, job.timezone, now).toISOString()
      const awaiting = this.database.listAutomationRuns(job.id).find((run) => run.status === 'awaiting-confirmation')
      if (awaiting) {
        const timestamp = now.toISOString()
        const skipped = this.database.saveAutomationRun({
          id: randomUUID(),
          automationId: job.id,
          status: 'skipped',
          trigger: 'scheduled',
          attempt: 0,
          startedAt: timestamp,
          completedAt: timestamp,
          summary: '上一次计划运行仍在等待人工确认，本次已跳过。',
          error: null,
          agentRunId: null
        })
        const updated = this.database.updateAutomationRuntime(job.id, {
          status: 'waiting-confirmation',
          lastRunAt: job.lastRunAt,
          nextRunAt,
          lastError: null
        })
        results.push({ job: updated, run: skipped })
        continue
      }
      if (job.requiresConfirmation) {
        const pending = this.database.saveAutomationRun({
          id: randomUUID(),
          automationId: job.id,
          status: 'awaiting-confirmation',
          trigger: 'scheduled',
          attempt: 0,
          startedAt: now.toISOString(),
          completedAt: null,
          summary: '计划已触发，等待人工确认后执行。',
          error: null,
          agentRunId: null
        })
        const updated = this.database.updateAutomationRuntime(job.id, {
          status: 'waiting-confirmation',
          lastRunAt: job.lastRunAt,
          nextRunAt,
          lastError: null
        })
        results.push({ job: updated, run: pending })
        continue
      }
      // Advance the schedule before running so a crash cannot retrigger the same occurrence.
      this.database.updateAutomationRuntime(job.id, {
        status: job.status,
        lastRunAt: job.lastRunAt,
        nextRunAt,
        lastError: job.lastError
      })
      results.push(await this.execute(this.database.getAutomation(job.id), 'scheduled'))
    }
    this.notifyChanged()
    return results
  }

  private async execute(
    job: AutomationJob,
    trigger: AutomationRun['trigger'],
    existingRun?: AutomationRun,
    cancellationSignal?: AbortSignal
  ): Promise<RunAutomationResult> {
    throwIfCancelled(cancellationSignal)
    if (job.status === 'running') throw new Error('这个自动任务已经在运行。')
    const startedAt = existingRun?.startedAt ?? new Date().toISOString()
    let run = this.database.saveAutomationRun({
      id: existingRun?.id ?? randomUUID(),
      automationId: job.id,
      status: 'running',
      trigger,
      attempt: 0,
      startedAt,
      completedAt: null,
      summary: '正在执行…',
      error: null,
      agentRunId: null
    })
    job = this.database.updateAutomationRuntime(job.id, {
      status: 'running',
      lastRunAt: startedAt,
      nextRunAt: job.nextRunAt,
      lastError: null
    })
    this.notifyChanged()

    let lastError: Error | null = null
    for (let attempt = 1; attempt <= job.maxRetries + 1; attempt += 1) {
      throwIfCancelled(cancellationSignal)
      run = this.database.saveAutomationRun({ ...run, attempt, summary: attempt > 1 ? `正在进行第 ${attempt} 次尝试…` : '正在执行…' })
      try {
        const result = await this.performAction(job, cancellationSignal)
        const completedAt = new Date().toISOString()
        run = this.database.saveAutomationRun({
          ...run,
          status: 'completed',
          completedAt,
          summary: result.summary,
          error: null,
          agentRunId: result.agentRunId
        })
        job = this.database.updateAutomationRuntime(job.id, {
          status: job.enabled ? 'idle' : 'paused',
          lastRunAt: startedAt,
          nextRunAt: job.enabled
            ? job.nextRunAt ?? nextCronOccurrence(job.cronExpression, job.timezone, new Date()).toISOString()
            : null,
          lastError: null
        })
        this.notifyChanged()
        return { job, run }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        const stopped = cancellationError(cancellationSignal)
        if (stopped) {
          lastError = stopped
          break
        }
        if (attempt <= job.maxRetries && job.retryDelaySeconds > 0) {
          try {
            await wait(job.retryDelaySeconds * 1_000, cancellationSignal)
          } catch (backoffError) {
            lastError = backoffError instanceof Error ? backoffError : new Error(String(backoffError))
            break
          }
        }
      }
    }

    const completedAt = new Date().toISOString()
    const message = lastError?.message ?? '自动任务执行失败。'
    run = this.database.saveAutomationRun({
      ...run,
      status: 'failed',
      completedAt,
      summary: `执行失败（已尝试 ${run.attempt} 次）`,
      error: message,
      agentRunId: null
    })
    job = this.database.updateAutomationRuntime(job.id, {
      status: 'error',
      lastRunAt: startedAt,
      nextRunAt: job.enabled
        ? job.nextRunAt ?? nextCronOccurrence(job.cronExpression, job.timezone, new Date()).toISOString()
        : null,
      lastError: message
    })
    this.notifyChanged()
    throwIfCancelled(cancellationSignal)
    return { job, run }
  }

  private async performAction(
    job: AutomationJob,
    cancellationSignal?: AbortSignal
  ): Promise<{ summary: string; agentRunId: string | null }> {
    if (job.action === 'agent-task') return this.actions.runAgentTask(job, cancellationSignal)
    if (job.action === 'run-connectors') {
      return { summary: await this.actions.runConnectors(job.projectId, cancellationSignal), agentRunId: null }
    }
    if (job.action === 'check-goals') {
      return { summary: await this.actions.checkGoals(job.projectId, cancellationSignal), agentRunId: null }
    }
    return { summary: await this.actions.generateBriefing(job.projectId, cancellationSignal), agentRunId: null }
  }
}
