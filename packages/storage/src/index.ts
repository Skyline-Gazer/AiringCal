export const packageBoundary = '@airing-cal/storage'

export type CollectionType = 'want' | 'watched' | 'watching' | 'on_hold' | 'dropped'
export type ImageSourceSize = 'common' | 'large'

export interface StorageAdapter {
  get<T>(key: string, validate?: (value: unknown) => value is T): Promise<T | null>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
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

export function syncMetaKey(): string {
  return 'sync:meta'
}

export function subjectMetaKey(subjectId: number): string {
  return `subject:meta:${subjectId}`
}

export function imageStatusKey(subjectId: number): string {
  return `image:status:${subjectId}`
}

export function imageIndexKey(hash: string): string {
  return `image:index:${hash}`
}

export function imageOriginalKey(hash: string): string {
  return `images/${hash}/original`
}

export class KVStorage implements StorageAdapter {
  constructor(private kv: { get(key: string, type: 'json'): Promise<unknown>; put(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }) {}

  async get<T>(key: string, validate?: (value: unknown) => value is T): Promise<T | null> {
    const raw = await this.kv.get(key, 'json')
    if (raw === null || raw === undefined) return null
    if (validate) return validate(raw) ? raw : null
    return raw as T
  }

  async put<T>(key: string, value: T): Promise<void> {
    await this.kv.put(key, JSON.stringify(value))
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key)
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
