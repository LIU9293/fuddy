import { collectAiMarketingDailyMetrics } from '../analytics/ai-marketing-daily-metrics'
import {
  registerPostgresAnalyticsCollector,
  type PostgresAnalyticsCollector
} from '../analytics/postgres-analytics-collectors'
import { collectRoombaseDailyMetrics } from '../analytics/roombase-daily-metrics'
import { collectVowsDailyMetrics } from '../analytics/vows-daily-metrics'

const bundledCollectors: Array<[string, PostgresAnalyticsCollector]> = [
  [
    'roombase-daily-v0',
    async (client, evidenceRefs) => {
      const data = await collectRoombaseDailyMetrics(client)
      return {
        summary: `已计算 ${data.projectName} ${data.reportDate} 的完整日指标与 7 日基线。`,
        evidenceRefs,
        signal: null,
        data
      }
    }
  ],
  [
    'vows-growth-v1',
    async (client, evidenceRefs) => {
      const data = await collectVowsDailyMetrics(client)
      const paidWithoutWedding = Number(data.snapshot.paid_without_wedding ?? 0)
      return {
        summary: `已计算 ${data.projectName} ${data.reportDate} 的付费、核心对象创建与互动指标。`,
        evidenceRefs,
        signal:
          paidWithoutWedding > 0
            ? {
                fingerprint: 'paid-without-delivery',
                kind: 'risk',
                title: `${paidWithoutWedding} 个已支付订单尚未完成核心交付`,
                summary: '已支付订单与核心交付对象的链路存在缺口。',
                impact: '用户已经付费但未获得核心交付，需优先确认补偿或重试。',
                urgency: 'high',
                confidence: 1,
                suggestedActions: ['检查支付回调与交付创建日志', '逐单确认交付状态'],
                evidenceRefs,
                source: `${data.projectName} Analytics Profile`
              }
            : null,
        resolvedSignals:
          paidWithoutWedding === 0
            ? [
                {
                  fingerprint: 'paid-without-delivery',
                  summary: '没有已支付但未完成核心交付的订单。',
                  evidenceRefs
                }
              ]
            : [],
        data
      }
    }
  ],
  [
    'ai-marketing-production-v1',
    async (client, evidenceRefs) => {
      const data = await collectAiMarketingDailyMetrics(client)
      const stuckJobs = Number(data.snapshot.stuck_generation_jobs ?? 0)
      const heartbeatAge = data.snapshot.worker_heartbeat_age_minutes
      const workerStale = heartbeatAge === null || Number(heartbeatAge) > 5
      const unhealthy = stuckJobs > 0 || workerStale
      return {
        summary: `已计算 ${data.projectName} ${data.reportDate} 的生成、评审与交付指标。`,
        evidenceRefs,
        signal: unhealthy
          ? {
              fingerprint: 'production-health',
              kind: 'risk',
              title: `${data.projectName} 生产链路需要处理`,
              summary: `${stuckJobs} 个停滞任务；Worker 心跳 ${heartbeatAge === null ? '缺失' : `${heartbeatAge} 分钟前`}。`,
              impact: '生成任务可能无法按预期进入评审与交付。',
              urgency: workerStale ? 'high' : 'medium',
              confidence: 1,
              suggestedActions: ['检查 generation worker', '查看停滞任务错误与重试状态'],
              evidenceRefs,
              source: `${data.projectName} Analytics Profile`
            }
          : null,
        resolvedSignals: unhealthy
          ? []
          : [
              {
                fingerprint: 'production-health',
                summary: '生成任务与 Worker 心跳当前正常。',
                evidenceRefs
              }
            ],
        data
      }
    }
  ]
]

export function registerBundledPostgresCollectors(): void {
  for (const [id, collector] of bundledCollectors) registerPostgresAnalyticsCollector(id, collector)
}
