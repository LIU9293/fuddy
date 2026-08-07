import { describe, expect, it } from 'vitest'
import { quoteMetricView } from './postgres-connector'

describe('PostgreSQL metric view safety', () => {
  it('quotes a controlled schema and view name', () => {
    expect(quoteMetricView('project_agent.metrics')).toBe('"project_agent"."metrics"')
    expect(quoteMetricView('metrics')).toBe('"metrics"')
  })

  it('rejects SQL and multi-part identifiers', () => {
    expect(() => quoteMetricView('metrics; DROP TABLE users')).toThrow('安全标识符')
    expect(() => quoteMetricView('one.two.three')).toThrow('无效')
    expect(() => quoteMetricView('public."metrics"')).toThrow('安全标识符')
  })
})
