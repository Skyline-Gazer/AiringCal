import type {
  EdgeOneBlobBinding,
  EdgeOneBlobGetOptions,
  EdgeOneBlobListResult,
} from './edgeone-public-store.ts'

/**
 * In-memory EdgeOne Makers Blob double: `get`/`getWithHeaders`/`set`/`list`.
 * Mirrors the documented Blob surface so the store and the EdgeOne read gateway
 * can be tested without an EdgeOne account.
 */
export class MemoryEdgeOneBlob implements EdgeOneBlobBinding {
  objects = new Map<string, { bytes: Uint8Array; etag: string }>()
  /** When set, `set` silently discards the write (simulates a failed persistence). */
  dropWrites = false
  private etagCounter = 0

  async get(key: string, options?: EdgeOneBlobGetOptions): Promise<unknown> {
    const entry = this.objects.get(key)
    if (!entry) return null
    switch (options?.type) {
      case 'arrayBuffer':
        return entry.bytes.slice().buffer
      case 'json':
        return JSON.parse(new TextDecoder().decode(entry.bytes))
      default:
        return new TextDecoder().decode(entry.bytes)
    }
  }

  async getWithHeaders(key: string): Promise<{ body: string; headers: Record<string, string> } | null> {
    const entry = this.objects.get(key)
    if (!entry) return null
    return {
      body: new TextDecoder().decode(entry.bytes),
      headers: { etag: entry.etag, 'content-type': 'application/json' },
    }
  }

  async set(key: string, value: string | ArrayBuffer): Promise<void> {
    if (this.dropWrites) return
    const bytes = typeof value === 'string'
      ? new TextEncoder().encode(value)
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
        : new Uint8Array(value)
    this.etagCounter += 1
    this.objects.set(key, { bytes, etag: `etag-${this.etagCounter}` })
  }

  async list(options?: { prefix?: string; paginate?: boolean; cursor?: string }): Promise<EdgeOneBlobListResult> {
    const matching = [...this.objects.entries()]
      .filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
      .map(([key, entry]) => ({ key, etag: entry.etag }))
      .sort((a, b) => a.key.localeCompare(b.key))
    const start = options?.cursor
      ? matching.findIndex((blob) => blob.key === options.cursor)
      : 0
    const pageSize = 2
    const blobs = matching.slice(start, start + pageSize)
    const next = matching[start + pageSize]
    return next ? { blobs, cursor: next.key } : { blobs }
  }
}
