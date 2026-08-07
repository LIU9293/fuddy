export interface MetricComparison {
  value: number
  unit: string
  previousValue: number
  sevenDayAverage: number
  vsPreviousPct: number | null
  vsSevenDayAveragePct: number | null
}

export type NumericMetricRow = { report_day: string } & Record<string, number | string>

function percent(value: number, baseline: number): number | null {
  if (!baseline) return null
  return Math.round(((value - baseline) / baseline) * 1_000) / 10
}

export function normalizeMetricRows(rows: NumericMetricRow[]): NumericMetricRow[] {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, key === 'report_day' ? String(value) : Number(value)])
  ) as NumericMetricRow)
}

export function metricComparison(
  report: NumericMetricRow,
  previous: NumericMetricRow,
  baselineRows: NumericMetricRow[],
  key: string,
  unit = 'count',
  scale = 1
): MetricComparison {
  const value = Number(report[key])
  const previousValue = Number(previous[key])
  const baseline = baselineRows.reduce((total, row) => total + Number(row[key]), 0) / baselineRows.length
  return {
    value: Math.round((value / scale) * 100) / 100,
    unit,
    previousValue: Math.round((previousValue / scale) * 100) / 100,
    sevenDayAverage: Math.round((baseline / scale) * 100) / 100,
    vsPreviousPct: percent(value, previousValue),
    vsSevenDayAveragePct: percent(value, baseline)
  }
}

export function requireEightDayWindow(rows: NumericMetricRow[], label: string): {
  report: NumericMetricRow
  previous: NumericMetricRow
  baseline: NumericMetricRow[]
} {
  const normalized = normalizeMetricRows(rows)
  const report = normalized.at(-1)
  const previous = normalized.at(-2)
  const baseline = normalized.slice(0, -1)
  if (!report || !previous || baseline.length !== 7) {
    throw new Error(`${label} 日报查询没有返回完整的 8 天窗口。`)
  }
  return { report, previous, baseline }
}
