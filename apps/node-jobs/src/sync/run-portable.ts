import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CompleteFullFetch } from '@airing-cal/bgm-api'
import { FilesystemPublicStore, MemoryPublicStore, type PublicStore } from '@airing-cal/v3-core'
import {
  openBuilderDatabase,
  runBuilderOnce,
  SqliteBuilderStateStore,
  SyncRunStore,
  type SyncRunMode,
} from '@airing-cal/v3-builder'
import type { JobSummary } from '../contracts.ts'
import { createUpstreamBgmClient, fetchCompleteInput } from '../upstream/fetch.ts'
import { readSyncUserConfig } from './config.ts'

function createPortablePublicStore(env: Record<string, string | undefined>): PublicStore {
  const publicDir = env.AIRINGCAL_BUILDER_PUBLIC_DIR?.trim()
  if (publicDir) {
    mkdirSync(publicDir, { recursive: true })
    return new FilesystemPublicStore(publicDir)
  }
  return new MemoryPublicStore()
}

function readPortableBuilderConfig(env: Record<string, string | undefined>): {
  sqlitePath: string
  mode: SyncRunMode
  publishAfterSync: boolean
} {
  const sqlitePath = env.AIRINGCAL_BUILDER_SQLITE_PATH?.trim()
  if (!sqlitePath) {
    throw new Error('AIRINGCAL_BUILDER_SQLITE_PATH is required when AIRINGCAL_BUILDER=portable')
  }
  const modeRaw = env.AIRINGCAL_BUILDER_MODE?.trim().toLowerCase() ?? 'incremental'
  const mode: SyncRunMode = modeRaw === 'full' ? 'full' : 'incremental'
  const publishAfterSync = ['1', 'true', 'yes'].includes(
    (env.AIRINGCAL_BUILDER_PUBLISH ?? '').trim().toLowerCase(),
  )
  return { sqlitePath, mode, publishAfterSync }
}

export interface PortableBuilderSyncOverrides {
  fetchInput?: () => Promise<CompleteFullFetch>
}

/** Portable v3 builder path: SQLite checkpoint via @airing-cal/v3-builder (no Cloudflare D1/R2). */
export async function runPortableBuilderSync(
  env: Record<string, string | undefined> = process.env,
  overrides: PortableBuilderSyncOverrides = {},
): Promise<JobSummary> {
  if (!env.AIRINGCAL_USERS_JSON?.trim()) {
    return {
      job: 'airingcal-sync',
      status: 'skipped',
      message: 'AIRINGCAL_USERS_JSON not configured',
    }
  }

  let syncConfig
  let builderConfig
  try {
    syncConfig = readSyncUserConfig(env)
    builderConfig = readPortableBuilderConfig(env)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CONFIG_INVALID'
    return { job: 'airingcal-sync', status: 'failed', message }
  }

  mkdirSync(dirname(builderConfig.sqlitePath), { recursive: true })
  const db = openBuilderDatabase(builderConfig.sqlitePath)
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  const publicStore = createPortablePublicStore(env)
  const runId = randomUUID()
  const ownerToken = env.AIRINGCAL_BUILDER_OWNER?.trim() || `node-jobs-${runId.slice(0, 8)}`

  const client = env.BGM_TOKEN?.trim() ? createUpstreamBgmClient(env.BGM_TOKEN.trim()) : null
  const fetchInput =
    overrides.fetchInput
    ?? (client
      ? () => fetchCompleteInput(
        { users: syncConfig.users, primaryUserId: syncConfig.primaryUserId },
        client,
        () => Date.now(),
      )
      : undefined)

  if (!fetchInput) {
    return {
      job: 'airingcal-sync',
      status: 'failed',
      message: 'BGM_TOKEN required for portable builder fetch (or inject fetchInput in tests)',
    }
  }

  try {
    const result = await runBuilderOnce({
      state,
      runs,
      publicStore,
      runId,
      mode: builderConfig.mode,
      ownerToken,
      fetchInput,
      now: () => Date.now(),
      publishAfterSync: builderConfig.publishAfterSync,
      manifestMetadata: {
        source_observed_at: new Date().toISOString(),
        git_sha: syncConfig.gitSha,
      },
    })

    const sync = result.sync.status
    const publishStatus = result.publish?.status ?? 'skipped'
    const publishFailed =
      result.publish != null
      && result.publish.status !== 'published'
      && result.publish.status !== 'already_current'
    const failed = sync === 'failed' || publishFailed
    const skipped = sync === 'skipped'
    return {
      job: 'airingcal-sync',
      status: failed ? 'failed' : skipped ? 'skipped' : 'success',
      message: `portable builder sync=${sync} publish=${publishStatus} generation=${result.sync.generation ?? 'null'}`,
    }
  } finally {
    db.close()
  }
}
