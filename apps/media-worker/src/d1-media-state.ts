import { BgmClient, BgmHttpError, BgmNetworkError, BgmTimeoutError } from '@airing-cal/bgm-api'
import { subjectDetailImages } from '@airing-cal/domain'
import {
  canonicalJson,
  D1StateStore,
  imageOriginalKey,
  nextSubjectRefreshAt,
  R2ImageStore,
  sha256Canonical,
  type D1DatabaseLike,
  type ImageSourceSize,
  type MediaRefreshJobV4,
  type SubjectMediaRow,
} from '@airing-cal/storage'

export interface D1MediaEnv {
  AIRING_CAL_D1: D1DatabaseLike
  AIRING_CAL_R2: ConstructorParameters<typeof R2ImageStore>[0]
}

export interface D1MediaRefreshResult {
  d1Writes: number
  imageWrites: number
  status: 'unchanged' | 'updated' | 'retry_scheduled'
}

const RETRY_DELAYS_SECONDS = [30, 120, 300] as const
const SUBJECT_NOT_FOUND_TTL_SECONDS = 86400

// Source URL and R2 key are one authoritative pair until a requested refresh succeeds.
class ImageUnavailableError extends Error {
  constructor() {
    super('Requested image is unavailable')
    this.name = 'ImageUnavailableError'
  }
}

const SUBJECT_MEDIA_FIELDS = [
  'subject_id',
  'detail_json',
  'detail_hash',
  'media_hash',
  'nsfw',
  'source_image_common_url',
  'source_image_large_url',
  'r2_image_common_key',
  'r2_image_large_key',
  'checked_at',
  'next_refresh_at',
  'retry_count',
  'retry_after',
  'error_code',
] as const

const SEMANTIC_MEDIA_FIELDS = [
  'detail_json',
  'detail_hash',
  'media_hash',
  'nsfw',
  'source_image_common_url',
  'source_image_large_url',
  'r2_image_common_key',
  'r2_image_large_key',
] as const

function sameFields(
  left: SubjectMediaRow,
  right: SubjectMediaRow,
  fields: readonly (keyof SubjectMediaRow)[],
): boolean {
  return fields.every((field) => left[field] === right[field])
}

function emptySubjectMediaRow(subjectId: number): SubjectMediaRow {
  return {
    subject_id: subjectId,
    detail_json: null,
    detail_hash: null,
    media_hash: null,
    nsfw: 0,
    source_image_common_url: null,
    source_image_large_url: null,
    r2_image_common_key: null,
    r2_image_large_key: null,
    checked_at: null,
    next_refresh_at: null,
    retry_count: 0,
    retry_after: null,
    error_code: null,
  }
}

function isActiveSubjectNotFoundTombstone(row: SubjectMediaRow, now: number): boolean {
  return row.detail_json === null
    && row.detail_hash === null
    && row.nsfw === 1
    && row.checked_at !== null
    && row.next_refresh_at === row.checked_at + SUBJECT_NOT_FOUND_TTL_SECONDS
    && now < row.next_refresh_at
}

async function calculateMediaHash(row: SubjectMediaRow): Promise<string> {
  return sha256Canonical({
    nsfw: row.nsfw,
    source_image_common_url: row.source_image_common_url,
    source_image_large_url: row.source_image_large_url,
    r2_image_common_key: row.r2_image_common_key,
    r2_image_large_key: row.r2_image_large_key,
  })
}

function classifyRefreshError(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof ImageUnavailableError) return { code: 'IMAGE_UNAVAILABLE', retryable: true }
  if (error instanceof BgmTimeoutError) return { code: 'BGM_TIMEOUT', retryable: true }
  if (error instanceof BgmNetworkError) return { code: 'BGM_NETWORK', retryable: true }
  if (error instanceof BgmHttpError) {
    if (error.status === 429) return { code: 'BGM_RATE_LIMITED', retryable: true }
    if (error.status >= 500) return { code: 'BGM_UPSTREAM_5XX', retryable: true }
    if (error.status === 401) return { code: 'BGM_UNAUTHORIZED', retryable: false }
    if (error.status === 403) return { code: 'BGM_FORBIDDEN', retryable: false }
    return { code: 'BGM_HTTP_ERROR', retryable: false }
  }
  return { code: 'MEDIA_REFRESH_FAILED', retryable: true }
}

async function refreshImage(
  size: ImageSourceSize,
  sourceUrl: string | undefined,
  previousKey: string | null,
  job: MediaRefreshJobV4,
  now: number,
  client: BgmClient,
  imageStore: R2ImageStore,
): Promise<{ key: string | null; writes: number }> {
  const requested = job.components.includes(size === 'common' ? 'image_common' : 'image_large')
  if (!requested) return { key: previousKey, writes: 0 }
  if (!sourceUrl) throw new ImageUnavailableError()

  const downloaded = await client.downloadImage(sourceUrl)
  if (!downloaded) throw new ImageUnavailableError()
  const digest = await crypto.subtle.digest('SHA-256', downloaded.data)
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  const key = imageOriginalKey(hash)
  if (key === previousKey) return { key, writes: 0 }
  const existing = await imageStore.getOriginal(hash)
  if (!existing) {
    await imageStore.putOriginal(hash, downloaded.data, downloaded.contentType, {
      sourceUrl,
      subjectId: job.subject_id,
      sourceSize: size,
      cachedAt: now,
    })
    return { key, writes: 1 }
  }
  return { key, writes: 0 }
}

export async function refreshSubjectMediaD1(
  env: D1MediaEnv,
  job: MediaRefreshJobV4,
): Promise<D1MediaRefreshResult> {
  const now = Math.floor(Date.now() / 1000)
  const store = new D1StateStore(env.AIRING_CAL_D1, () => now)
  const current = await store.getSubjectMediaRow(job.subject_id)
  const base = current ?? emptySubjectMediaRow(job.subject_id)
  if (current && isActiveSubjectNotFoundTombstone(current, now)) {
    return { d1Writes: 0, imageWrites: 0, status: 'unchanged' }
  }
  const client = new BgmClient()
  const imageStore = new R2ImageStore(env.AIRING_CAL_R2)
  let imageWrites = 0
  let semantic: SubjectMediaRow
  let subjectNotFound = false

  try {
    const subject = await client.getSubject(job.subject_id)
    if (!subject) {
      subjectNotFound = true
      semantic = {
        ...base,
        detail_json: null,
        detail_hash: null,
        nsfw: 1,
        // The tombstone hides media through NSFW projection; Task 8 has no image deletion policy.
      }
    } else {
      const detailJson = canonicalJson(subject)
      const detailHash = await sha256Canonical(subject)
      const images = subjectDetailImages(subject)
      const commonChanged = images.common !== (current?.source_image_common_url ?? undefined)
        || current?.r2_image_common_key === null
      const largeChanged = images.large !== (current?.source_image_large_url ?? undefined)
        || current?.r2_image_large_key === null
      const commonRequested = job.components.includes('image_common')
      const largeRequested = job.components.includes('image_large')
      const common = commonChanged
        ? await refreshImage('common', images.common, current?.r2_image_common_key ?? null, job, now, client, imageStore)
        : { key: current?.r2_image_common_key ?? null, writes: 0 }
      imageWrites += common.writes
      const large = largeChanged
        ? await refreshImage('large', images.large, current?.r2_image_large_key ?? null, job, now, client, imageStore)
        : { key: current?.r2_image_large_key ?? null, writes: 0 }
      imageWrites += large.writes
      semantic = {
        ...base,
        detail_json: detailJson,
        detail_hash: detailHash,
        nsfw: subject.nsfw === true ? 1 : 0,
        source_image_common_url: commonChanged && !commonRequested
          ? current?.source_image_common_url ?? null
          : images.common ?? null,
        source_image_large_url: largeChanged && !largeRequested
          ? current?.source_image_large_url ?? null
          : images.large ?? null,
        r2_image_common_key: common.key,
        r2_image_large_key: large.key,
      }
    }
    semantic.media_hash = await calculateMediaHash(semantic)
  } catch (error) {
    const classification = classifyRefreshError(error)
    const retryCount = classification.retryable
      ? Math.min(base.retry_count + 1, RETRY_DELAYS_SECONDS.length)
      : 0
    const retryDelay = RETRY_DELAYS_SECONDS[Math.min(base.retry_count, RETRY_DELAYS_SECONDS.length - 1)]
    const failed: SubjectMediaRow = {
      ...base,
      retry_count: retryCount,
      retry_after: classification.retryable ? now + retryDelay : null,
      error_code: classification.code,
    }
    if (current && sameFields(current, failed, SUBJECT_MEDIA_FIELDS)) {
      return { d1Writes: 0, imageWrites, status: classification.retryable ? 'retry_scheduled' : 'unchanged' }
    }
    const { rowsWritten } = await store.putSubjectMediaRow(failed)
    return {
      d1Writes: rowsWritten,
      imageWrites,
      status: classification.retryable ? 'retry_scheduled' : 'updated',
    }
  }

  if (
    !subjectNotFound
    && current
    && sameFields(current, semantic, SEMANTIC_MEDIA_FIELDS)
    && current.retry_count === 0
    && current.retry_after === null
    && current.error_code === null
  ) {
    return { d1Writes: 0, imageWrites, status: 'unchanged' }
  }

  const next: SubjectMediaRow = {
    ...semantic,
    checked_at: now,
    next_refresh_at: subjectNotFound
      ? now + SUBJECT_NOT_FOUND_TTL_SECONDS
      : nextSubjectRefreshAt(job.subject_id, now),
    retry_count: 0,
    retry_after: null,
    error_code: null,
  }
  const { rowsWritten } = await store.putSubjectMediaRow(next)
  return {
    d1Writes: rowsWritten,
    imageWrites,
    status: rowsWritten === 0 && imageWrites === 0 ? 'unchanged' : 'updated',
  }
}
