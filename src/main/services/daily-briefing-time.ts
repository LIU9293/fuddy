const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000

function shanghaiDateParts(now: Date): { year: number; month: number; day: number } {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate()
  }
}

function isoDateFromUtc(value: number): string {
  return new Date(value).toISOString().slice(0, 10)
}

export function previousCompleteShanghaiDate(now = new Date()): string {
  const { year, month, day } = shanghaiDateParts(now)
  return isoDateFromUtc(Date.UTC(year, month, day) - 24 * 60 * 60 * 1_000)
}

export function millisecondsUntilNextShanghaiRun(now = new Date(), hour = 9): number {
  const { year, month, day } = shanghaiDateParts(now)
  let next = Date.UTC(year, month, day, hour - 8)
  if (next <= now.getTime()) next += 24 * 60 * 60 * 1_000
  return next - now.getTime()
}
