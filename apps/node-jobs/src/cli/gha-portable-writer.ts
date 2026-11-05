import { randomUUID } from 'node:crypto'
import { openBuilderDatabase, resolveScheduledSyncMode, SyncRunStore } from '@airing-cal/v3-builder'
import type { ConditionalObjectStore } from '../adapters/object-store.ts'
import {
  DEFAULT_CHECKPOINT_OBJECT_KEY,
  acquireCheckpointLease,
  releaseCheckpointLease,
  renewCheckpointLease,
  restoreCheckpointToFile,
  uploadCheckpointFromFile,
} from '../adapters/s3-checkpoint-store.ts'
import type { JobSummary } from '../contracts.ts'
import { notifyBarkFailure } from '../notify/bark.ts'
import type { PortableBuilderSyncOverrides } from '../sync/run-portable.ts'
import { runSync } from '../sync/run.ts'

/** ADR 0003 GHA one-shot writer mode resolution. */
export function resolveWriterSyncMode(
  nowUnix: number,
  fullEveryDays: number,
  lastFullSucceededFinishedAt: number | null,
): 'incremental' | 'full' {
  return resolveScheduledSyncMode(nowUnix, fullEveryDays, lastFullSucceededFinishedAt)
}

export interface GhaPortableWriterDeps {
  env: Record<string, string | undefined>
  nowUnix?: number
  checkpointStore: ConditionalObjectStore
  runSync?: (
    env: Record<string, string | undefined>,
    overrides?: PortableBuilderSyncOverrides,
  ) => Promise<JobSummary>
  notifyFailure?: (
    env: Record<string, string | undefined>,
    payload: { title: string; body: string },
  ) => Promise<void>
  leaseTtlSeconds?: number
}

export interface GhaPortableWriterResult {
  status: 'success' | 'failed' | 'skipped'
  mode: 'incremental' | 'full' | null
  message: string
  summary?: JobSummary
}

function readSqlitePath(env: Record<string, string | undefined>): string {
  const sqlitePath = env.AIRINGCAL_BUILDER_SQLITE_PATH?.trim()
  if (!sqlitePath) {
    throw new Error('AIRINGCAL_BUILDER_SQLITE_PATH is required for GHA portable writer')
  }
  return sqlitePath
}

function readFullEveryDays(env: Record<string, string | undefined>): number {
  const raw = env.AIRINGCAL_FULL_EVERY_DAYS?.trim() || env.AIRINGCAL_SCHEDULER_FULL_EVERY_DAYS?.trim() || '7'
  const days = Number(raw)
  if (!Number.isFinite(days) || days < 1) {
    throw new Error('AIRINGCAL_FULL_EVERY_DAYS must be a positive integer')
  }
  return days
}

async function safeNotify(
  notify: GhaPortableWriterDeps['notifyFailure'],
  env: Record<string, string | undefined>,
  message: string,
): Promise<void> {
  if (!notify) return
  try {
    await notify(env, { title: 'AiringCal writer failed', body: message })
  } catch (error) {
    console.warn(
      JSON.stringify({
        status: 'info',
        stage: 'bark_notify_failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

export async function runGhaPortableWriter(deps: GhaPortableWriterDeps): Promise<GhaPortableWriterResult> {
  const env = deps.env
  const nowUnix = deps.nowUnix ?? Math.floor(Date.now() / 1000)
  const runSyncImpl = deps.runSync ?? runSync
  const notifyFailure = deps.notifyFailure ?? notifyBarkFailure
  const leaseTtlSeconds = deps.leaseTtlSeconds ?? 2_700
  const ownerToken = env.AIRINGCAL_BUILDER_OWNER?.trim() || `gha-${randomUUID().slice(0, 8)}`

  let sqlitePath: string
  let fullEveryDays: number
  try {
    sqlitePath = readSqlitePath(env)
    fullEveryDays = readFullEveryDays(env)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CONFIG_INVALID'
    await safeNotify(notifyFailure, env, message)
    return { status: 'failed', mode: null, message }
  }

  const lease = await acquireCheckpointLease(deps.checkpointStore, {
    ownerToken,
    nowUnix,
    ttlSeconds: leaseTtlSeconds,
  })
  if (lease.status === 'held') {
    const message = `checkpoint lease held by ${lease.holder} until ${lease.expires_at_unix}`
    await safeNotify(notifyFailure, env, message)
    return { status: 'failed', mode: null, message }
  }

  let mode: 'incremental' | 'full' = 'full'
  try {
    const restored = await restoreCheckpointToFile(deps.checkpointStore, sqlitePath)
    console.log(JSON.stringify({ status: 'info', stage: 'checkpoint_restore', result: restored }))
    const priorCheckpointEtag = restored.status === 'restored' ? restored.etag : null
    let checkpointUploaded = false

    const uploadCheckpoint = async (): Promise<void> => {
      const uploaded = await uploadCheckpointFromFile(
        deps.checkpointStore,
        sqlitePath,
        undefined,
        { priorEtag: priorCheckpointEtag },
      )
      if (uploaded.status !== 'uploaded') {
        throw new Error('checkpoint CAS precondition failed; aborting before release commit')
      }
      checkpointUploaded = true
      console.log(JSON.stringify({ status: 'info', stage: 'checkpoint_upload', result: uploaded }))
    }

    // C4: preCommit runs inside the publish path immediately before the release pointer
    // commit — checkpoint CAS upload first, then lease renew; failure aborts the commit.
    const publishPreCommit = async (): Promise<void> => {
      await uploadCheckpoint()
      const renewUnix = deps.nowUnix ?? Math.floor(Date.now() / 1000)
      const renewed = await renewCheckpointLease(deps.checkpointStore, {
        ownerToken,
        nowUnix: renewUnix,
        ttlSeconds: leaseTtlSeconds,
      })
      if (renewed.status === 'lost') {
        throw new Error('checkpoint lease lost before release commit; aborting publish')
      }
      console.log(JSON.stringify({ status: 'info', stage: 'checkpoint_lease_renew', result: renewed }))
    }

    const forced = env.AIRINGCAL_BUILDER_MODE?.trim().toLowerCase()
    if (forced === 'full' || forced === 'incremental') {
      mode = forced
    } else {
      const db = openBuilderDatabase(sqlitePath)
      try {
        const runs = new SyncRunStore(db)
        const lastFull = runs.latestSucceededRun('full')
        mode = resolveWriterSyncMode(nowUnix, fullEveryDays, lastFull?.finished_at_unix ?? null)
      } finally {
        db.close()
      }
    }

    const syncEnv: Record<string, string | undefined> = {
      ...env,
      AIRINGCAL_BUILDER: 'portable',
      AIRINGCAL_BUILDER_MODE: mode,
      AIRINGCAL_BUILDER_OWNER: ownerToken,
    }
    console.log(JSON.stringify({
      status: 'info',
      stage: 'gha_portable_writer_tick',
      mode,
      full_every_days: fullEveryDays,
    }))

    const summary = await runSyncImpl(syncEnv, { publishPreCommit })
    if (summary.status === 'failed') {
      await safeNotify(notifyFailure, env, summary.message)
      return { status: 'failed', mode, message: summary.message, summary }
    }

    // No pointer commit happened (skipped / no-change / already current): still persist
    // run-history and any SQLite drift with the same CAS discipline.
    if (!checkpointUploaded) {
      await uploadCheckpoint()
    }

    return {
      status: summary.status === 'skipped' ? 'skipped' : 'success',
      mode,
      message: summary.message,
      summary,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await safeNotify(notifyFailure, env, message)
    return { status: 'failed', mode, message }
  } finally {
    await releaseCheckpointLease(deps.checkpointStore, ownerToken)
  }
}
