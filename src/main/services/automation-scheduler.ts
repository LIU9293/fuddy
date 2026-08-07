import { AutomationRuntime } from './automation-runtime'
import { AppDatabase } from './database'

const maxTimeout = 2_147_000_000

export class AutomationScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: (() => void) | null = null
  private started = false

  constructor(
    private readonly database: AppDatabase,
    private readonly runtime: AutomationRuntime
  ) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.unsubscribe = this.runtime.onChanged(() => this.scheduleNext())
    void this.runDueAndReschedule()
  }

  stop(): void {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private async runDueAndReschedule(): Promise<void> {
    try {
      await this.runtime.runDue()
    } catch {
      // Individual action failures are persisted by AutomationRuntime. Keep the scheduler alive
      // for unexpected errors and let the next refresh retry future occurrences.
    } finally {
      this.scheduleNext()
    }
  }

  private scheduleNext(): void {
    if (!this.started) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const next = this.database.listAutomations()
      .filter((job) => job.enabled && job.nextRunAt)
      .sort((left, right) => String(left.nextRunAt).localeCompare(String(right.nextRunAt)))[0]
    if (!next?.nextRunAt) return
    const delay = Math.max(1_000, new Date(next.nextRunAt).getTime() - Date.now())
    this.timer = setTimeout(() => void this.runDueAndReschedule(), Math.min(delay, maxTimeout))
  }
}
