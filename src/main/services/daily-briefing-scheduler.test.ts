import { describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from './database'
import type { MorningBriefingService } from './morning-briefing'
import { DailyBriefingScheduler } from './daily-briefing-scheduler'

describe('DailyBriefingScheduler', () => {
  it('reports catch-up failures instead of leaving an unhandled rejection', async () => {
    const error = new Error('briefing generation failed')
    const database = {
      getMorningBriefing: vi.fn().mockReturnValue(null)
    } as unknown as AppDatabase
    const service = {
      generate: vi.fn().mockRejectedValue(error)
    } as unknown as MorningBriefingService
    const onError = vi.fn()
    const scheduler = new DailyBriefingScheduler(database, service, undefined, onError)

    scheduler.start()
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error))
    scheduler.stop()
  })
})
