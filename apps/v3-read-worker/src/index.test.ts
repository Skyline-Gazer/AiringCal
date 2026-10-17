import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleFullFetch } from '@airing-cal/bgm-api'
import { CloudflareR2PublicStore } from '@airing-cal/v3-adapters/cloudflare-r2-public-store'
import { MemoryR2Bucket } from '@airing-cal/v3-adapters/memory-r2-binding'
import {
  openBuilderDatabase,
  publishBuilderCheckpoint,
  runBuilderSyncJob,
  SqliteBuilderStateStore,
  SyncRunStore,
} from '@airing-cal/v3-builder'
import { V2_CACHE_CONTROL } from '@airing-cal/v3-core/read-contract'
import { handleReadWorkerRequest } from './index.ts'

function emptyFetch() {
  return assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 0, data: [] }] }],
    [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
    1_700_000_000,
  )
}

/** Publishes a real builder checkpoint into a memory R2 bucket, as the operator publish path does. */
async function publishedBucket(): Promise<MemoryR2Bucket> {
  const bucket = new MemoryR2Bucket()
  const db = openBuilderDatabase(':memory:')
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-worker',
    mode: 'incremental',
    ownerToken: 'worker',
    fetchInput: async () => emptyFetch(),
    now: () => 1_700_000_000_000,
  })
  await publishBuilderCheckpoint({
    state,
    publicStore: new CloudflareR2PublicStore(bucket),
    manifestMetadata: { source_observed_at: '2026-01-01T00:00:00.000Z', git_sha: 'd'.repeat(40) },
  })
  db.close()
  return bucket
}

test('worker serves v2 read routes from the R2 public store', async () => {
  const bucket = await publishedBucket()
  const env = { AIRINGCAL_PUBLIC_R2: bucket, BANGUMI_GIT_COMMIT_SHA: 'd'.repeat(40) }

  const health = await handleReadWorkerRequest(new Request('https://worker.example/api/health'), env)
  assert.equal(health.status, 200)
  const healthBody = await health.json() as {
    data: { cron: { scheduler: string }; publish: { generation: number | null } }
  }
  assert.equal(healthBody.data.cron.scheduler, 'external')

  const collections = await handleReadWorkerRequest(
    new Request('https://worker.example/api/collections?type=watching&page=1&limit=24'),
    env,
  )
  assert.equal(collections.status, 200)
  assert.equal(collections.headers.get('Cache-Control'), V2_CACHE_CONTROL.collections)

  const calendar = await handleReadWorkerRequest(new Request('https://worker.example/api/calendar'), env)
  assert.equal(calendar.status, 200)
  assert.equal(calendar.headers.get('Cache-Control'), V2_CACHE_CONTROL.calendar)

  const version = await handleReadWorkerRequest(new Request('https://worker.example/api/version'), env)
  const versionBody = await version.json() as { read: string; platform: string }
  assert.equal(versionBody.read, 'cloudflare')
  assert.equal(versionBody.platform, 'cloudflare')
})

test('worker serves widget assets, 410 sync routes, and R2 images', async () => {
  const bucket = await publishedBucket()
  const env = { AIRINGCAL_PUBLIC_R2: bucket, BANGUMI_GIT_COMMIT_SHA: 'e'.repeat(40) }

  const index = await handleReadWorkerRequest(new Request('https://worker.example/'), env)
  assert.equal(index.status, 200)
  assert.equal(index.headers.get('Content-Type'), 'text/html; charset=utf-8')
  assert.match(await index.text(), /Build e{7}/)

  const widget = await handleReadWorkerRequest(new Request('https://worker.example/src/bangumi.js'), env)
  assert.equal(widget.status, 200)

  const deprecated = await handleReadWorkerRequest(new Request('https://worker.example/api/sync/apply'), env)
  assert.equal(deprecated.status, 410)
  assert.equal(deprecated.headers.get('Cache-Control'), V2_CACHE_CONTROL.error)

  const hash = 'a'.repeat(64)
  const bytes = new TextEncoder().encode('image-bytes')
  bucket.objects.set(`images/${hash}/original`, { bytes, etag: 'seeded' })
  const image = await handleReadWorkerRequest(new Request(`https://worker.example/image/${hash}`), env)
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('Cache-Control'), V2_CACHE_CONTROL.image)
  assert.equal(await image.text(), 'image-bytes')

  const missing = await handleReadWorkerRequest(new Request(`https://worker.example/image/${'b'.repeat(64)}`), env)
  assert.equal(missing.status, 404)
})

test('worker fails closed when the pointer cannot be verified', async () => {
  const bucket = new MemoryR2Bucket()
  const env = { AIRINGCAL_PUBLIC_R2: bucket }
  const collections = await handleReadWorkerRequest(
    new Request('https://worker.example/api/collections?type=watching'),
    env,
  )
  assert.equal(collections.status, 503)
  const health = await handleReadWorkerRequest(new Request('https://worker.example/api/health'), env)
  assert.equal(health.status, 503)
})
