import { setTimeout as sleep } from 'node:timers/promises'
import {
  openBuilderDatabase,
  parseDailyAtUtc,
  msUntilNextDailyAt,
  resolveScheduledSyncMode,
  SyncRunStore,
} from '@airing-cal/v3-builder'
import { exitCode } from '../contracts.ts'
import { backupBuilderCheckpoint } from './portable-checkpoint-backup.ts'
import { runSync } from '../sync/run.ts'

function readSchedulerConfig(env: Record<string, string | undefined>) {
  const sqlitePath = env.AIRINGCAL_BUILDER_SQLITE_PATH?.trim()
  if (!sqlitePath) {
    throw new Error('AIRINGCAL_BUILDER_SQLITE_PATH is required for portable scheduler')
  }
  const dailyAt = parseDailyAtUtc(env.AIRINGCAL_SCHEDULER_DAILY_AT?.trim() || '03:00')
  const fullEveryDays = Number(env.AIRINGCAL_SCHEDULER_FULL_EVERY_DAYS?.trim() || '7')
  const runOnStart = ['1', 'true', 'yes'].includes(
    (env.AIRINGCAL_SCHEDULER_RUN_ON_START ?? '').trim().toLowerCase(),
  )
  return { sqlitePath, dailyAt, fullEveryDays, runOnStart }
}

async function runScheduledSync(env: Record<string, string | undefined>): Promise<void> {
  const { sqlitePath, fullEveryDays } = readSchedulerConfig(env)
  const db = openBuilderDatabase(sqlitePath)
  const runs = new SyncRunStore(db)
  const lastFull = runs.latestSucceededRun('full')
  const nowUnix = Math.floor(Date.now() / 1000)
  const mode = resolveScheduledSyncMode(
    nowUnix,
    fullEveryDays,
    lastFull?.finished_at_unix ?? null,
  )
  const syncEnv = { ...env, AIRINGCAL_BUILDER_MODE: mode }
  console.log(JSON.stringify({
    status: 'info',
    stage: 'portable_scheduler_tick',
    mode,
    last_full_finished_at: lastFull?.finished_at_unix ?? null,
  }))
  if (['1', 'true', 'yes'].includes((env.AIRINGCAL_SCHEDULER_BACKUP_BEFORE_SYNC ?? '').trim().toLowerCase())) {
    const backup = backupBuilderCheckpoint(env)
    console.log(JSON.stringify({ status: 'info', stage: 'checkpoint_backup', ...backup }))
  }
  const summary = await runSync(syncEnv)
  console.log(JSON.stringify(summary))
  if (summary.status === 'failed') {
    process.exitCode = exitCode(summary)
  }
}

export async function runPortableSchedulerLoop(
  env: Record<string, string | undefined> = process.env,
): Promise<never> {
  const { dailyAt, runOnStart } = readSchedulerConfig(env)
  if (runOnStart) {
    await runScheduledSync(env)
  }
  for (;;) {
    const waitMs = msUntilNextDailyAt(new Date(), dailyAt)
    console.log(JSON.stringify({
      status: 'info',
      stage: 'portable_scheduler_sleep',
      wait_ms: waitMs,
      next_at_unix: Math.floor((Date.now() + waitMs) / 1000),
    }))
    await sleep(waitMs)
    await runScheduledSync(env)
  }
}

if (process.argv[1]?.endsWith('portable-scheduler.ts')) {
  runPortableSchedulerLoop().catch((error) => {
    const message = error instanceof Error ? error.message : 'scheduler_failed'
    console.error(JSON.stringify({ status: 'failed', stage: 'portable_scheduler', message }))
    process.exit(1)
  })
}
