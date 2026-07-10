export const appBoundary = 'media-worker'

import { BgmClient, BgmHttpError, BgmNetworkError, BgmTimeoutError } from '@airing-cal/bgm-api'
import { imageRef, subjectDetailImages, subjectMetaFromDetail, subjectMetaFromNotFound } from '@airing-cal/domain'
import { getCachedSubjectDetail, imageIndexKey, imageStatusKey, KVStorage, R2ImageStore, subjectMetaKey, subjectRefreshKey, type ImageSourceSize, type MediaRefreshJobV2, type SubjectRefreshState } from '@airing-cal/storage'
import { sanitizeErrorMessage } from '@airing-cal/worker-common'

interface LegacyMediaJob {
  subject_id: number
  title: string
  subject_meta?: boolean
  images?: {
    common?: string
    large?: string
  }
}

type MediaJob = LegacyMediaJob | MediaRefreshJobV2

interface MediaEnv {
  AIRING_CAL_KV: {
    get(key: string, type: 'json'): Promise<unknown>
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
    delete(key: string): Promise<void>
  }
  AIRING_CAL_R2: ConstructorParameters<typeof R2ImageStore>[0]
}

interface QueueBatch {
  messages: Array<{
    body: MediaJob
    attempts?: number
    ack?: () => void
    retry?: (options?: { delaySeconds?: number }) => void
  }>
}

function isV2Job(job: MediaJob): job is MediaRefreshJobV2 {
  return 'version' in job && job.version === 2 && typeof job.job_id === 'string' && Array.isArray(job.components)
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

async function processImage(size: ImageSourceSize, sourceUrl: string | undefined, previous: any, job: MediaJob, client: BgmClient, imageStore: R2ImageStore, storage: KVStorage, now: number) {
  const cached = reusableCachedImageStatus(previous, sourceUrl)
  if (cached) return cached
  if (!sourceUrl) {
    return cachedImageStatus(previous) ?? previous ?? { ...emptyImageStatus(), status: 'missing_source' }
  }
  try {
    const downloaded = await client.downloadImage(sourceUrl)
    if (!downloaded) return cachedImageStatus(previous) ?? { ...emptyImageStatus(), status: 'failed', queued_at: now, last_error: 'image download failed' }
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
    if (isTransient(error) && !cachedImageStatus(previous)) throw error
    return cachedImageStatus(previous) ?? {
      ...emptyImageStatus(),
      status: 'failed',
      queued_at: now,
      last_error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    }
  }
}

async function fetchSubjectDetail(job: MediaJob, client: BgmClient, storage: KVStorage, now: number): Promise<any | null> {
  try {
    const subject = await getCachedSubjectDetail(storage, client, job.subject_id, now)
    if (!subject) {
      await storage.put(subjectMetaKey(job.subject_id), subjectMetaFromNotFound(job.subject_id, now))
      return null
    }
    await storage.put(subjectMetaKey(job.subject_id), subjectMetaFromDetail(job.subject_id, subject, now))
    return subject
  } catch (error) {
    const existing = await storage.get(subjectMetaKey(job.subject_id))
    if (!existing) {
      await storage.put(subjectMetaKey(job.subject_id), {
        subject_id: job.subject_id,
        exists: null,
        nsfw: true,
        checked_at: now,
        reason: 'network_error',
        last_error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
      })
    }
    if (isTransient(error)) throw error
    return null
  }
}

async function putRefreshState(storage: KVStorage, job: MediaRefreshJobV2, state: SubjectRefreshState['status'], now: number, error: string | null = null): Promise<void> {
  const previous = await storage.get<SubjectRefreshState>(subjectRefreshKey(job.subject_id))
  await storage.put(subjectRefreshKey(job.subject_id), {
    subject_id: job.subject_id,
    job_id: job.job_id,
    status: state,
    queued_at: previous?.job_id === job.job_id ? previous.queued_at : now,
    updated_at: now,
    completed_at: state === 'running' || state === 'queued' ? null : now,
    error,
  } satisfies SubjectRefreshState)
}

async function processJob(job: MediaJob, env: MediaEnv): Promise<'processed' | 'duplicate'> {
  const storage = new KVStorage(env.AIRING_CAL_KV)
  const imageStore = new R2ImageStore(env.AIRING_CAL_R2)
  const client = new BgmClient()
  const now = Math.floor(Date.now() / 1000)
  if (isV2Job(job)) {
    const refresh = await storage.get<SubjectRefreshState>(subjectRefreshKey(job.subject_id))
    const activeDuplicate = refresh?.job_id === job.job_id
      && (refresh.status === 'ok' || refresh.status === 'partial' || refresh.status === 'running' && now - refresh.updated_at < 600)
    if (activeDuplicate) return 'duplicate'
    await putRefreshState(storage, job, 'running', now)
  }
  const previousStatus = await storage.get<any>(imageStatusKey(job.subject_id))
  const refreshDetail = !isV2Job(job) || job.components.includes('detail') || job.components.includes('meta')
  const subject = refreshDetail ? await fetchSubjectDetail(job, client, storage, now) : null
  const detailImages = subjectDetailImages(subject)
  const images = {
    common: detailImages.common ?? (isV2Job(job) ? job.images?.common : undefined),
    large: detailImages.large ?? (isV2Job(job) ? job.images?.large : undefined),
  }

  const [common, large] = await Promise.all([
    !isV2Job(job) || job.components.includes('image_common')
      ? processImage('common', images.common, previousStatus?.common, job, client, imageStore, storage, now)
      : previousStatus?.common ?? emptyImageStatus(),
    !isV2Job(job) || job.components.includes('image_large')
      ? processImage('large', images.large, previousStatus?.large, job, client, imageStore, storage, now)
      : previousStatus?.large ?? emptyImageStatus(),
  ])

  await storage.put(imageStatusKey(job.subject_id), {
    subject_id: job.subject_id,
    title: job.title,
    common,
    large,
    subject_checked_at: now,
  })
  if (isV2Job(job)) {
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
      await processJob(message.body, env)
      message.ack?.()
    } catch (error) {
      if (isV2Job(message.body) && isTransient(error)) {
        const storage = new KVStorage(env.AIRING_CAL_KV)
        const now = Math.floor(Date.now() / 1000)
        await putRefreshState(storage, message.body, 'failed', now, sanitizeErrorMessage(error instanceof Error ? error.message : String(error)))
        const delays = [30, 120, 300]
        message.retry?.({ delaySeconds: delays[Math.min(Math.max((message.attempts ?? 1) - 1, 0), delays.length - 1)] })
        continue
      }
      if (isV2Job(message.body)) {
        const storage = new KVStorage(env.AIRING_CAL_KV)
        await putRefreshState(storage, message.body, 'failed', Math.floor(Date.now() / 1000), 'Media refresh failed')
        message.ack?.()
        continue
      }
      throw error
    }
  }
}

export { processJob }
export default { queue }
