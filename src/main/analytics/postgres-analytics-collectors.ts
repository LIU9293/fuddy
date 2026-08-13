import type { Client } from 'pg'
import type { EvidenceRef } from '../../shared/contracts'
import type { ConnectorCollection } from '../connectors/types'

export type PostgresAnalyticsCollector = (client: Client, evidenceRefs: EvidenceRef[]) => Promise<ConnectorCollection>

const collectors = new Map<string, PostgresAnalyticsCollector>()

export function registerPostgresAnalyticsCollector(id: string, collector: PostgresAnalyticsCollector): void {
  if (!id.trim()) throw new Error('Analytics collector ID 不能为空。')
  if (collectors.has(id)) throw new Error(`Analytics collector 已注册：${id}`)
  collectors.set(id, collector)
}

export function getPostgresAnalyticsCollector(id: string): PostgresAnalyticsCollector | null {
  return collectors.get(id) ?? null
}
