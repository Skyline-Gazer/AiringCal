export const appBoundary = 'media-worker'

import { BgmClient } from '@airing-cal/bgm-api'
import { imageRef, subjectMetaFromNotFound } from '@airing-cal/domain'
import { imageIndexKey, imageStatusKey, KVStorage, R2ImageStore, subjectMetaKey, type ImageSourceSize } from '@airing-cal/storage'
import { sanitizeErrorMessage } from '@airing-cal/worker-common'

interface MediaJob {
  subject_id: number
  title: string
  subject_meta?: boolean
  images?: {
    common?: string
    large?: string
  }
}

interface MediaEnv {
  AIRING_CAL_KV: {
    get(key: string, type: 'json'): Promise<unknown>
    put(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
  }
  AIRING_CAL_R2: ConstructorParameters<typeof R2ImageStore>[0]
}

interface QueueBatch {
  messages: Array<{ body: MediaJob; ack?: () => void; retry?: () => void }>
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

function preserveCachedImageStatus(previous: any) {
  return previous?.status === 'cached' ? previous : null
}

async function processImage(size: ImageSourceSize, sourceUrl: string | undefined, previous: any, job: MediaJob, client: BgmClient, imageStore: R2ImageStore, storage: KVStorage, now: number) {
  if (!sourceUrl) {
    return preserveCachedImageStatus(previous) ?? previous ?? { ...emptyImageStatus(), status: 'missing_source' }
  }
  try {
    const downloaded = await client.downloadImage(sourceUrl)
    if (!downloaded) return preserveCachedImageStatus(previous) ?? { ...emptyImageStatus(), status: 'failed', queued_at: now, last_error: 'image download failed' }
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
    }
  } catch (error) {
    return preserveCachedImageStatus(previous) ?? {
      ...emptyImageStatus(),
      status: 'failed',
      queued_at: now,
      last_error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    }
  }
}

async function processSubjectMeta(job: MediaJob, client: BgmClient, storage: KVStorage, now: number): Promise<void> {
  try {
    const subject = await client.getSubject(job.subject_id)
    if (!subject) {
      await storage.put(subjectMetaKey(job.subject_id), subjectMetaFromNotFound(job.subject_id, now))
      return
    }
    await storage.put(subjectMetaKey(job.subject_id), {
      subject_id: job.subject_id,
      exists: true,
      nsfw: subject.nsfw === true,
      checked_at: now,
      reason: 'subject_detail',
    })
  } catch (error) {
    const existing = await storage.get(subjectMetaKey(job.subject_id))
    if (existing) return
    await storage.put(subjectMetaKey(job.subject_id), {
      subject_id: job.subject_id,
      exists: null,
      nsfw: true,
      checked_at: now,
      reason: 'network_error',
      last_error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    })
  }
}

async function processJob(job: MediaJob, env: MediaEnv): Promise<void> {
  const storage = new KVStorage(env.AIRING_CAL_KV)
  const imageStore = new R2ImageStore(env.AIRING_CAL_R2)
  const client = new BgmClient()
  const now = Math.floor(Date.now() / 1000)
  const previousStatus = await storage.get<any>(imageStatusKey(job.subject_id))
  const images = job.images ?? {}

  const [common, large] = await Promise.all([
    processImage('common', images.common, previousStatus?.common, job, client, imageStore, storage, now),
    processImage('large', images.large, previousStatus?.large, job, client, imageStore, storage, now),
  ])
  await processSubjectMeta(job, client, storage, now)

  await storage.put(imageStatusKey(job.subject_id), {
    subject_id: job.subject_id,
    title: job.title,
    common,
    large,
    subject_checked_at: now,
  })
}

async function queue(batch: QueueBatch, env: MediaEnv): Promise<void> {
  for (const message of batch.messages) {
    await processJob(message.body, env)
    message.ack?.()
  }
}

export { processJob }
export default { queue }
