const minuteMs = 60_000

interface CronField {
  values: Set<number>
  wildcard: boolean
}

interface ParsedCron {
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
}

const weekdayNumbers: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
}

function parseNumber(value: string, min: number, max: number, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${label} 包含无效值“${value}”。`)
  const parsed = Number(value)
  if (parsed < min || parsed > max) throw new Error(`${label} 必须在 ${min}–${max} 之间。`)
  return parsed
}

function addRange(target: Set<number>, start: number, end: number, step: number): void {
  if (end < start) throw new Error('Cron 范围的结束值不能小于开始值。')
  for (let value = start; value <= end; value += step) target.add(value)
}

function parseField(source: string, min: number, max: number, label: string, normalize?: (value: number) => number): CronField {
  const values = new Set<number>()
  const wildcard = source === '*'
  for (const segment of source.split(',')) {
    const [rangeSource, stepSource, ...extra] = segment.split('/')
    if (!rangeSource || extra.length > 0) throw new Error(`${label} 格式无效。`)
    const step = stepSource === undefined ? 1 : parseNumber(stepSource, 1, max - min + 1, `${label}步长`)
    if (rangeSource === '*') {
      addRange(values, min, max, step)
      continue
    }
    const range = rangeSource.split('-')
    if (range.length > 2) throw new Error(`${label}范围格式无效。`)
    const start = parseNumber(range[0], min, max, label)
    const end = range.length === 2 ? parseNumber(range[1], min, max, label) : start
    addRange(values, start, end, step)
  }
  const normalized = normalize ? new Set([...values].map(normalize)) : values
  if (normalized.size === 0) throw new Error(`${label}不能为空。`)
  return { values: normalized, wildcard }
}

export function parseCronExpression(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('Cron Expression 必须包含 5 段：分 时 日 月 周。')
  return {
    minute: parseField(fields[0], 0, 59, '分钟'),
    hour: parseField(fields[1], 0, 23, '小时'),
    dayOfMonth: parseField(fields[2], 1, 31, '日期'),
    month: parseField(fields[3], 1, 12, '月份'),
    dayOfWeek: parseField(fields[4], 0, 7, '星期', (value) => value === 7 ? 0 : value)
  }
}

function zonedParts(date: Date, timezone: string): {
  minute: number
  hour: number
  dayOfMonth: number
  month: number
  dayOfWeek: number
} {
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short'
    })
  } catch {
    throw new Error(`无效时区：${timezone}`)
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]))
  const weekday = weekdayNumbers[parts.weekday]
  if (weekday === undefined) throw new Error(`无法解析时区 ${timezone} 的星期。`)
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    dayOfMonth: Number(parts.day),
    month: Number(parts.month),
    dayOfWeek: weekday
  }
}

function matches(parsed: ParsedCron, date: Date, timezone: string): boolean {
  const parts = zonedParts(date, timezone)
  const dayOfMonthMatch = parsed.dayOfMonth.values.has(parts.dayOfMonth)
  const dayOfWeekMatch = parsed.dayOfWeek.values.has(parts.dayOfWeek)
  const dayMatches = parsed.dayOfMonth.wildcard
    ? dayOfWeekMatch
    : parsed.dayOfWeek.wildcard
      ? dayOfMonthMatch
      : dayOfMonthMatch || dayOfWeekMatch
  return parsed.minute.values.has(parts.minute) &&
    parsed.hour.values.has(parts.hour) &&
    parsed.month.values.has(parts.month) &&
    dayMatches
}

export function nextCronOccurrence(expression: string, timezone: string, after: Date): Date {
  const parsed = parseCronExpression(expression)
  // Validate the timezone before entering the search loop.
  zonedParts(after, timezone)
  const start = Math.floor(after.getTime() / minuteMs) * minuteMs + minuteMs
  const searchLimit = 366 * 5 * 24 * 60
  for (let offset = 0; offset < searchLimit; offset += 1) {
    const candidate = new Date(start + offset * minuteMs)
    if (matches(parsed, candidate, timezone)) return candidate
  }
  throw new Error('未来五年内找不到符合该 Cron Expression 的运行时间。')
}
