import assert from 'node:assert/strict'
import test from 'node:test'
import type { PublicReleasePointer } from '@airing-cal/v3-core'
import {
  CloudflareR2PublicStore,
  type CloudflareR2BucketBinding,
  type CloudflareR2HeadResult,
  type CloudflareR2ObjectBody,
  type CloudflareR2PutOptions,
} from './cloudflare-r2-public-store.ts'

class MemoryR2Object implements CloudflareR2ObjectBody {
  constructor(readonly bytes: Uint8Array) {}

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength)
  }
}

class MemoryR2Bucket implements CloudflareR2BucketBinding {
  objects = new Map<string, { bytes: Uint8Array; etag: string; contentType?: string }>()
  private etagCounter = 0

  async get(key: string): Promise<CloudflareR2ObjectBody | null> {
    const entry = this.objects.get(key)
    return entry ? new MemoryR2Object(entry.bytes) : null
  }

  async head(key: string): Promise<CloudflareR2HeadResult | null> {
    const entry = this.objects.get(key)
    return entry ? { etag: entry.etag } : null
  }

  async put(key: string, value: ArrayBuffer | Uint8Array | string, options?: CloudflareR2PutOptions): Promise<void> {
    const onlyIf = options?.onlyIf
    const existing = this.objects.get(key)
    if (onlyIf?.get('If-None-Match') === '*' && existing) {
      throw new Error('PreconditionFailed')
    }
    const ifMatch = onlyIf?.get('If-Match')
    if (ifMatch && (!existing || existing.etag !== ifMatch)) {
      throw new Error('PreconditionFailed')
    }
    const bytes = typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(value)
    this.etagCounter += 1
    this.objects.set(key, {
      bytes: new Uint8Array(bytes),
      etag: `etag-${this.etagCounter}`,
      contentType: options?.httpMetadata?.contentType,
    })
  }
}

function samplePointer(generation: number): PublicReleasePointer {
  return {
    schema_version: 1,
    generation,
    content_hash: `hash-${generation}`,
    published_at_unix: 1_700_000_000 + generation,
    artifact_ref: `snapshots/v1/${generation}-hash-${generation}.json`,
  }
}

test('CloudflareR2PublicStore enforces immutable objects and pointer CAS', async () => {
  const bucket = new MemoryR2Bucket()
  const store = new CloudflareR2PublicStore(bucket)
  const body = new TextEncoder().encode('{"schema_version":1}')
  await store.putImmutableObject('snapshots/v1/1-a.json', body, 'application/json')
  await store.putImmutableObject('snapshots/v1/1-a.json', body, 'application/json')
  const changed = new TextEncoder().encode('{"schema_version":2}')
  await assert.rejects(
    () => store.putImmutableObject('snapshots/v1/1-a.json', changed, 'application/json'),
    /different bytes/,
  )

  const first = samplePointer(1)
  assert.equal(await store.commitRelease(null, first), 'committed')
  assert.equal(await store.commitRelease(null, first), 'conflict')
  const second = samplePointer(2)
  assert.equal(await store.commitRelease(first, second), 'committed')
  assert.deepEqual(await store.getCurrentRelease(), second)
})
