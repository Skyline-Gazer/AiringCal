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
import { MemoryR2Bucket } from '@airing-cal/v3-adapters/memory-r2-binding'
import { CloudflareR2PublicStore } from '@airing-cal/v3-adapters'
import { V2_CACHE_CONTROL } from '@airing-cal/v3-core/read-contract'
import { createCloudflareReadHandler } from './cloudflare-read-handler.ts'

function emptyFetch() {
  return assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 0, data: [] }] }],
    [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
    1_700_000_000,
  )
}

async function publishedBucket(): Promise<MemoryR2Bucket> {
  const bucket = new MemoryR2Bucket()
  const publicStore = new CloudflareR2PublicStore(bucket)
  const db = openBuilderDatabase(':memory:')
  try {
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
  } finally {
    db.close()
  }
  return bucket
}

test('cloudflare read handler serves /api/collections from the R2 PublicStore', async () => {
  const bucket = await publishedBucket()
  const handle = createCloudflareReadHandler({
    publicR2: bucket,
    nsfwShow: false,
    packageVersion: '3.0.0-alpha.0',
  })

  const response = await handle(
    new Request('https://worker.example/api/collections?type=watching&page=1&limit=24'),
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), V2_CACHE_CONTROL.collections)

  const version = await handle(new Request('https://worker.example/api/version'))
  const versionBody = await version.json() as { read: string; platform: string }
  assert.equal(versionBody.read, 'cloudflare')
  assert.equal(versionBody.platform, 'cloudflare')
})

test('cloudflare read handler redirects images through a validated public base URL only when the object exists', async () => {
  const bucket = await publishedBucket()
  const store = new CloudflareR2PublicStore(bucket)
  const handle = createCloudflareReadHandler({
    publicR2: bucket,
    publicBaseUrl: 'https://cdn.example.com/',
  })
  const hash = 'a'.repeat(64)

  // Nothing published under this hash: the gateway must answer itself instead of
  // handing the client a CDN URL that 404s.
  const missing = await handle(new Request(`https://worker.example/image/${hash}/thumb`))
  assert.equal(missing.status, 404)
  assert.equal(missing.headers.get('Location'), null)

  await store.putImmutableObject(`images/${hash}/original`, new Uint8Array([1, 2, 3]), 'image/jpeg')
  const original = await handle(new Request(`https://worker.example/image/${hash}`))
  assert.equal(original.status, 302)
  assert.equal(original.headers.get('Location'), `https://cdn.example.com/images/${hash}/original`)

  await store.putImmutableObject(`images/${hash}/thumb.v1.webp`, new Uint8Array([4]), 'image/webp')
  const v1Thumb = await handle(new Request(`https://worker.example/image/${hash}/thumb`))
  assert.equal(v1Thumb.headers.get('Location'), `https://cdn.example.com/images/${hash}/thumb.v1.webp`)

  await store.putImmutableObject(`images/${hash}/thumb.v2.webp`, new Uint8Array([5]), 'image/webp')
  const v2Thumb = await handle(new Request(`https://worker.example/image/${hash}/thumb`))
  assert.equal(v2Thumb.headers.get('Location'), `https://cdn.example.com/images/${hash}/thumb.v2.webp`)
})

test('cloudflare read handler rejects a placeholder base URL at config time', async () => {
  const bucket = await publishedBucket()
  assert.throws(
    () => createCloudflareReadHandler({
      publicR2: bucket,
      publicBaseUrl: 'https://PLACEHOLDER_PUBLIC_CDN',
    }),
    /placeholder value/i,
  )
  assert.throws(
    () => createCloudflareReadHandler({ publicR2: bucket, publicBaseUrl: 'http://cdn.example.com' }),
    /must use https/,
  )
})
