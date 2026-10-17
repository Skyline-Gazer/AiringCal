import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleFullFetch } from '@airing-cal/bgm-api'
import {
  openBuilderDatabase,
  publishBuilderCheckpoint,
  runBuilderSyncJob,
  SqliteBuilderStateStore,
  SyncRunStore,
} from '@airing-cal/v3-builder'
import type {
  CloudflareR2BucketBinding,
  CloudflareR2ObjectBody,
  CloudflareR2PutOptions,
} from '@airing-cal/v3-adapters'
import { CloudflareR2PublicStore } from '@airing-cal/v3-adapters'
import { V2_CACHE_CONTROL } from '@airing-cal/v3-core'
import { handleCloudflareReadRequest } from './cloudflare-read-handler.ts'

class MemoryR2Object implements CloudflareR2ObjectBody {
  constructor(readonly bytes: Uint8Array) {}

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength)
  }
}

class MemoryR2Bucket implements CloudflareR2BucketBinding {
  objects = new Map<string, { bytes: Uint8Array; etag: string }>()
  private etagCounter = 0

  async get(key: string): Promise<CloudflareR2ObjectBody | null> {
    const entry = this.objects.get(key)
    return entry ? new MemoryR2Object(entry.bytes) : null
  }

  async head(key: string) {
    const entry = this.objects.get(key)
    return entry ? { etag: entry.etag } : null
  }

  async put(key: string, value: ArrayBuffer | Uint8Array | string, options?: CloudflareR2PutOptions): Promise<void> {
    const onlyIf = options?.onlyIf
    const existing = this.objects.get(key)
    if (onlyIf?.get('If-None-Match') === '*' && existing) throw new Error('PreconditionFailed')
    const ifMatch = onlyIf?.get('If-Match')
    if (ifMatch && (!existing || existing.etag !== ifMatch)) throw new Error('PreconditionFailed')
    const bytes = typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(value)
    this.etagCounter += 1
    this.objects.set(key, { bytes: new Uint8Array(bytes), etag: `etag-${this.etagCounter}` })
  }
}

function emptyFetch() {
  return assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 0, data: [] }] }],
    [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
    1_700_000_000,
  )
}

test('handleCloudflareReadRequest serves /api/collections from R2 PublicStore', async () => {
  const bucket = new MemoryR2Bucket()
  const publicStore = new CloudflareR2PublicStore(bucket)
  const db = openBuilderDatabase(':memory:')
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-cf',
    mode: 'incremental',
    ownerToken: 'worker',
    fetchInput: async () => emptyFetch(),
    now: () => 1_700_000_000_000,
  })
  await publishBuilderCheckpoint({
    state,
    publicStore,
    manifestMetadata: { source_observed_at: '2026-01-01T00:00:00.000Z', git_sha: 'b'.repeat(40) },
  })

  const response = await handleCloudflareReadRequest(
    new Request('https://worker.example/api/collections?type=watching&page=1&limit=24'),
    { publicR2: bucket, nsfwShow: false, packageVersion: '3.0.0-alpha.0' },
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), V2_CACHE_CONTROL.collections)

  const version = await handleCloudflareReadRequest(new Request('https://worker.example/api/version'), {
    publicR2: bucket,
  })
  const versionBody = await version.json() as { read: string; platform: string }
  assert.equal(versionBody.read, 'cloudflare')
  assert.equal(versionBody.platform, 'cloudflare')
})
