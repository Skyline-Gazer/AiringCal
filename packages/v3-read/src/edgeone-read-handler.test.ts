import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleFullFetch, type BgmCollection } from '@airing-cal/bgm-api'
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
import { createCloudflareReadHandler } from './cloudflare-read-handler.ts'
import { createEdgeOneReadHandler } from './edgeone-read-handler.ts'

const BASE_URL = 'https://public.example.com'
const IMAGE_HASH = 'a'.repeat(64)

function collectionEntry(subjectId: number): BgmCollection {
  return {
    subject_id: subjectId,
    subject_type: 2,
    rate: 7,
    type: 3,
    comment: '',
    tags: ['x'],
    ep_status: 3,
    vol_status: 0,
    updated_at: '2026-01-01T00:00:00.000Z',
    private: false,
    subject: {
      id: subjectId,
      type: 2,
      name: `Subject ${subjectId}`,
      name_cn: '中文',
      summary: 'summary',
      nsfw: false,
      date: '2026-01-01',
      eps: 12,
      total_episodes: 12,
      images: {
        large: 'https://lain.bgm.tv/pic/cover/l/large.jpg',
        common: 'https://lain.bgm.tv/pic/cover/c/common.jpg',
        medium: 'https://lain.bgm.tv/pic/cover/c/common.jpg',
        small: 'https://lain.bgm.tv/pic/cover/c/common.jpg',
        grid: 'https://lain.bgm.tv/pic/cover/c/common.jpg',
      },
      rating: { score: 7, rank: 100, total: 10 },
    },
  }
}

function fetchFixture() {
  return assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 1, data: [collectionEntry(7)] }] }],
    [{ weekday: { en: 'Sat', cn: '六', ja: '土', id: 6 }, items: [] }],
    1_700_000_000,
  )
}

/** Publishes a real builder checkpoint into the R2 public store the GHA writer owns. */
async function publishedBucket(): Promise<{ bucket: MemoryR2Bucket; store: CloudflareR2PublicStore }> {
  const bucket = new MemoryR2Bucket()
  const store = new CloudflareR2PublicStore(bucket)
  const db = openBuilderDatabase(':memory:')
  try {
    const state = new SqliteBuilderStateStore(db)
    const runs = new SyncRunStore(db)
    await runBuilderSyncJob({
      state,
      runs,
      runId: 'edgeone-read',
      mode: 'incremental',
      ownerToken: 'edgeone',
      fetchInput: async () => fetchFixture(),
      now: () => 1_700_000_000_000,
      projectFetchMediaHints: true,
    })
    const published = await publishBuilderCheckpoint({
      state,
      publicStore: store,
      manifestMetadata: { source_observed_at: '2026-01-01T00:00:00.000Z', git_sha: 'e'.repeat(40) },
    })
    assert.equal(published.status, 'published')
  } finally {
    db.close()
  }
  await store.putImmutableObject(
    `images/${IMAGE_HASH}/original`,
    new TextEncoder().encode('image-bytes'),
    'image/jpeg',
  )
  return { bucket, store }
}

/** Fake CDN: serves the public Release objects over `https://public.example.com/<key>`. */
function cdnFetch(store: CloudflareR2PublicStore) {
  const requests: string[] = []
  const impl = (async (input: unknown) => {
    const url = new URL(String(input))
    requests.push(url.toString())
    const key = decodeURIComponent(url.pathname.slice(1))
    const bytes = await store.getSnapshotBytes(key)
    if (!bytes) return new Response('Not found', { status: 404 })
    return new Response(new Uint8Array(bytes), { status: 200 })
  }) as unknown as typeof fetch
  return { impl, requests }
}

test('EdgeOne read gateway serves the v2 surface from the public Release over HTTPS', async () => {
  const { store } = await publishedBucket()
  const { impl, requests } = cdnFetch(store)
  const handle = createEdgeOneReadHandler({
    publicBaseUrl: BASE_URL,
    nsfwShow: false,
    packageVersion: '3.0.0-alpha.0',
    fetch: impl,
  })

  const health = await handle(new Request('https://edgeone.example/api/health'))
  assert.equal(health.status, 200)
  const healthBody = await health.json() as {
    ok: boolean
    data: { cron: { scheduler: string }; publish: { generation: number; content_hash: string }; cache: { total_subjects: number } }
  }
  assert.equal(healthBody.ok, true)
  assert.equal(healthBody.data.cron.scheduler, 'external')
  assert.equal(healthBody.data.cache.total_subjects, 1)

  const pointer = await store.getCurrentRelease()
  assert.equal(healthBody.data.publish.generation, pointer?.generation, 'health reports the current pointer generation')
  assert.equal(healthBody.data.publish.content_hash, pointer?.content_hash)

  const collections = await handle(
    new Request('https://edgeone.example/api/collections?type=watching&page=1&limit=24'),
  )
  assert.equal(collections.status, 200)
  assert.equal(collections.headers.get('Cache-Control'), V2_CACHE_CONTROL.collections)
  const collectionsBody = await collections.json() as { data: Array<{ subject_id: number }>; limit: number }
  assert.deepEqual(collectionsBody.data.map((item) => item.subject_id), [7])

  const calendar = await handle(new Request('https://edgeone.example/api/calendar'))
  assert.equal(calendar.status, 200)
  assert.equal(calendar.headers.get('Cache-Control'), V2_CACHE_CONTROL.calendar)

  const version = await handle(new Request('https://edgeone.example/api/version'))
  assert.deepEqual(await version.json(), {
    app: 'airingcal',
    read: 'edgeone',
    package: '3.0.0-alpha.0',
    platform: 'edgeone',
  })

  // Images 302 to the same public base URL instead of proxying bytes.
  const image = await handle(new Request(`https://edgeone.example/image/${IMAGE_HASH}`))
  assert.equal(image.status, 302)
  assert.equal(image.headers.get('Location'), `${BASE_URL}/images/${IMAGE_HASH}/original`)

  // The manifest_ref from the current pointer is fetched over HTTPS (C1 read path).
  assert.ok(pointer?.manifest_ref)
  assert.ok(
    requests.includes(`${BASE_URL}/${pointer.manifest_ref}`),
    `expected an HTTPS fetch of ${pointer.manifest_ref}, saw ${requests.join(', ')}`,
  )
  assert.ok(requests.includes(`${BASE_URL}/public/current-release.json`))
})

test('EdgeOne gateway and Cloudflare gateway serve the same Release consistently', async () => {
  const { bucket, store } = await publishedBucket()
  const { impl } = cdnFetch(store)
  const handleEdgeOne = createEdgeOneReadHandler({
    publicBaseUrl: BASE_URL,
    nsfwShow: false,
    packageVersion: '3.0.0-alpha.0',
    fetch: impl,
  })
  const handleCloudflare = createCloudflareReadHandler({
    publicR2: bucket,
    nsfwShow: false,
    packageVersion: '3.0.0-alpha.0',
  })

  for (const route of [
    '/api/collections?type=watching&page=1&limit=24',
    '/api/calendar',
    '/api/cache?limit=24',
    '/api/health',
  ]) {
    const edgeoneResponse = await handleEdgeOne(new Request(`https://parity.example${route}`))
    const cloudflareResponse = await handleCloudflare(new Request(`https://parity.example${route}`))
    assert.equal(edgeoneResponse.status, cloudflareResponse.status, `${route} status`)
    assert.equal(
      edgeoneResponse.headers.get('Cache-Control'),
      cloudflareResponse.headers.get('Cache-Control'),
      `${route} Cache-Control`,
    )
    const [edgeoneText, cloudflareText] = await Promise.all([edgeoneResponse.text(), cloudflareResponse.text()])
    assert.equal(edgeoneText, cloudflareText, `${route} payload must match the Cloudflare gateway`)
  }
})

test('EdgeOne read gateway fails closed without a published pointer', async () => {
  const { impl } = cdnFetch(new CloudflareR2PublicStore(new MemoryR2Bucket()))
  const handle = createEdgeOneReadHandler({ publicBaseUrl: BASE_URL, fetch: impl })
  const collections = await handle(new Request('https://edgeone.example/api/collections?type=watching'))
  assert.equal(collections.status, 503)
  const health = await handle(new Request('https://edgeone.example/api/health'))
  assert.equal(health.status, 503)
})

test('EdgeOne read configuration rejects missing, non-https and placeholder base URLs', () => {
  assert.throws(() => createEdgeOneReadHandler({ publicBaseUrl: '' }), /required/)
  assert.throws(
    () => createEdgeOneReadHandler({ publicBaseUrl: 'https://PLACEHOLDER_PUBLIC_CDN' }),
    /placeholder value/i,
  )
  assert.throws(
    () => createEdgeOneReadHandler({ publicBaseUrl: 'http://public.example.com' }),
    /must use https/,
  )
})
