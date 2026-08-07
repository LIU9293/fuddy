import { describe, expect, it, vi } from 'vitest'
import type { Client } from 'pg'
import { collectVowsDailyMetrics } from './vows-daily-metrics'
import { collectAiMarketingDailyMetrics } from './ai-marketing-daily-metrics'

function rows(keys: string[]): Array<Record<string, string | number>> {
  return Array.from({ length: 8 }, (_, index) => Object.fromEntries([
    ['report_day', `2026-08-0${index + 1}`],
    ...keys.map((key) => [key, index + 1])
  ]))
}

describe('built-in project daily metrics', () => {
  it('collects aggregate-only Vows funnel metrics', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: rows([
        'new_users', 'payment_orders', 'paid_orders', 'paid_cents', 'weddings_created', 'ready_weddings',
        'published_weddings', 'published_events', 'rsvps', 'blessings', 'media_assets'
      ]) })
      .mockResolvedValueOnce({ rows: [{ expired_pending_orders: 1, paid_without_wedding: 2 }] })
    const result = await collectVowsDailyMetrics({ query } as unknown as Client)
    expect(result).toEqual(expect.objectContaining({ analyticsProfile: 'vows-growth-v1', reportDate: '2026-08-08' }))
    expect(result.metrics.paidRevenueCny.value).toBe(0.08)
    expect(result.snapshot.paid_without_wedding).toBe(2)
    const sql = query.mock.calls.map((call) => String(call[0])).join('\n')
    expect(sql).not.toMatch(/guest_name|message|photo_urls|public_url|wechat_open_id/i)
  })

  it('collects aggregate AI Marketing production metrics and health snapshots', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: rows([
        'image_creations', 'completed_image_creations', 'generation_jobs', 'completed_jobs', 'failed_jobs',
        'cost_units', 'image_candidates', 'adopted_candidates', 'reviews', 'adopted_reviews', 'change_reviews',
        'rejected_reviews', 'ready_image_deliverables', 'campaigns', 'final_stage_campaigns', 'final_video_deliverables'
      ]) })
      .mockResolvedValueOnce({ rows: [{ stuck_generation_jobs: 1, worker_heartbeat_age_minutes: 7 }] })
    const result = await collectAiMarketingDailyMetrics({ query } as unknown as Client)
    expect(result).toEqual(expect.objectContaining({ analyticsProfile: 'ai-marketing-production-v1', reportDate: '2026-08-08' }))
    expect(result.metrics.adoptedReviews.value).toBe(8)
    expect(result.snapshot.worker_heartbeat_age_minutes).toBe(7)
    const sql = query.mock.calls.map((call) => String(call[0])).join('\n')
    expect(sql).not.toMatch(/prompt|request_json|metadata_json|created_by|content_url/i)
  })
})
