import type { Client } from 'pg'
import { metricComparison, requireEightDayWindow, type MetricComparison, type NumericMetricRow } from './daily-metric-window'

export interface AiMarketingDailyMetrics extends Record<string, unknown> {
  schemaVersion: 1
  analyticsProfile: 'ai-marketing-production-v1'
  projectId: 'ai-marketing'
  projectName: 'AI Marketing'
  reportDate: string
  timezone: 'Asia/Shanghai'
  period: 'previous-complete-calendar-day'
  metrics: Record<string, MetricComparison>
  snapshot: Record<string, number | null>
  dataQuality: string[]
}

export async function collectAiMarketingDailyMetrics(client: Client): Promise<AiMarketingDailyMetrics> {
  const dailyResult = await client.query<NumericMetricRow>(`
    WITH bounds AS (
      SELECT ((date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') - interval '1 day') AT TIME ZONE 'Asia/Shanghai') report_start,
        (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') report_end
    ), days AS (
      SELECT generate_series(report_start - interval '7 days', report_start, interval '1 day') day_start FROM bounds
    ), creation_daily AS (
      SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai')::date metric_day, count(*)::int image_creations,
        count(*) FILTER (WHERE status = 'completed')::int completed_image_creations
      FROM image_creations, bounds WHERE created_at >= report_start - interval '7 days' AND created_at < report_end GROUP BY 1
    ), job_daily AS (
      SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai')::date metric_day, count(*)::int generation_jobs,
        count(*) FILTER (WHERE status = 'completed')::int completed_jobs,
        count(*) FILTER (WHERE status IN ('failed', 'cancelled'))::int failed_jobs,
        coalesce(sum(cost_units), 0)::double precision cost_units
      FROM generation_jobs, bounds WHERE created_at >= report_start - interval '7 days' AND created_at < report_end GROUP BY 1
    ), candidate_daily AS (
      SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai')::date metric_day, count(*)::int image_candidates,
        count(*) FILTER (WHERE current_decision = 'adopted')::int adopted_candidates
      FROM image_candidates, bounds WHERE created_at >= report_start - interval '7 days' AND created_at < report_end GROUP BY 1
    ), review_daily AS (
      SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai')::date metric_day, count(*)::int reviews,
        count(*) FILTER (WHERE decision = 'adopted')::int adopted_reviews,
        count(*) FILTER (WHERE decision = 'needs_changes')::int change_reviews,
        count(*) FILTER (WHERE decision = 'rejected')::int rejected_reviews
      FROM image_candidate_reviews, bounds WHERE created_at >= report_start - interval '7 days' AND created_at < report_end GROUP BY 1
    ), image_delivery_daily AS (
      SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai')::date metric_day,
        count(*) FILTER (WHERE status IN ('adopted', 'ready'))::int ready_image_deliverables
      FROM image_creation_deliverables, bounds WHERE created_at >= report_start - interval '7 days' AND created_at < report_end GROUP BY 1
    ), campaign_daily AS (
      SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai')::date metric_day, count(*)::int campaigns,
        count(*) FILTER (WHERE stage = 'final_delivery')::int final_stage_campaigns
      FROM campaigns, bounds WHERE created_at >= report_start - interval '7 days' AND created_at < report_end GROUP BY 1
    ), video_delivery_daily AS (
      SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai')::date metric_day,
        count(*) FILTER (WHERE status = 'final')::int final_video_deliverables
      FROM video_deliverables, bounds WHERE created_at >= report_start - interval '7 days' AND created_at < report_end GROUP BY 1
    )
    SELECT (days.day_start AT TIME ZONE 'Asia/Shanghai')::date::text report_day,
      coalesce(image_creations, 0) image_creations, coalesce(completed_image_creations, 0) completed_image_creations,
      coalesce(generation_jobs, 0) generation_jobs, coalesce(completed_jobs, 0) completed_jobs,
      coalesce(failed_jobs, 0) failed_jobs, coalesce(cost_units, 0)::text cost_units,
      coalesce(image_candidates, 0) image_candidates, coalesce(adopted_candidates, 0) adopted_candidates,
      coalesce(reviews, 0) reviews, coalesce(adopted_reviews, 0) adopted_reviews,
      coalesce(change_reviews, 0) change_reviews, coalesce(rejected_reviews, 0) rejected_reviews,
      coalesce(ready_image_deliverables, 0) ready_image_deliverables,
      coalesce(campaigns, 0) campaigns, coalesce(final_stage_campaigns, 0) final_stage_campaigns,
      coalesce(final_video_deliverables, 0) final_video_deliverables
    FROM days
    LEFT JOIN creation_daily ON creation_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN job_daily ON job_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN candidate_daily ON candidate_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN review_daily ON review_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN image_delivery_daily ON image_delivery_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN campaign_daily ON campaign_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN video_delivery_daily ON video_delivery_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    ORDER BY days.day_start
  `)
  const snapshotResult = await client.query<Record<string, number | string | null>>(`
    SELECT
      (SELECT count(*)::int FROM generation_jobs WHERE status IN ('queued', 'submitting', 'processing', 'ingesting') AND created_at < now() - interval '30 minutes') stuck_generation_jobs,
      (SELECT count(*)::int FROM generation_jobs WHERE status = 'failed' AND created_at >= now() - interval '24 hours') failed_jobs_24h,
      (SELECT count(*)::int FROM image_creations WHERE status NOT IN ('completed', 'archived')) open_image_creations,
      (SELECT count(*)::int FROM campaigns WHERE stage <> 'final_delivery') open_video_campaigns,
      (SELECT round(extract(epoch FROM (now() - max(last_seen_at))) / 60)::int FROM generation_worker_heartbeats) worker_heartbeat_age_minutes
  `)
  const { report, previous, baseline } = requireEightDayWindow(dailyResult.rows, 'AI Marketing')
  const compare = (key: string, unit = 'count'): MetricComparison => metricComparison(report, previous, baseline, key, unit)
  return {
    schemaVersion: 1,
    analyticsProfile: 'ai-marketing-production-v1',
    projectId: 'ai-marketing',
    projectName: 'AI Marketing',
    reportDate: report.report_day,
    timezone: 'Asia/Shanghai',
    period: 'previous-complete-calendar-day',
    metrics: {
      imageCreations: compare('image_creations'), completedImageCreations: compare('completed_image_creations'),
      generationJobs: compare('generation_jobs'), completedJobs: compare('completed_jobs'), failedJobs: compare('failed_jobs'),
      costUnits: compare('cost_units', 'count'), imageCandidates: compare('image_candidates'), adoptedCandidates: compare('adopted_candidates'),
      reviews: compare('reviews'), adoptedReviews: compare('adopted_reviews'), changeReviews: compare('change_reviews'),
      rejectedReviews: compare('rejected_reviews'), readyImageDeliverables: compare('ready_image_deliverables'),
      campaigns: compare('campaigns'), finalStageCampaigns: compare('final_stage_campaigns'),
      finalVideoDeliverables: compare('final_video_deliverables')
    },
    snapshot: Object.fromEntries(Object.entries(snapshotResult.rows[0] ?? {}).map(([key, value]) => [key, value === null ? null : Number(value)])),
    dataQuality: [
      'All windows are complete calendar days in Asia/Shanghai.',
      'Daily completion and failure counts use each job or workflow creation day and its current status.',
      'Adoption is measured from explicit candidate decisions and review events, not inferred from asset existence.',
      'Only aggregate workflow data is returned; prompts, image metadata, user identity, and generated assets are not selected.'
    ]
  }
}
