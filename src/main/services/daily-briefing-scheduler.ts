import { AppDatabase } from './database'
import { MorningBriefingService } from './morning-briefing'
import {
  millisecondsUntilNextShanghaiRun,
  previousCompleteShanghaiDate
} from './daily-briefing-time'

export class DailyBriefingScheduler {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly database: AppDatabase,
    private readonly service: MorningBriefingService,
    private readonly onReady?: (headline: string) => void,
    private readonly onError?: (error: unknown) => void
  ) {}

  start(): void {
    void this.catchUp().catch((error: unknown) => this.onError?.(error))
    this.scheduleNext()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async catchUp(): Promise<void> {
    const reportDate = previousCompleteShanghaiDate()
    const existing = this.database.getMorningBriefing(reportDate)
    if (!existing || existing.status === 'failed') {
      await this.service.generate()
    }
  }

  private scheduleNext(): void {
    this.timer = setTimeout(async () => {
      try {
        const result = await this.service.generate()
        if (result.briefing.status === 'completed') this.onReady?.(result.briefing.headline)
      } catch (error) {
        this.onError?.(error)
      } finally {
        this.scheduleNext()
      }
    }, millisecondsUntilNextShanghaiRun())
  }
}
