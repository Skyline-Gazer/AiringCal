import {
  msUntilNextDailyAt,
  nextDailyRunUnix,
  openBuilderDatabase,
  parseDailyAtUtc,
  SyncRunStore,
} from '@airing-cal/v3-builder'

export interface PortableCronStatus {
  scheduler: 'compose-scheduler' | 'external'
  next_at: string | null
  last: { status: string; source: string; completed_at: number; mode?: string } | null
}

export function readPortableCronStatus(env: Record<string, string | undefined>): PortableCronStatus {
  const sqlitePath = env.AIRINGCAL_BUILDER_SQLITE_PATH?.trim()
  if (!sqlitePath) {
    return { scheduler: 'external', next_at: null, last: null }
  }
  const dailyAt = parseDailyAtUtc(env.AIRINGCAL_SCHEDULER_DAILY_AT?.trim() || '03:00')
  const nextUnix = Math.floor(nextDailyRunUnix(new Date(), dailyAt) / 1000)
  const db = openBuilderDatabase(sqlitePath)
  try {
    const latest = new SyncRunStore(db).latestRun()
    const last = latest?.finished_at_unix
      ? {
          status: latest.status,
          source: 'compose-scheduler',
          completed_at: latest.finished_at_unix,
          mode: latest.mode,
        }
      : null
    return {
      scheduler: 'compose-scheduler',
      next_at: new Date(nextUnix * 1000).toISOString(),
      last,
    }
  } finally {
    db.close()
  }
}

export { msUntilNextDailyAt }
