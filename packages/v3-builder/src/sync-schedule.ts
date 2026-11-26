export interface DailyAtUtc {
  hour: number
  minute: number
}

const DAILY_AT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export function parseDailyAtUtc(value: string): DailyAtUtc {
  const trimmed = value.trim()
  const match = DAILY_AT_RE.exec(trimmed)
  if (!match) {
    throw new Error('AIRINGCAL_SCHEDULER_DAILY_AT must be HH:MM in UTC (00:00–23:59)')
  }
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

export function nextDailyRunUnix(now: Date, dailyAt: DailyAtUtc): number {
  const candidate = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    dailyAt.hour,
    dailyAt.minute,
    0,
    0,
  )
  if (candidate <= now.getTime()) {
    return candidate + 86_400_000
  }
  return candidate
}

export function msUntilNextDailyAt(now: Date, dailyAt: DailyAtUtc): number {
  const next = nextDailyRunUnix(now, dailyAt)
  return Math.max(0, next - now.getTime())
}

export function resolveScheduledSyncMode(
  nowUnix: number,
  fullEveryDays: number,
  lastFullSucceededFinishedAt: number | null,
): 'incremental' | 'full' {
  if (!Number.isFinite(fullEveryDays) || fullEveryDays < 1) {
    throw new Error('AIRINGCAL_SCHEDULER_FULL_EVERY_DAYS must be a positive integer')
  }
  if (lastFullSucceededFinishedAt === null) return 'full'
  const elapsed = nowUnix - lastFullSucceededFinishedAt
  if (elapsed >= fullEveryDays * 86_400) return 'full'
  return 'incremental'
}
