import type { Client } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { CredentialVault } from '../services/credential-vault'
import { PostgresConnector, quoteMetricView } from './postgres-connector'

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

  it('ends an active client when connector cancellation aborts a query', async () => {
    let rejectQuery: ((error: Error) => void) | null = null
    const query = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN TRANSACTION READ ONLY' || sql === 'ROLLBACK') return { rows: [] }
      return await new Promise<{ rows: [] }>((_resolve, reject) => { rejectQuery = reject })
    })
    const end = vi.fn(async () => {
      rejectQuery?.(new Error('connection terminated'))
    })
    const client = {
      connect: vi.fn(async () => undefined),
      query,
      end
    } as unknown as Client
    const connector = new PostgresConnector(
      {} as CredentialVault,
      () => client
    )
    const controller = new AbortController()
    const collecting = connector.collect({
      config: {
        host: '127.0.0.1',
        port: 5432,
        database: 'fuddy',
        user: 'readonly',
        sslMode: 'disable',
        metricView: 'metrics'
      },
      credentialRef: null,
      cancellationSignal: controller.signal
    })
    await vi.waitFor(() => expect(rejectQuery).not.toBeNull())

    controller.abort(new Error('账户连接已停止，这次手机操作未继续执行。'))

    await expect(collecting).rejects.toThrow('账户连接已停止')
    expect(end).toHaveBeenCalledOnce()
  })
})
