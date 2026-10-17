import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CompleteFullFetch } from '@airing-cal/bgm-api'
import { subjectDetailImages } from '@airing-cal/domain'
import { FilesystemPublicStore, MemoryPublicStore, type PublicStore } from '@airing-cal/v3-core'
import {
  openBuilderDatabase,
  runBuilderOnce,
  SqliteBuilderStateStore,
  SyncRunStore,
  type SyncRunMode,
} from '@airing-cal/v3-builder'
import { createFilesystemBlobStore } from '../adapters/filesystem-blob-store.ts'
import { createRunContext } from '../adapters/run-context.ts'
import type { JobSummary } from '../contracts.ts'
import { createUpstreamBgmClient, fetchCompleteInput } from '../upstream/fetch.ts'
import { readSyncUserConfig } from './config.ts'
import { mediaSubjectsFromFetch } from './media-refresh.ts'
import { createEnrichMediaSubjectsFromFetch } from './media-subject-resolve.ts'
import { runPortableMediaRefresh } from './portable-media.ts'
import { materializePortableThumbs } from './portable-thumb.ts'

function createPortablePublicStore(env: Record<string, string | undefined>): PublicStore {
  const publicDir = env.AIRINGCAL_BUILDER_PUBLIC_DIR?.trim()
  if (publicDir) {
    mkdirSync(publicDir, { recursive: true })
    return new FilesystemPublicStore(publicDir)
  }
  return new MemoryPublicStore()
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

  if (mediaMode === 'skip') {
    console.log(JSON.stringify({
      status: 'info',
      stage: 'media',
      mode: 'skip',
      reason: 'portable_builder_no_download',
    }))
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
    db.close()
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
    })

    const sync = result.sync.status
    const publishStatus = result.publish?.status ?? 'skipped'
    const publishFailed =
      result.publish != null
      && result.publish.status !== 'published'
      && result.publish.status !== 'already_current'
    const failed = sync === 'failed' || publishFailed
    const skipped = sync === 'skipped'
    const mediaPart = mediaMode === 'skip' ? 'media=skip' : mediaSummary
    return {
      job: 'airingcal-sync',
      status: failed ? 'failed' : skipped ? 'skipped' : 'success',
      message: `portable builder sync=${sync} ${mediaPart} publish=${publishStatus} generation=${result.sync.generation ?? 'null'}`,
    }
  } finally {
    db.close()
  }
}
