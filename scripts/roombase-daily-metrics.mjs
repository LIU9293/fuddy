import { readFileSync } from 'node:fs'
import pg from 'pg'

function readArgument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL

  const envFile = readArgument('--env-file')
  if (!envFile) throw new Error('Provide DATABASE_URL or --env-file <path>.')
  const text = readFileSync(envFile, 'utf8')
  const line = text.split(/\r?\n/).find((item) => item.startsWith('DATABASE_URL='))
  if (!line) throw new Error('The env file does not contain DATABASE_URL.')
  return line.slice('DATABASE_URL='.length).trim().replace(/^['"]|['"]$/g, '')
}

function percent(value, baseline) {
  if (!baseline) return null
  return Math.round(((value - baseline) / baseline) * 1000) / 10
}

function average(rows, key) {
  return rows.reduce((total, row) => total + row[key], 0) / rows.length
}

function comparison(report, previous, baselineRows, key, unit = 'count', scale = 1) {
  const baseline = average(baselineRows, key)
  return {
    value: Math.round((report[key] / scale) * 100) / 100,
    unit,
    previousValue: Math.round((previous[key] / scale) * 100) / 100,
    sevenDayAverage: Math.round((baseline / scale) * 100) / 100,
    vsPreviousPct: percent(report[key], previous[key]),
    vsSevenDayAveragePct: percent(report[key], baseline)
  }
}

const client = new pg.Client({
  connectionString: databaseUrl(),
  application_name: 'project-agent-roombase-daily-v0',
  connectionTimeoutMillis: 8_000,
  query_timeout: 20_000,
  statement_timeout: 20_000
})

try {
  await client.connect()
  await client.query('BEGIN TRANSACTION READ ONLY')

  const dailyResult = await client.query(`
    WITH bounds AS (
      SELECT
        ((date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') - interval '1 day') AT TIME ZONE 'Asia/Shanghai') AS report_start,
        (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') AS report_end
    ), days AS (
      SELECT generate_series(report_start - interval '7 days', report_start, interval '1 day') AS day_start
      FROM bounds
    ), user_daily AS (
      SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai')::date AS metric_day,
        count(*)::int AS new_users
      FROM users, bounds
      WHERE created_at >= report_start - interval '7 days' AND created_at < report_end
      GROUP BY 1
    ), activation_daily AS (
      SELECT date_trunc('day', first_booking_at AT TIME ZONE 'Asia/Shanghai')::date AS metric_day,
        count(DISTINCT user_id)::int AS first_booking_users
      FROM store_user_activity, bounds
      WHERE first_booking_at >= report_start - interval '7 days' AND first_booking_at < report_end
      GROUP BY 1
    ), booking_daily AS (
      SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai')::date AS metric_day,
        count(*)::int AS bookings,
        count(DISTINCT user_id) FILTER (WHERE status IN ('active', 'completed', 'scheduled'))::int AS booking_users,
        count(*) FILTER (WHERE status = 'completed')::int AS completed_bookings,
        count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_bookings,
        count(*) FILTER (WHERE status = 'failed')::int AS failed_bookings
      FROM bookings, bounds
      WHERE created_at >= report_start - interval '7 days' AND created_at < report_end
      GROUP BY 1
    ), payment_daily AS (
      SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai')::date AS metric_day,
        count(*)::int AS payment_records,
        count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded_payments,
        count(*) FILTER (WHERE status = 'failed')::int AS failed_payments,
        count(*) FILTER (WHERE status = 'pending')::int AS pending_payments,
        coalesce(sum(amount_paid - amount_refunded), 0)::bigint AS net_paid_cents,
        count(DISTINCT user_id) FILTER (WHERE status = 'succeeded')::int AS paying_users
      FROM payments, bounds
      WHERE created_at >= report_start - interval '7 days' AND created_at < report_end
      GROUP BY 1
    ), account_daily AS (
      SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai')::date AS metric_day,
        count(*)::int AS new_accounts
      FROM accounts, bounds
      WHERE created_at >= report_start - interval '7 days' AND created_at < report_end
      GROUP BY 1
    ), store_daily AS (
      SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai')::date AS metric_day,
        count(*)::int AS new_stores
      FROM stores, bounds
      WHERE created_at >= report_start - interval '7 days' AND created_at < report_end
      GROUP BY 1
    ), subscription_daily AS (
      SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai')::date AS metric_day,
        count(*)::int AS new_subscriptions
      FROM store_plan_subscriptions, bounds
      WHERE created_at >= report_start - interval '7 days' AND created_at < report_end
      GROUP BY 1
    )
    SELECT (days.day_start AT TIME ZONE 'Asia/Shanghai')::date::text AS report_day,
      coalesce(user_daily.new_users, 0) AS new_users,
      coalesce(activation_daily.first_booking_users, 0) AS first_booking_users,
      coalesce(booking_daily.booking_users, 0) AS booking_users,
      coalesce(booking_daily.bookings, 0) AS bookings,
      coalesce(booking_daily.completed_bookings, 0) AS completed_bookings,
      coalesce(booking_daily.cancelled_bookings, 0) AS cancelled_bookings,
      coalesce(booking_daily.failed_bookings, 0) AS failed_bookings,
      coalesce(payment_daily.payment_records, 0) AS payment_records,
      coalesce(payment_daily.succeeded_payments, 0) AS succeeded_payments,
      coalesce(payment_daily.failed_payments, 0) AS failed_payments,
      coalesce(payment_daily.pending_payments, 0) AS pending_payments,
      coalesce(payment_daily.net_paid_cents, 0)::text AS net_paid_cents,
      coalesce(payment_daily.paying_users, 0) AS paying_users,
      coalesce(account_daily.new_accounts, 0) AS new_accounts,
      coalesce(store_daily.new_stores, 0) AS new_stores,
      coalesce(subscription_daily.new_subscriptions, 0) AS new_subscriptions
    FROM days
    LEFT JOIN user_daily ON user_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN activation_daily ON activation_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN booking_daily ON booking_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN payment_daily ON payment_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN account_daily ON account_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN store_daily ON store_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    LEFT JOIN subscription_daily ON subscription_daily.metric_day = (days.day_start AT TIME ZONE 'Asia/Shanghai')::date
    ORDER BY days.day_start
  `)

  const snapshotResult = await client.query(`
    SELECT
      (SELECT count(*)::int FROM accounts WHERE status = 'active') AS active_accounts,
      (SELECT count(*)::int FROM stores WHERE status = 'active') AS active_stores,
      (SELECT count(*)::int FROM store_plan_subscriptions WHERE status = 'active') AS active_subscriptions,
      (SELECT count(*)::int FROM mini_program_onboardings WHERE status NOT IN ('completed', 'cancelled')) AS open_onboardings,
      (SELECT count(*)::int FROM mini_program_onboardings WHERE status = 'waiting_platform') AS waiting_platform_onboardings,
      (SELECT count(*)::int FROM mini_program_onboardings WHERE status = 'waiting_merchant') AS waiting_merchant_onboardings,
      (SELECT count(*)::int FROM mini_program_onboardings WHERE blocked_reason_code IS NOT NULL) AS blocked_onboardings,
      (SELECT round(max(extract(epoch FROM (now() - coalesce(last_active_at, created_at))) / 86400)::numeric, 1)::text
        FROM mini_program_onboardings WHERE status = 'waiting_platform') AS oldest_waiting_platform_days
  `)

  const rows = dailyResult.rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, key === 'report_day' ? value : Number(value)])
    )
  )
  const report = rows.at(-1)
  const previous = rows.at(-2)
  const baselineRows = rows.slice(0, -1)
  const cancellationRate = (row) => row.bookings ? (row.cancelled_bookings / row.bookings) * 100 : 0
  const paymentSuccessShare = (row) => row.payment_records ? (row.succeeded_payments / row.payment_records) * 100 : 0

  const output = {
    schemaVersion: 1,
    projectId: 'roombase',
    projectName: 'Roombase',
    reportDate: report.report_day,
    timezone: 'Asia/Shanghai',
    period: 'previous-complete-calendar-day',
    metrics: {
      newUsers: comparison(report, previous, baselineRows, 'new_users'),
      firstBookingUsers: comparison(report, previous, baselineRows, 'first_booking_users'),
      bookingUsers: comparison(report, previous, baselineRows, 'booking_users'),
      bookings: comparison(report, previous, baselineRows, 'bookings'),
      succeededPayments: comparison(report, previous, baselineRows, 'succeeded_payments'),
      payingUsers: comparison(report, previous, baselineRows, 'paying_users'),
      netPaidCny: comparison(report, previous, baselineRows, 'net_paid_cents', 'CNY', 100),
      bookingCancellationRate: {
        value: Math.round(cancellationRate(report) * 100) / 100,
        unit: 'percent',
        previousValue: Math.round(cancellationRate(previous) * 100) / 100
      },
      paymentSuccessShare: {
        value: Math.round(paymentSuccessShare(report) * 100) / 100,
        unit: 'percent',
        previousValue: Math.round(paymentSuccessShare(previous) * 100) / 100
      },
      failedBookings: comparison(report, previous, baselineRows, 'failed_bookings'),
      failedPayments: comparison(report, previous, baselineRows, 'failed_payments'),
      pendingPayments: comparison(report, previous, baselineRows, 'pending_payments'),
      newAccounts: comparison(report, previous, baselineRows, 'new_accounts'),
      newStores: comparison(report, previous, baselineRows, 'new_stores'),
      newSubscriptions: comparison(report, previous, baselineRows, 'new_subscriptions')
    },
    snapshot: Object.fromEntries(
      Object.entries(snapshotResult.rows[0]).map(([key, value]) => [key, value === null ? null : Number(value)])
    ),
    dataQuality: [
      'All windows are complete calendar days in Asia/Shanghai.',
      'firstBookingUsers is not a same-day registration conversion cohort.',
      'Booking metrics use bookings.created_at and the current status at query time.',
      'netPaidCny uses amount_paid minus amount_refunded because amount_net_received is not populated.',
      'Only aggregate counts and amounts are returned; no user-level rows are selected.'
    ]
  }

  console.log(JSON.stringify(output, null, 2))
  await client.query('ROLLBACK')
} finally {
  await client.end().catch(() => undefined)
}
