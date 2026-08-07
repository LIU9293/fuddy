import { describe, expect, it } from 'vitest'
import { nextCronOccurrence, parseCronExpression } from './automation-cron'

describe('automation cron', () => {
  it('calculates the next Shanghai occurrence', () => {
    const next = nextCronOccurrence('0 9 * * *', 'Asia/Shanghai', new Date('2026-08-07T01:01:00.000Z'))
    expect(next.toISOString()).toBe('2026-08-08T01:00:00.000Z')
  })

  it('supports lists, ranges and steps', () => {
    const next = nextCronOccurrence('*/15 9-10 * * 1-5', 'Asia/Shanghai', new Date('2026-08-10T01:01:00.000Z'))
    expect(next.toISOString()).toBe('2026-08-10T01:15:00.000Z')
  })

  it('accepts Sunday as 7', () => {
    const next = nextCronOccurrence('30 8 * * 7', 'UTC', new Date('2026-08-07T00:00:00.000Z'))
    expect(next.toISOString()).toBe('2026-08-09T08:30:00.000Z')
  })

  it('rejects malformed expressions and timezones', () => {
    expect(() => parseCronExpression('0 9 * *')).toThrow('5 段')
    expect(() => nextCronOccurrence('99 9 * * *', 'Asia/Shanghai', new Date())).toThrow('分钟')
    expect(() => nextCronOccurrence('0 9 * * *', 'Moon/Base', new Date())).toThrow('无效时区')
  })
})
