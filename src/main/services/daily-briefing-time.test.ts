import { describe, expect, it } from 'vitest'
import {
  millisecondsUntilNextShanghaiRun,
  previousCompleteShanghaiDate
} from './daily-briefing-time'

describe('daily briefing Shanghai schedule', () => {
  it('uses the previous complete Shanghai calendar day', () => {
    expect(previousCompleteShanghaiDate(new Date('2026-08-05T00:30:00.000Z'))).toBe('2026-08-04')
    expect(previousCompleteShanghaiDate(new Date('2026-08-04T15:30:00.000Z'))).toBe('2026-08-03')
  })

  it('schedules the next 09:00 in Asia/Shanghai', () => {
    expect(millisecondsUntilNextShanghaiRun(new Date('2026-08-06T00:00:00.000Z'))).toBe(60 * 60 * 1_000)
    expect(millisecondsUntilNextShanghaiRun(new Date('2026-08-06T01:30:00.000Z'))).toBe(23.5 * 60 * 60 * 1_000)
  })
})
