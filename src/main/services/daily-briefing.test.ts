import { describe, expect, it } from 'vitest'
import {
  buildRoombaseDailyInspections,
  buildRoombaseDailySignals,
  deterministicRoombaseHeadline,
  renderDeterministicRoombaseBriefing
} from './daily-briefing'

const sample = {
  reportDate: '2026-08-04',
  metrics: {
    newUsers: { value: 211, sevenDayAverage: 228.14, vsSevenDayAveragePct: -7.5 },
    firstBookingUsers: { value: 93, sevenDayAverage: 115, vsSevenDayAveragePct: -19.1 },
    bookings: { value: 1259, sevenDayAverage: 1183, vsSevenDayAveragePct: 6.4 },
    netPaidCny: { value: 31648.85, sevenDayAverage: 27123, vsSevenDayAveragePct: 16.7 },
    bookingCancellationRate: { value: 6.83, previousValue: 8.15 },
    paymentSuccessShare: { value: 85.37, previousValue: 83.04 }
  },
  snapshot: {
    waiting_platform_onboardings: 4,
    oldest_waiting_platform_days: 70.4
  }
}

describe('Roombase daily briefing', () => {
  it('renders the verified aggregate story without calling first bookings a conversion rate', () => {
    expect(deterministicRoombaseHeadline(sample)).toContain('首次预订用户偏弱')
    const body = renderDeterministicRoombaseBriefing(sample)
    expect(body).toContain('净实收')
    expect(body).toContain('不代表同日注册用户的转化率')
  })

  it('creates only stable actionable signals', () => {
    const signals = buildRoombaseDailySignals(sample, '2026-08-05T00:00:00.000Z')
    expect(signals).toHaveLength(2)
    expect(signals.map((item) => item.id)).toEqual([
      'daily-roombase-2026-08-04-first-booking',
      'daily-roombase-2026-08-04-onboarding-waiting-platform'
    ])
    expect(signals[1].suggestedActions).toEqual(['检查最老入驻事项的阻塞原因'])
  })

  it('suppresses normal metrics and onboarding noise', () => {
    const quiet = structuredClone(sample)
    quiet.metrics.firstBookingUsers.vsSevenDayAveragePct = -4
    quiet.snapshot.waiting_platform_onboardings = 0
    expect(buildRoombaseDailySignals(quiet)).toEqual([])
    expect(buildRoombaseDailyInspections(quiet).every((item) => item.state === 'resolved')).toBe(true)
  })
})
