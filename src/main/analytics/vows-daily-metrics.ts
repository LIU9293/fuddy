import type { Client } from 'pg'
import { metricComparison, requireEightDayWindow, type MetricComparison, type NumericMetricRow } from './daily-metric-window'

export interface VowsDailyMetrics extends Record<string, unknown> {
  schemaVersion: 1
  analyticsProfile: 'vows-growth-v1'
  projectId: 'vows'
  projectName: 'Vows'
  reportDate: string
  timezone: 'Asia/Shanghai'
  period: 'previous-complete-calendar-day'
  metrics: Record<string, MetricComparison>
  snapshot: Record<string, number | null>
  dataQuality: string[]
}

export async function collectVowsDailyMetrics(client: Client): Promise<VowsDailyMetrics> {
  const dailyResult = await client.query<NumericMetricRow>(`
    WITH bounds AS (
      SELECT
        ((date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') - interval '1 day') AT TIME ZONE 'Asia/Shanghai') AS report_start,
        (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') AS report_end
    ), days AS (
      SELECT generate_series(report_start - interval '7 days', report_start, interval '1 day') AS day_start FROM bounds
    ), user_daily AS (
      SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai')::date metric_day, count(*)::int new_users
      FROM users, bounds WHERE created_at >= report_start - interval '7 days' AND created_at < report_end GROUP BY 1
    ), order_daily AS (
      SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai')::date metric_day, count(*)::int payment_orders
      FROM payment_orders, bounds WHERE created_at >= report_start - interval '7 days' AND created_at < report_end GROUP BY 1
    ), paid_daily AS (
      SELECT date_trunc('day', paid_at AT TIME ZONE 'Asia/Shanghai')::date metric_day,
        count(*)::int paid_orders, coalesce(sum(amount_total), 0)::bigint paid_cents
      FROM payment_orders, bounds
      WHERE status = 'paid' AND paid_at >= report_start - interval '7 days' AND paid_at < report_end GROUP BY 1
    ), wedding_daily AS (
      SELECT date_trunc('day', weddings.created_at AT TIME ZONE 'Asia/Shanghai')::date metric_day,
        count(DISTINCT weddings.id)::int weddings_created,
        count(DISTINCT weddings.id) FILTER (WHERE wedding_events.ready)::int ready_weddings,
        count(DISTINCT weddings.id) FILTER (WHERE wedding_events.published)::int published_weddings,
        count(wedding_events.id) FILTER (WHERE wedding_events.published)::int published_events
      FROM weddings LEFT JOIN wedding_events ON wedding_events.wedding_id = weddings.id, bounds
      WHERE weddings.created_at >= report_start - interval '7 days' AND weddings.created_at < report_end GROUP BY 1
    ), rsvp_daily AS (
      SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai')::date metric_day, count(*)::int rsvps
      FROM rsvps, bounds WHERE created_at >= report_start - interval '7 days' AND created_at < report_end GROUP BY 1
    ), blessing_daily AS (
      SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai')::date metric_day, count(*)::int blessings
      FROM blessings, bounds WHERE created_at >= report_start - interval '7 days' AND created_at < report_end GROUP BY 1
    ), media_daily AS (
      SELECT date_trunc('day', media_assets.created_at AT TIME ZONE 'Asia/Shanghai')::date metric_day, count(*)::int media_assets
      FROM media_assets, bounds WHERE created_at >= report_start - interval '7 days' AND created_at < report_end GROUP BY 1
    )
    SELECT (days.day_start AT TIME ZONE 'Asia/Shanghai')::date::text report_day,
      coalesce(new_users, 0) new_users, coalesce(payment_orders, 0) payment_orders,
      coalesce(paid_orders, 0) paid_orders, coalesce(paid_cents, 0)::text paid_cents,
      coalesce(weddings_created, 0) weddings_created, coalesce(ready_weddings, 0) ready_weddings,
      coalesce(published_weddings, 0) published_weddings, coalesce(published_events, 0) published_events,
      coalesce(rsvps, 0) rsvps, coalesce(blessings, 0) blessings, coalesce(media_assets, 0) media_assets
    FROM days
    LEFT JOIN user_daily ON user_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN order_daily ON order_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN paid_daily ON paid_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN wedding_daily ON wedding_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN rsvp_daily ON rsvp_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN blessing_daily ON blessing_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN media_daily ON media_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    ORDER BY days.day_start
  `)
  const snapshotResult = await client.query<Record<string, number | string | null>>(`
    SELECT
      (SELECT count(*)::int FROM payment_orders WHERE status = 'pending' AND expires_at < now()) expired_pending_orders,
      (SELECT count(*)::int FROM payment_orders WHERE status = 'paid' AND wedding_id IS NULL) paid_without_wedding,
      (SELECT count(*)::int FROM payment_orders WHERE status = 'paid' AND delivery_confirmed_at IS NULL) paid_without_delivery_confirmation,
      (SELECT count(*)::int FROM wedding_events WHERE ready) ready_events,
      (SELECT count(*)::int FROM wedding_events WHERE published) published_events
  `)
  const { report, previous, baseline } = requireEightDayWindow(dailyResult.rows, 'Vows')
  const compare = (key: string, unit = 'count', scale = 1): MetricComparison =>
    metricComparison(report, previous, baseline, key, unit, scale)
  return {
    schemaVersion: 1,
    analyticsProfile: 'vows-growth-v1',
    projectId: 'vows',
    projectName: 'Vows',
    reportDate: report.report_day,
    timezone: 'Asia/Shanghai',
    period: 'previous-complete-calendar-day',
    metrics: {
      newUsers: compare('new_users'), paymentOrders: compare('payment_orders'), paidOrders: compare('paid_orders'),
      paidRevenueCny: compare('paid_cents', 'CNY', 100), weddingsCreated: compare('weddings_created'),
      readyWeddings: compare('ready_weddings'), publishedWeddings: compare('published_weddings'),
      publishedWeddingEvents: compare('published_events'), rsvps: compare('rsvps'), blessings: compare('blessings'),
      mediaAssets: compare('media_assets')
    },
    snapshot: Object.fromEntries(Object.entries(snapshotResult.rows[0] ?? {}).map(([key, value]) => [key, value === null ? null : Number(value)])),
    dataQuality: [
      'All windows are complete calendar days in Asia/Shanghai.',
      'wedding_events has no created_at; ready/published events are attributed to the wedding creation day.',
      'Paid revenue uses payment_orders.paid_at and amount_total for orders whose current status is paid.',
      'Only aggregate counts and amounts are returned; no user, guest, message, media URL, or open-id fields are selected.'
    ]
  }
}
