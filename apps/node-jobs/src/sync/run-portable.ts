import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CompleteFullFetch } from '@airing-cal/bgm-api'
import { subjectDetailImages } from '@airing-cal/domain'
import {
  openBuilderDatabase,
  runBuilderOnce,
  SqliteBuilderStateStore,
  SyncRunStore,
  type PublishCommitContext,
  type SyncRunMode,
} from '@airing-cal/v3-builder'
import { createFilesystemBlobStore } from '../adapters/filesystem-blob-store.ts'
import { readPublicS3Config } from '../adapters/s3-env.ts'
import { createRunContext } from '../adapters/run-context.ts'
import type { JobSummary } from '../contracts.ts'
import { createUpstreamBgmClient, fetchCompleteInput } from '../upstream/fetch.ts'
import { readSyncUserConfig } from './config.ts'
import { mediaSubjectsFromFetch } from './media-refresh.ts'
import { createEnrichMediaSubjectsFromFetch } from './media-subject-resolve.ts'
import { runPortableMediaRefresh } from './portable-media.ts'
import { ensurePublishImagesComplete } from './publish-image-gate.ts'
import { createPortablePublicStoreFromEnv, type ClosablePublicStore } from './portable-public-store.ts'
import { materializePortableThumbs } from './portable-thumb.ts'
import { logPublicSnapshotGcDryRun } from '../cli/portable-public-gc.ts'

function shouldLogGcDryRunAfterPublish(env: Record<string, string | undefined>): boolean {
  return ['1', 'true', 'yes'].includes((env.AIRINGCAL_GC_LOG_AFTER_PUBLISH ?? '').trim().toLowerCase())
}

export type PortableMediaRefreshMode = 'skip' | 'refresh'

export function readPortableMediaRefresh(env: Record<string, string | undefined>): PortableMediaRefreshMode {
  const raw = env.AIRINGCAL_BUILDER_MEDIA_REFRESH?.trim().toLowerCase() ?? 'skip'
  if (raw === 'refresh') return 'refresh'
  if (raw === 'skip') return 'skip'
  throw new Error('AIRINGCAL_BUILDER_MEDIA_REFRESH must be skip or refresh')
}

export function readPortableThumbsEnabled(env: Record<string, string | undefined>, mediaMode: PortableMediaRefreshMode): boolean {
  if (mediaMode !== 'refresh') return false
  const raw = env.AIRINGCAL_BUILDER_THUMBS?.trim().toLowerCase() ?? 'true'
  return !['0', 'false', 'no'].includes(raw)
}

export function readPortableImageRoot(env: Record<string, string | undefined>, mediaMode: PortableMediaRefreshMode): string {
  const publicDir = env.AIRINGCAL_BUILDER_PUBLIC_DIR?.trim()
  const imageDir = env.AIRINGCAL_BUILDER_IMAGE_DIR?.trim()
  const root = publicDir || imageDir
  if (mediaMode === 'refresh' && !root) {
    throw new Error('AIRINGCAL_BUILDER_PUBLIC_DIR or AIRINGCAL_BUILDER_IMAGE_DIR is required when AIRINGCAL_BUILDER_MEDIA_REFRESH=refresh')
  }
  return root!
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
  fetchImage?: (url: string, signal: AbortSignal) => Promise<Response>
  /** Test/injection seam: replaces the env-derived public store (caller owns closing it). */
  publicStore?: ClosablePublicStore
  /** C4 deferred publish hook: runs right before the release pointer commit. */
  publishPreCommit?: (context?: PublishCommitContext) => Promise<void>
}

/** Portable v3 builder path: SQLite checkpoint via @airing-cal/v3-builder (no Cloudflare D1/R2). */
export async function runPortableBuilderSync(
  env: Record<string, string | undefined> = process.env,
  overrides: PortableBuilderSyncOverrides = {},
): Promise<JobSummary> {
  const publishRequested = ['1', 'true', 'yes'].includes(
    (env.AIRINGCAL_BUILDER_PUBLISH ?? '').trim().toLowerCase(),
  )
  if (!env.AIRINGCAL_USERS_JSON?.trim()) {
    if (publishRequested) {
      // C3: a publish run must never succeed as `skipped` on missing config.
      return {
        job: 'airingcal-sync',
        status: 'failed',
        message: 'AIRINGCAL_USERS_JSON is required when AIRINGCAL_BUILDER_PUBLISH=true',
      }
    }
    return {
      job: 'airingcal-sync',
      status: 'skipped',
      message: 'AIRINGCAL_USERS_JSON not configured',
    }
  }

  let syncConfig
  let builderConfig
  let mediaMode: PortableMediaRefreshMode
  try {
    syncConfig = readSyncUserConfig(env)
    builderConfig = readPortableBuilderConfig(env)
    mediaMode = readPortableMediaRefresh(env)
    if (mediaMode === 'refresh') {
      readPortableImageRoot(env, mediaMode)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CONFIG_INVALID'
    return { job: 'airingcal-sync', status: 'failed', message }
  }

  if (
    builderConfig.publishAfterSync
    && overrides.publicStore == null
    && !readPublicS3Config(env)
    && !env.AIRINGCAL_BUILDER_PUBLIC_DIR?.trim()
  ) {
    // C3: no Memory fallback for publish runs — fail closed on missing public store config.
    return {
      job: 'airingcal-sync',
      status: 'failed',
      message:
        'AIRINGCAL_PUBLIC_S3_* or AIRINGCAL_BUILDER_PUBLIC_DIR is required when AIRINGCAL_BUILDER_PUBLISH=true',
    }
  }

  mkdirSync(dirname(builderConfig.sqlitePath), { recursive: true })
  const db = openBuilderDatabase(builderConfig.sqlitePath)
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  const publicStore = overrides.publicStore ?? createPortablePublicStoreFromEnv(env)
  const ownsPublicStore = overrides.publicStore == null
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
    db.close()
    if (ownsPublicStore) publicStore.close?.()
    return {
      job: 'airingcal-sync',
      status: 'failed',
      message: 'BGM_TOKEN required for portable builder fetch (or inject fetchInput in tests)',
    }
  }

  let cachedInput: CompleteFullFetch | null = null
  const loadInput = async () => {
    if (!cachedInput) cachedInput = await fetchInput()
    return cachedInput
  }

  let mediaSummary = ''
  let snapshotProjection: Parameters<typeof runBuilderOnce>[0]['snapshotProjection']
  const publishGateRoot = readPortableImageRoot(env, mediaMode)

  try {
    if (mediaMode === 'refresh') {
      const imageRoot = readPortableImageRoot(env, mediaMode)
      mkdirSync(imageRoot, { recursive: true })
      const input = await loadInput()
      const run = createRunContext({
        runId,
        deadlineAt: Date.now() + 1_500_000,
      })
      const resolveMediaSubjects = client
        ? createEnrichMediaSubjectsFromFetch(async (subjectId) => {
          const subject = await client.getSubject(subjectId)
          return subject ? subjectDetailImages(subject) : null
        })
        : async (fetch: CompleteFullFetch) => mediaSubjectsFromFetch(fetch)
      const subjects = await resolveMediaSubjects(input, run)
      const mediaResult = await runPortableMediaRefresh({
        db,
        imageRoot,
        run,
        input,
        subjects,
        fetchImage: overrides.fetchImage,
      })
      snapshotProjection = {
        imageMap: mediaResult.imageMap,
        mediaHints: mediaResult.mediaHints,
      }
      const failIds = mediaResult.summary.failures.map((entry) => entry.subject_id).join(',')
      mediaSummary = `media=refresh selected=${mediaResult.summary.selected} succeeded=${mediaResult.summary.succeeded} failed=${mediaResult.summary.failed}${failIds ? ` failed_subject_ids=${failIds}` : ''}`
      console.log(mediaSummary)
      if (readPortableThumbsEnabled(env, mediaMode) && mediaResult.summary.large_hashes_persisted.length > 0) {
        const thumbStore = createFilesystemBlobStore(imageRoot)
        try {
          const thumbSummary = await materializePortableThumbs(
            mediaResult.summary.large_hashes_persisted,
            thumbStore,
          )
          console.log(JSON.stringify({ status: 'info', stage: 'thumb', ...thumbSummary }))
          mediaSummary += ` thumbs_generated=${thumbSummary.generated}`
        } finally {
          thumbStore.close()
        }
      }
    }

    const result = await runBuilderOnce({
      state,
      runs,
      publicStore,
      runId,
      mode: builderConfig.mode,
      ownerToken,
      fetchInput: loadInput,
      now: () => Date.now(),
      publishAfterSync: builderConfig.publishAfterSync,
      manifestMetadata: {
        source_observed_at: new Date().toISOString(),
        git_sha: syncConfig.gitSha,
      },
      projectFetchMediaHints: mediaMode === 'skip',
      snapshotProjection,
      prePublish: builderConfig.publishAfterSync
        ? async (snapshot) => {
          const gate = await ensurePublishImagesComplete({
            snapshot,
            publicStore,
            imageRoot: publishGateRoot ?? null,
          })
          console.log(JSON.stringify({ status: 'info', stage: 'publish_image_gate', ...gate }))
        }
        : undefined,
      preCommit: overrides.publishPreCommit,
    })

    const sync = result.sync.status
    const publishStatus = result.publish?.status ?? 'skipped'
    const publishFailed =
      result.publish != null
      && result.publish.status !== 'published'
      && result.publish.status !== 'already_current'
    const failed = sync === 'failed' || publishFailed
    const skipped = sync === 'skipped'
    if (
      !failed
      && !skipped
      && builderConfig.publishAfterSync
      && env.AIRINGCAL_BUILDER_PUBLIC_DIR?.trim()
      && shouldLogGcDryRunAfterPublish(env)
    ) {
      try {
        await logPublicSnapshotGcDryRun(env)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'gc_dry_run_failed'
        console.log(JSON.stringify({ status: 'info', stage: 'public_snapshot_gc_dry_run', error: message }))
      }
    }
    const mediaPart = mediaMode === 'skip' ? 'media=skip' : mediaSummary
    return {
      job: 'airingcal-sync',
      status: failed ? 'failed' : skipped ? 'skipped' : 'success',
      message: `portable builder sync=${sync} ${mediaPart} publish=${publishStatus} generation=${result.sync.generation ?? 'null'}`,
    }
  } finally {
    db.close()
    if (ownsPublicStore) publicStore.close?.()
  }
}
