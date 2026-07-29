export const appBoundary = 'media-worker'

import { BgmClient, BgmHttpError, BgmNetworkError, BgmTimeoutError } from '@airing-cal/bgm-api'
import { imageRef, isActiveNotFoundSubjectMeta, isConfirmedNotFoundSubjectMeta, subjectDetailImages, subjectMetaFromDetail, subjectMetaFromNotFound, type SubjectMeta } from '@airing-cal/domain'
import { getCachedSubjectDetail, imageIndexKey, imageStatusKey, isMediaRefreshJobV2, isMediaRefreshJobV3, isMediaRefreshJobV4, KVStorage, putJsonIfChanged, R2ImageStore, SUBJECT_DETAIL_TTL_SECONDS, subjectDetailKey, subjectMetaKey, subjectRefreshKey, type D1DatabaseLike, type ImageSourceSize, type MediaRefreshJobV2, type MediaRefreshJobV3, type MediaRefreshJobV4, type SubjectDetailCacheEntry, type SubjectRefreshState } from '@airing-cal/storage'
import { sanitizeErrorMessage } from '@airing-cal/worker-common'
import { refreshSubjectMediaD1 } from './d1-media-state.ts'

export interface LegacyMediaJob {
  subject_id: number
  title: string
  subject_meta?: boolean
  images?: {
    common?: string
    large?: string
  }
}

export type MediaJob = LegacyMediaJob | MediaRefreshJobV2 | MediaRefreshJobV3 | MediaRefreshJobV4
type LegacyVersionedMediaJob = MediaRefreshJobV2 | MediaRefreshJobV3

export interface MediaEnv {
  AIRING_CAL_D1: D1DatabaseLike
  AIRING_CAL_KV: {
    get(key: string, type: 'json'): Promise<unknown>
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
    delete(key: string): Promise<void>
  }
  AIRING_CAL_R2: ConstructorParameters<typeof R2ImageStore>[0]
  SUBJECT_REFRESH_COORDINATOR?: {
    getByName(name: string): { fetch(request: Request): Promise<Response> }
  }
}

interface QueueBatch {
  messages: Array<{
    body: MediaJob
    attempts?: number
    ack?: () => void
    retry?: (options?: { delaySeconds?: number }) => void
  }>
}

function hasMediaVersion(job: MediaJob, version: number): boolean {
  return 'version' in job && job.version === version
}

function isLegacyVersionedJob(job: MediaJob): job is LegacyVersionedMediaJob {
  return isMediaRefreshJobV2(job) || isMediaRefreshJobV3(job)
}

function isTransient(error: unknown): boolean {
  return error instanceof BgmTimeoutError
    || error instanceof BgmNetworkError
    || error instanceof BgmHttpError && (error.status === 429 || error.status >= 500)
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function emptyImageStatus() {
  return {
    status: 'pending_next_cron',
    hash: null,
    uri: null,
    r2_key: null,
    queued_at: null,
    cached_at: null,
    last_error: null,
  }
}

function cachedImageStatus(previous: any) {
  return previous?.status === 'cached' ? previous : null
}

function reusableCachedImageStatus(previous: any, sourceUrl: string | undefined) {
  const cached = cachedImageStatus(previous)
  if (!cached) return null
  if (!sourceUrl) return cached
  return cached.source_url === sourceUrl ? cached : null
}

function failedImageStatus(previous: any, sourceUrl: string | undefined, error: unknown, now: number) {
  return cachedImageStatus(previous) ?? {
    ...emptyImageStatus(),
    status: 'failed',
    queued_at: now,
    last_error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    source_url: sourceUrl,
  }
}

function normalizeSubjectMeta(value: SubjectMeta & { last_error?: string }) {
  const { checked_at: _checkedAt, ...semantic } = value
  return semantic
}

function normalizeImageStatus(value: any) {
  const { subject_checked_at: _subjectCheckedAt, common, large, ...semantic } = value
  const withoutQueuedAt = (component: any) => {
    if (!component || typeof component !== 'object') return component
    const { queued_at: _queuedAt, ...componentSemantic } = component
    return componentSemantic
  }
  return {
    ...semantic,
    common: withoutQueuedAt(common),
    large: withoutQueuedAt(large),
  }
}

function normalizeRefreshState(value: SubjectRefreshState) {
  if (value.status !== 'ok' && value.status !== 'partial') return value
  return {
    subject_id: value.subject_id,
    status: value.status,
    error: value.error,
  }
}

function sameSubjectMeta(meta: SubjectMeta | null, subjectId: number, subject: any): boolean {
  return meta?.subject_id === subjectId
    && meta.exists === true
    && meta.nsfw === (subject?.nsfw === true)
    && meta.expires_at === null
    && meta.reason === 'subject_detail'
}

async function isFullyReusableJob(
  job: LegacyVersionedMediaJob,
  storage: KVStorage,
  meta: SubjectMeta | null,
  previousStatus: any,
  now: number,
): Promise<boolean> {
  if (!previousStatus || previousStatus.subject_id !== job.subject_id || previousStatus.title !== job.title) return false
  const refreshDetail = job.components.includes('detail') || job.components.includes('meta') || isConfirmedNotFoundSubjectMeta(meta)
  let subject: any = null
  if (refreshDetail) {
    if (isConfirmedNotFoundSubjectMeta(meta)) return false
    const detail = await storage.get<SubjectDetailCacheEntry>(subjectDetailKey(job.subject_id))
    if (!detail?.subject || typeof detail.cached_at !== 'number' || now - detail.cached_at > SUBJECT_DETAIL_TTL_SECONDS) return false
    subject = detail.subject
    if (!sameSubjectMeta(meta, job.subject_id, subject)) return false
  }
  const detailImages = subjectDetailImages(subject)
  const images = {
    common: detailImages.common ?? job.images?.common,
    large: detailImages.large ?? job.images?.large,
  }
  if (job.components.includes('image_common') && !reusableCachedImageStatus(previousStatus.common, images.common)) return false
  if (job.components.includes('image_large') && !reusableCachedImageStatus(previousStatus.large, images.large)) return false
  return true
}

async function processImage(size: ImageSourceSize, sourceUrl: string | undefined, previous: any, job: MediaJob, client: BgmClient, imageStore: R2ImageStore, storage: KVStorage, now: number) {
  const cached = reusableCachedImageStatus(previous, sourceUrl)
  if (cached) return cached
  if (!sourceUrl) {
    return cachedImageStatus(previous) ?? previous ?? { ...emptyImageStatus(), status: 'missing_source' }
  }
  try {
    const downloaded = await client.downloadImage(sourceUrl)
    if (!downloaded) return cachedImageStatus(previous) ?? { ...emptyImageStatus(), status: 'failed', queued_at: now, last_error: 'image download failed', source_url: sourceUrl }
    const hash = await sha256Hex(downloaded.data)
    const ref = imageRef(hash)
    await imageStore.putOriginal(hash, downloaded.data, downloaded.contentType, {
      sourceUrl,
      subjectId: job.subject_id,
      sourceSize: size,
      cachedAt: now,
    })
    await storage.put(imageIndexKey(hash), {
      hash,
      subject_id: job.subject_id,
      title: job.title,
      source_size: size,
      r2_key: ref.r2_key,
      uri: ref.uri,
    })
    return {
      status: 'cached',
      hash,
      uri: ref.uri,
      r2_key: ref.r2_key,
      queued_at: now,
      cached_at: now,
      last_error: null,
      source_url: sourceUrl,
    }
  } catch (error) {
    if (isTransient(error) && (isLegacyVersionedJob(job) || !cachedImageStatus(previous))) throw error
    return cachedImageStatus(previous) ?? {
      ...emptyImageStatus(),
      status: 'failed',
      queued_at: now,
      last_error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
      source_url: sourceUrl,
    }
  }
}

async function fetchSubjectDetail(job: MediaJob, client: BgmClient, storage: KVStorage, now: number, forceUpstream = false): Promise<any | null> {
  try {
    const subject = forceUpstream
      ? await client.getSubject(job.subject_id)
      : await getCachedSubjectDetail(storage, client, job.subject_id, now)
    if (!subject) {
      await putJsonIfChanged(storage, subjectMetaKey(job.subject_id), subjectMetaFromNotFound(job.subject_id, now), normalizeSubjectMeta)
      try {
        await storage.delete(subjectDetailKey(job.subject_id))
      } catch {
        // The tombstone is authoritative; stale detail removal is best-effort.
      }
      return null
    }
    if (forceUpstream) {
      await putJsonIfChanged(storage, subjectDetailKey(job.subject_id), { cached_at: now, subject }, (value) => value.subject)
    }
    await putJsonIfChanged(storage, subjectMetaKey(job.subject_id), subjectMetaFromDetail(job.subject_id, subject, now), normalizeSubjectMeta)
    return subject
  } catch (error) {
    const existing = await storage.get(subjectMetaKey(job.subject_id))
    if (!existing) {
      await putJsonIfChanged(storage, subjectMetaKey(job.subject_id), {
        subject_id: job.subject_id,
        exists: null,
        nsfw: true,
        checked_at: now,
        expires_at: null,
        reason: 'network_error',
        last_error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
      }, normalizeSubjectMeta)
    }
    if (isTransient(error)) throw error
    return null
  }
}

async function putRefreshState(storage: KVStorage, job: LegacyVersionedMediaJob, state: SubjectRefreshState['status'], now: number, error: string | null = null): Promise<boolean> {
  const previous = await storage.get<SubjectRefreshState>(subjectRefreshKey(job.subject_id))
  return putJsonIfChanged(storage, subjectRefreshKey(job.subject_id), {
    subject_id: job.subject_id,
    job_id: job.job_id,
    ...('generation' in job ? { generation: job.generation } : {}),
    status: state,
    queued_at: previous?.job_id === job.job_id ? previous.queued_at : now,
    updated_at: now,
    completed_at: state === 'running' || state === 'queued' ? null : now,
    error,
  } satisfies SubjectRefreshState, normalizeRefreshState)
}

async function processJob(job: MediaJob, env: MediaEnv): Promise<'processed' | 'duplicate' | 'retry_scheduled'> {
  if (hasMediaVersion(job, 4)) {
    if (!isMediaRefreshJobV4(job)) throw new Error('Invalid D1-only V4 media job')
    if (!env.AIRING_CAL_D1) throw new Error('Missing required AIRING_CAL_D1 binding for V4 media job')
    const result = await refreshSubjectMediaD1({
      AIRING_CAL_D1: env.AIRING_CAL_D1,
      AIRING_CAL_R2: env.AIRING_CAL_R2,
    }, job)
    return result.status === 'retry_scheduled' ? 'retry_scheduled' : 'processed'
  }
  if (
    hasMediaVersion(job, 2) && !isMediaRefreshJobV2(job)
    || hasMediaVersion(job, 3) && !isMediaRefreshJobV3(job)
  ) throw new Error('Invalid legacy media job')
  const storage = new KVStorage(env.AIRING_CAL_KV)
  const imageStore = new R2ImageStore(env.AIRING_CAL_R2)
  const client = new BgmClient()
  const now = Math.floor(Date.now() / 1000)
  let meta: SubjectMeta | null = null
  let previousStatus: any = null
  if (isLegacyVersionedJob(job)) {
    const refresh = await storage.get<SubjectRefreshState>(subjectRefreshKey(job.subject_id))
    const activeDuplicate = refresh?.job_id === job.job_id
      && (refresh.status === 'ok' || refresh.status === 'partial' || refresh.status === 'running' && now - refresh.updated_at < 600)
    if (activeDuplicate) return 'duplicate'
    meta = await storage.get<SubjectMeta>(subjectMetaKey(job.subject_id))
    previousStatus = await storage.get<any>(imageStatusKey(job.subject_id))
    if (isActiveNotFoundSubjectMeta(meta, now)) {
      await putRefreshState(storage, job, 'ok', now)
      return 'processed'
    }
    if (refresh?.status !== 'failed' && await isFullyReusableJob(job, storage, meta, previousStatus, now)) {
      await putRefreshState(storage, job, 'ok', now)
      return 'processed'
    }
    await putRefreshState(storage, job, 'running', now)
  }
  meta ??= await storage.get<SubjectMeta>(subjectMetaKey(job.subject_id))
  if (isActiveNotFoundSubjectMeta(meta, now)) {
    if (isLegacyVersionedJob(job)) await putRefreshState(storage, job, 'ok', now)
    return 'processed'
  }
  previousStatus ??= await storage.get<any>(imageStatusKey(job.subject_id))
  const refreshDetail = !isLegacyVersionedJob(job)
    || job.components.includes('detail')
    || job.components.includes('meta')
    || isConfirmedNotFoundSubjectMeta(meta)
  const subject = refreshDetail
    ? await fetchSubjectDetail(job, client, storage, now, isConfirmedNotFoundSubjectMeta(meta))
    : null
  if (refreshDetail && !subject) {
    const refreshedMeta = await storage.get<SubjectMeta>(subjectMetaKey(job.subject_id))
    if (isConfirmedNotFoundSubjectMeta(refreshedMeta)) {
      if (isLegacyVersionedJob(job)) await putRefreshState(storage, job, 'ok', now)
      return 'processed'
    }
  }
  const detailImages = subjectDetailImages(subject)
  const images = {
    common: detailImages.common ?? (isLegacyVersionedJob(job) ? job.images?.common : undefined),
    large: detailImages.large ?? (isLegacyVersionedJob(job) ? job.images?.large : undefined),
  }

  const imageResults = await Promise.allSettled([
    !isLegacyVersionedJob(job) || job.components.includes('image_common')
      ? processImage('common', images.common, previousStatus?.common, job, client, imageStore, storage, now)
      : previousStatus?.common ?? emptyImageStatus(),
    !isLegacyVersionedJob(job) || job.components.includes('image_large')
      ? processImage('large', images.large, previousStatus?.large, job, client, imageStore, storage, now)
      : previousStatus?.large ?? emptyImageStatus(),
  ])
  const common = imageResults[0].status === 'fulfilled'
    ? imageResults[0].value
    : failedImageStatus(previousStatus?.common, images.common, imageResults[0].reason, now)
  const large = imageResults[1].status === 'fulfilled'
    ? imageResults[1].value
    : failedImageStatus(previousStatus?.large, images.large, imageResults[1].reason, now)

  await putJsonIfChanged(storage, imageStatusKey(job.subject_id), {
    subject_id: job.subject_id,
    title: job.title,
    common,
    large,
    subject_checked_at: now,
  }, normalizeImageStatus)
  const transientFailure = imageResults.find((result) => result.status === 'rejected' && isTransient(result.reason))
  if (transientFailure?.status === 'rejected') throw transientFailure.reason
  if (isLegacyVersionedJob(job)) {
    const requestedImages = [
      job.components.includes('image_common') ? common : null,
      job.components.includes('image_large') ? large : null,
    ].filter(Boolean) as any[]
    const imageFailure = requestedImages.some((status) => status.status === 'failed')
    const missingImage = requestedImages.some((status) => status.status === 'missing_source')
    const refreshStatus = !subject && refreshDetail ? 'failed' : imageFailure || missingImage ? 'partial' : 'ok'
    await putRefreshState(storage, job, refreshStatus, now)
  }
  return 'processed'
}

async function queue(batch: QueueBatch, env: MediaEnv): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (env.SUBJECT_REFRESH_COORDINATOR) {
        const response = await env.SUBJECT_REFRESH_COORDINATOR.getByName(String(message.body.subject_id)).fetch(new Request('https://subject-refresh-coordinator/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(message.body),
        }))
        if (!response.ok) throw new BgmNetworkError(`Subject refresh coordinator failed (${response.status})`)
      } else {
        const status = await processJob(message.body, env)
        if (status === 'retry_scheduled') {
          const delays = [30, 120, 300]
          message.retry?.({ delaySeconds: delays[Math.min(Math.max((message.attempts ?? 1) - 1, 0), delays.length - 1)] })
          continue
        }
      }
      message.ack?.()
    } catch (error) {
      const d1Authoritative = hasMediaVersion(message.body, 4)
      if (d1Authoritative) {
        const delays = [30, 120, 300]
        message.retry?.({ delaySeconds: delays[Math.min(Math.max((message.attempts ?? 1) - 1, 0), delays.length - 1)] })
        continue
      }
      if (isLegacyVersionedJob(message.body) && isTransient(error)) {
        if (!env.SUBJECT_REFRESH_COORDINATOR) {
          const storage = new KVStorage(env.AIRING_CAL_KV)
          const now = Math.floor(Date.now() / 1000)
          await putRefreshState(storage, message.body, 'failed', now, sanitizeErrorMessage(error instanceof Error ? error.message : String(error)))
        }
        const delays = [30, 120, 300]
        message.retry?.({ delaySeconds: delays[Math.min(Math.max((message.attempts ?? 1) - 1, 0), delays.length - 1)] })
        continue
      }
      if (isLegacyVersionedJob(message.body)) {
        if (!env.SUBJECT_REFRESH_COORDINATOR) {
          const storage = new KVStorage(env.AIRING_CAL_KV)
          await putRefreshState(storage, message.body, 'failed', Math.floor(Date.now() / 1000), 'Media refresh failed')
        }
        message.ack?.()
        continue
      }
      throw error
    }
  }
}

export { processJob }
export { SubjectRefreshCoordinator } from './subject-refresh-coordinator.ts'
export default { queue }
