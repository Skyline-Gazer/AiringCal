import type {
  CloudflareR2BucketBinding,
  CloudflareR2HeadResult,
  CloudflareR2ObjectBody,
  CloudflareR2PutOptions,
} from './cloudflare-r2-public-store.ts'

export class MemoryR2Object implements CloudflareR2ObjectBody {
  constructor(readonly bytes: Uint8Array) {}

  async arrayBuffer(): Promise<ArrayBuffer> {
    const copy = new Uint8Array(this.bytes.byteLength)
    copy.set(this.bytes)
    return copy.buffer
  }
}

const QUOTED_ETAG = /^".*"$/

/**
 * In-memory {@link CloudflareR2BucketBinding} double.
 *
 * Mirrors the R2 semantics the v3 publisher relies on: `head()` exposes the
 * unquoted `etag` plus the quoted `httpEtag`, conditional headers must use the
 * quoted ETag form, and violated preconditions throw.
 *
 * `apps/v3-read-worker` verifies the header/ETag contract against the wrangler
 * local R2 emulation; see `docs/v3/cloudflare-read-worker.md`.
 */
export class MemoryR2Bucket implements CloudflareR2BucketBinding {
  objects = new Map<string, { bytes: Uint8Array; etag: string }>()
  private etagCounter = 0

  async get(key: string): Promise<CloudflareR2ObjectBody | null> {
    const entry = this.objects.get(key)
    return entry ? new MemoryR2Object(entry.bytes) : null
  }

  async head(key: string): Promise<CloudflareR2HeadResult | null> {
    const entry = this.objects.get(key)
    return entry ? { etag: entry.etag, httpEtag: `"${entry.etag}"` } : null
  }

  async put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: CloudflareR2PutOptions,
  ): Promise<void> {
    const onlyIf = options?.onlyIf
    const existing = this.objects.get(key)

    const ifNoneMatch = onlyIf?.get('If-None-Match')
    if (ifNoneMatch && ifNoneMatch !== '*') {
      throw new Error(`Invalid ETag in if-none-match header: ${ifNoneMatch}`)
    }
    if (ifNoneMatch === '*' && existing) throw new Error('PreconditionFailed')

    const ifMatch = onlyIf?.get('If-Match')
    if (ifMatch) {
      if (!QUOTED_ETAG.test(ifMatch)) throw new Error(`Invalid ETag in if-match header: ${ifMatch}`)
      if (!existing || `"${existing.etag}"` !== ifMatch) throw new Error('PreconditionFailed')
    }

    const bytes = typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(value)
    this.etagCounter += 1
    this.objects.set(key, { bytes: new Uint8Array(bytes), etag: `etag-${this.etagCounter}` })
  }
}
