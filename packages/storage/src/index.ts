export const packageBoundary = '@airing-cal/storage'

export type CollectionType = 'want' | 'watched' | 'watching' | 'on_hold' | 'dropped'
export type ImageSourceSize = 'common' | 'large'
export const SUBJECT_DETAIL_TTL_SECONDS = 60 * 60 * 24 * 7
export const SYNC_RUN_TTL_SECONDS = 60 * 60 * 24 * 3
export const SYNC_STAGING_TTL_SECONDS = 60 * 60 * 24

export interface SyncWorkflowParams {
  mode?: 'shadow' | 'live'
  source?: 'manual' | 'schedule'
}

export interface SyncRun {
  instance_id: string
  mode: 'shadow' | 'live'
  source: 'schedule' | 'manual'
  status: 'queued' | 'running' | 'retrying' | 'ok' | 'error'
  stage: 'initialize' | 'collections' | 'calendar' | 'snapshots' | 'refresh_plan' | 'enqueue' | 'complete'
  started_at: number
  heartbeat_at: number
  completed_at: number | null
  collection_pages: number
  subject_count: number
  refresh_jobs: number
  error: string | null
}

export type SubjectRefreshStatus = 'queued' | 'running' | 'ok' | 'partial' | 'failed'

export interface SubjectRefreshState {
  subject_id: number
  job_id: string
  status: SubjectRefreshStatus
  queued_at: number
  updated_at: number
  completed_at: number | null
  error: string | null
}

export type MediaRefreshComponent = 'detail' | 'meta' | 'image_common' | 'image_large'

export interface MediaRefreshJobV2 {
  version: 2
  job_id: string
  subject_id: number
  title: string
  components: MediaRefreshComponent[]
  images?: {
    common?: string
    large?: string
  }
}

export interface StorageAdapter {
  get<T>(key: string, validate?: (value: unknown) => value is T): Promise<T | null>
  put<T>(key: string, value: T, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

export interface SubjectDetailCacheEntry<T = any> {
  cached_at: number
  subject: T
}

export interface SubjectDetailClient<T = any> {
  getSubject(subjectId: number): Promise<T | null>
}

export interface StoredImage {
  data: ArrayBuffer
  contentType: string
  bytes?: number
  sourceUrl?: string
  subjectId?: number
  sourceSize?: ImageSourceSize
  cachedAt?: number
}

export interface PutOriginalImageMetadata {
  sourceUrl: string
  subjectId: number
  sourceSize: ImageSourceSize
  cachedAt: number
}

interface R2ObjectBodyLike {
  arrayBuffer(): Promise<ArrayBuffer>
  httpMetadata?: { contentType?: string }
  customMetadata?: Record<string, string>
}

interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>
  put(
    key: string,
    value: ArrayBuffer,
    options: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>
}

export function snapshotCollectionsKey(type: CollectionType): string {
  return `snapshot:collections:${type}`
}

export function snapshotCalendarKey(): string {
  return 'snapshot:calendar'
}

export function snapshotSummaryKey(): string {
  return 'snapshot:summary'
}

export function snapshotActiveKey(): string {
  return 'snapshot:active'
}

export function snapshotVersionKey(instanceId: string, suffix: string): string {
  return `snapshot:version:${instanceId}:${suffix}`
}

export function syncMetaKey(): string {
  return 'sync:meta'
}

export function subjectMetaKey(subjectId: number): string {
  return `subject:meta:${subjectId}`
}

export function subjectDetailKey(subjectId: number): string {
  return `subject:detail:${subjectId}`
}

export function imageStatusKey(subjectId: number): string {
  return `image:status:${subjectId}`
}

export function subjectRefreshKey(subjectId: number): string {
  return `subject:refresh:${subjectId}`
}

export function syncRunKey(instanceId: string): string {
  return `sync:run:${instanceId}`
}

export function syncStagingKey(instanceId: string, suffix: string): string {
  return `sync:staging:${instanceId}:${suffix}`
}

export function syncShadowKey(instanceId: string, suffix: string): string {
  return `snapshot:shadow:${instanceId}:${suffix}`
}

export function imageIndexKey(hash: string): string {
  return `image:index:${hash}`
}

export function imageOriginalKey(hash: string): string {
  return `images/${hash}/original`
}

export class KVStorage implements StorageAdapter {
  constructor(private kv: { get(key: string, type: 'json'): Promise<unknown>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>; delete(key: string): Promise<void> }) {}

  async get<T>(key: string, validate?: (value: unknown) => value is T): Promise<T | null> {
    const raw = await this.kv.get(key, 'json')
    if (raw === null || raw === undefined) return null
    if (validate) return validate(raw) ? raw : null
    return raw as T
  }

  async put<T>(key: string, value: T, options?: { expirationTtl?: number }): Promise<void> {
    await this.kv.put(key, JSON.stringify(value), options)
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key)
  }
}

export function nextSubjectRefreshAt(subjectId: number, cachedAt: number): number {
  const sixDays = 6 * 24 * 60 * 60
  const twoDays = 2 * 24 * 60 * 60
  const spread = Math.abs(Math.trunc(subjectId) * 997) % (twoDays + 1)
  return cachedAt + sixDays + spread
}

function freshSubjectDetail<T>(entry: SubjectDetailCacheEntry<T> | null, now: number, ttlSeconds: number): T | null {
  if (!entry || !entry.subject || typeof entry.cached_at !== 'number') return null
  return now - entry.cached_at <= ttlSeconds ? entry.subject : null
}

export async function getCachedSubjectDetail<T = any>(
  storage: StorageAdapter,
  client: SubjectDetailClient<T>,
  subjectId: number,
  now: number,
  ttlSeconds = SUBJECT_DETAIL_TTL_SECONDS,
): Promise<T | null> {
  const cached = await storage.get<SubjectDetailCacheEntry<T>>(subjectDetailKey(subjectId))
  const fresh = freshSubjectDetail(cached, now, ttlSeconds)
  if (fresh) return fresh

  try {
    const subject = await client.getSubject(subjectId)
    if (!subject) return cached?.subject ?? null
    await storage.put(subjectDetailKey(subjectId), { cached_at: now, subject })
    return subject
  } catch (error) {
    if (cached?.subject) return cached.subject
    throw error
  }
}

export class R2ImageStore {
  constructor(private r2: R2BucketLike) {}

  async getOriginal(hash: string): Promise<StoredImage | null> {
    const object = await this.r2.get(imageOriginalKey(hash))
    if (!object) return null
    const metadata = object.customMetadata ?? {}
    return {
      data: await object.arrayBuffer(),
      contentType: object.httpMetadata?.contentType || 'image/jpeg',
      bytes: metadata.bytes ? Number(metadata.bytes) : undefined,
      sourceUrl: metadata.source_url,
      subjectId: metadata.subject_id ? Number(metadata.subject_id) : undefined,
      sourceSize: metadata.source_size === 'common' || metadata.source_size === 'large' ? metadata.source_size : undefined,
      cachedAt: metadata.cached_at ? Number(metadata.cached_at) : undefined,
    }
  }

  async putOriginal(hash: string, data: ArrayBuffer, contentType: string, metadata: PutOriginalImageMetadata): Promise<void> {
    await this.r2.put(imageOriginalKey(hash), data, {
      httpMetadata: { contentType },
      customMetadata: {
        bytes: String(data.byteLength),
        source_url: metadata.sourceUrl,
        subject_id: String(metadata.subjectId),
        source_size: metadata.sourceSize,
        cached_at: String(metadata.cachedAt),
      },
    })
  }
}
