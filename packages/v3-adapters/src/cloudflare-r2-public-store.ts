import { canonicalJson } from '@airing-cal/storage'
import {
  PUBLIC_RELEASE_POINTER_KEY,
  bytesEqual,
  parsePublicReleasePointer,
  releasePointersMatch,
} from '@airing-cal/v3-core/public-pointer'
import type { PublicReleasePointer, PublicStore } from '@airing-cal/v3-core/ports'

export interface CloudflareR2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>
}

/**
 * Shape of the Workers R2 `head()` result we depend on. Real bindings return
 * `etag` unquoted and `httpEtag` quoted; conditional request headers
 * (`If-Match`) only accept the quoted form — verified against the local R2
 * emulation in `apps/v3-read-worker` smoke.
 */
export interface CloudflareR2HeadResult {
  etag: string
  httpEtag: string
}

export interface CloudflareR2PutOptions {
  onlyIf?: Headers
  httpMetadata?: { contentType?: string }
}

/** Minimal Workers R2 binding surface for v3 PublicStore (#72). */
export interface CloudflareR2BucketBinding {
  get(key: string): Promise<CloudflareR2ObjectBody | null>
  head(key: string): Promise<CloudflareR2HeadResult | null>
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: CloudflareR2PutOptions,
  ): Promise<unknown>
}

function assertSafeObjectKey(key: string): void {
  if (key.includes('\0') || key.startsWith('/') || key.includes('\\') || key.split('/').includes('..')) {
    throw new Error(`Unsafe public store object key: ${key}`)
  }
}

export class CloudflareR2PublicStore implements PublicStore {
  constructor(
    readonly bucket: CloudflareR2BucketBinding,
    readonly pointerKey: string = PUBLIC_RELEASE_POINTER_KEY,
  ) {}

  async getCurrentRelease(): Promise<PublicReleasePointer | null> {
    assertSafeObjectKey(this.pointerKey)
    const object = await this.bucket.get(this.pointerKey)
    if (!object) return null
    const raw = new TextDecoder().decode(new Uint8Array(await object.arrayBuffer()))
    return parsePublicReleasePointer(raw)
  }

  async getSnapshotBytes(artifactRef: string): Promise<Uint8Array | null> {
    assertSafeObjectKey(artifactRef)
    const object = await this.bucket.get(artifactRef)
    if (!object) return null
    return new Uint8Array(await object.arrayBuffer())
  }

  async putImmutableObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    assertSafeObjectKey(key)
    const head = await this.bucket.head(key)
    if (head) {
      const existing = await this.getSnapshotBytes(key)
      if (!existing || !bytesEqual(existing, body)) {
        throw new Error(`Immutable object already exists with different bytes: ${key}`)
      }
      return
    }
    await this.bucket.put(key, body, {
      onlyIf: new Headers({ 'If-None-Match': '*' }),
      httpMetadata: { contentType },
    })
  }

  async commitRelease(
    expected: PublicReleasePointer | null,
    next: PublicReleasePointer,
  ): Promise<'committed' | 'conflict' | 'unsupported'> {
    assertSafeObjectKey(this.pointerKey)
    const current = await this.getCurrentRelease()
    if (!releasePointersMatch(expected, current)) return 'conflict'

    const head = await this.bucket.head(this.pointerKey)
    const body = `${canonicalJson(next)}\n`
    const putOptions: CloudflareR2PutOptions = {
      httpMetadata: { contentType: 'application/json' },
    }
    if (head) {
      const httpEtag = head.httpEtag
      if (typeof httpEtag !== 'string' || httpEtag.length === 0) {
        throw new Error(
          `R2 head() for ${this.pointerKey} exposed no quoted httpEtag; refusing an unverifiable pointer commit`,
        )
      }
      putOptions.onlyIf = new Headers({ 'If-Match': httpEtag })
    } else {
      putOptions.onlyIf = new Headers({ 'If-None-Match': '*' })
    }

    try {
      await this.bucket.put(this.pointerKey, body, putOptions)
    } catch (error) {
      // The pointer read-back is the authoritative outcome, so a transient put
      // failure lands on 'conflict' (fail closed) like a real CAS loss; log the
      // cause so the two are still distinguishable in Worker logs.
      console.warn(
        `R2 pointer put failed for ${this.pointerKey}; verifying pointer state`,
        error instanceof Error ? error.message : error,
      )
      const after = await this.getCurrentRelease()
      if (releasePointersMatch(next, after)) return 'committed'
      return 'conflict'
    }

    const after = await this.getCurrentRelease()
    if (!releasePointersMatch(next, after)) return 'conflict'
    return 'committed'
  }
}
