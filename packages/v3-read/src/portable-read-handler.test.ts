import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assembleFullFetch } from '@airing-cal/bgm-api'
import { imageOriginalKey, imageThumbV1Key, imageThumbV2Key } from '@airing-cal/storage'
import {
  openBuilderDatabase,
  publishBuilderCheckpoint,
  runBuilderSyncJob,
  SqliteBuilderStateStore,
  SyncRunStore,
} from '@airing-cal/v3-builder'
import { FilesystemPublicStore, MemoryPublicStore, V2_CACHE_CONTROL } from '@airing-cal/v3-core'
import type { PublicReleasePointer, PublicStore } from '@airing-cal/v3-core/ports'
import { handlePortableReadRequest } from './portable-read-handler.ts'
import { readPortableCronStatus } from './portable-builder-cron.ts'
import { createVerifiedSnapshotCache } from './verified-snapshot-cache.ts'

function emptyFetch() {
  return assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 0, data: [] }] }],
    [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
    1_700_000_000,
  )
}

test('handlePortableReadRequest serves collections with v2 cache headers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-read-'))
  const publicStore = new FilesystemPublicStore(root)
  const db = openBuilderDatabase(':memory:')
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-1',
    mode: 'incremental',
    ownerToken: 'worker',
    fetchInput: async () => emptyFetch(),
    now: () => 1_700_000_000_000,
    projectFetchMediaHints: true,
  })
  await publishBuilderCheckpoint({
    state,
    publicStore,
    manifestMetadata: { source_observed_at: '2026-01-01T00:00:00.000Z', git_sha: 'a'.repeat(40) },
  })

  const response = await handlePortableReadRequest(
    new Request('https://local/api/collections?type=watching&page=1&limit=24'),
    { publicStore, nsfwShow: false },
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), V2_CACHE_CONTROL.collections)
  const body = await response.json() as { data: unknown[]; limit: number }
  assert.equal(body.limit, 24)
})

test('handlePortableReadRequest /version includes platform when env set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-read-version-'))
  const publicStore = new FilesystemPublicStore(root)
  const response = await handlePortableReadRequest(new Request('https://local/api/version'), {
    publicStore,
    processEnv: { AIRINGCAL_PLATFORM: 'portable' },
  })
  assert.equal(response.status, 200)
  const body = await response.json() as { platform?: string; read: string }
  assert.equal(body.read, 'portable')
  assert.equal(body.platform, 'portable')
})

test('handlePortableReadRequest serves JSON when the runtime lacks Response.json (EdgeOne)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-read-noresponsejson-'))
  const publicStore = new FilesystemPublicStore(root)
  const descriptor = Object.getOwnPropertyDescriptor(Response, 'json')
  Object.defineProperty(Response, 'json', { value: undefined, configurable: true, writable: true })
  try {
    const response = await handlePortableReadRequest(new Request('https://local/api/version'), {
      publicStore,
      processEnv: { AIRINGCAL_PLATFORM: 'edgeone' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
    const body = await response.json() as { platform?: string }
    assert.equal(body.platform, 'edgeone')
  } finally {
    if (descriptor) Object.defineProperty(Response, 'json', descriptor)
  }
})

test('handlePortableReadRequest /health reports compose-scheduler cron from SQLite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-read-health-'))
  const sqlitePath = join(root, 'builder.sqlite')
  const publicStore = new FilesystemPublicStore(root)
  const db = openBuilderDatabase(sqlitePath)
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-health',
    mode: 'incremental',
    ownerToken: 'worker',
    fetchInput: async () => emptyFetch(),
    now: () => 1_700_000_000_000,
  })
  await publishBuilderCheckpoint({
    state,
    publicStore,
    manifestMetadata: { source_observed_at: '2026-01-01T00:00:00.000Z', git_sha: 'c'.repeat(40) },
  })
  db.close()

  const response = await handlePortableReadRequest(new Request('https://local/api/health'), {
    publicStore,
    cronStatus: () => readPortableCronStatus({
      AIRINGCAL_BUILDER_SQLITE_PATH: sqlitePath,
      AIRINGCAL_SCHEDULER_DAILY_AT: '03:00',
    }),
  })
  assert.equal(response.status, 200)
  const body = await response.json() as { data: { cron: { scheduler: string; last: { status: string } | null } } }
  assert.equal(body.data.cron.scheduler, 'compose-scheduler')
  assert.equal(body.data.cron.last?.status, 'succeeded')

  const gatewayLike = await handlePortableReadRequest(new Request('https://local/api/health'), { publicStore })
  const gatewayLikeBody = await gatewayLike.json() as { data: { cron: { scheduler: string; next_at: string | null } } }
  assert.equal(gatewayLikeBody.data.cron.scheduler, 'external')
  assert.equal(gatewayLikeBody.data.cron.next_at, null)
})
test('image route redirects to the public base URL only for objects that exist (missing thumb is 404, not a CDN 302)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-read-image-'))
  const publicStore = new FilesystemPublicStore(root)
  const db = openBuilderDatabase(':memory:')
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-image',
    mode: 'incremental',
    ownerToken: 'worker',
    fetchInput: async () => emptyFetch(),
    now: () => 1_700_000_000_000,
  })
  await publishBuilderCheckpoint({
    state,
    publicStore,
    manifestMetadata: { source_observed_at: '2026-01-01T00:00:00.000Z', git_sha: 'd'.repeat(40) },
  })
  db.close()

  const hash = 'c'.repeat(64)
  const base = 'https://cdn.example.com'
  const imageRequest = (suffix: string) => new Request(`https://local/image/${hash}${suffix}`)

  for (const suffix of ['', '/thumb']) {
    const missing = await handlePortableReadRequest(imageRequest(suffix), { publicStore, publicBaseUrl: base })
    assert.equal(missing.status, 404, `missing${suffix} must 404 instead of redirecting to an absent CDN object`)
    assert.equal(missing.headers.get('Location'), null)
  }

  await publicStore.putImmutableObject(imageThumbV1Key(hash), new TextEncoder().encode('thumb-v1'), 'image/webp')
  const v1 = await handlePortableReadRequest(imageRequest('/thumb'), { publicStore, publicBaseUrl: base })
  assert.equal(v1.status, 302)
  assert.equal(v1.headers.get('Location'), `${base}/${imageThumbV1Key(hash)}`)

  await publicStore.putImmutableObject(imageThumbV2Key(hash), new TextEncoder().encode('thumb-v2'), 'image/webp')
  const v2 = await handlePortableReadRequest(imageRequest('/thumb'), { publicStore, publicBaseUrl: base })
  assert.equal(v2.headers.get('Location'), `${base}/${imageThumbV2Key(hash)}`)

  await publicStore.putImmutableObject(imageOriginalKey(hash), new TextEncoder().encode('original-bytes'), 'image/jpeg')
  const original = await handlePortableReadRequest(imageRequest(''), { publicStore, publicBaseUrl: base })
  assert.equal(original.status, 302)
  assert.equal(original.headers.get('Location'), `${base}/${imageOriginalKey(hash)}`)

  const served = await handlePortableReadRequest(imageRequest('/thumb'), { publicStore })
  assert.equal(served.status, 200)
  assert.equal(await served.text(), 'thumb-v2')
})

test('image redirect prefers imageBaseUrl over publicBaseUrl when set', async () => {
  const publicStore = new MemoryPublicStore()
  const hash = 'd'.repeat(64)
  await publicStore.putImmutableObject(imageOriginalKey(hash), new TextEncoder().encode('original'), 'image/jpeg')
  const publicBase = 'https://cdn.example.com'
  const imageBase = 'https://img.cdn.example.com'

  const preferred = await handlePortableReadRequest(
    new Request(`https://local/image/${hash}`),
    { publicStore, publicBaseUrl: publicBase, imageBaseUrl: imageBase },
  )
  assert.equal(preferred.status, 302)
  assert.equal(preferred.headers.get('Location'), `${imageBase}/${imageOriginalKey(hash)}`)

  const fallback = await handlePortableReadRequest(
    new Request(`https://local/image/${hash}`),
    { publicStore, publicBaseUrl: publicBase },
  )
  assert.equal(fallback.status, 302)
  assert.equal(fallback.headers.get('Location'), `${publicBase}/${imageOriginalKey(hash)}`)
})


test('image proxy honors Content-Type from store headObject', async () => {
  const inner = new MemoryPublicStore()
  const db = openBuilderDatabase(':memory:')
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-proxy-mime',
    mode: 'incremental',
    ownerToken: 'worker',
    fetchInput: async () => emptyFetch(),
    now: () => 1_700_000_000_000,
  })
  await publishBuilderCheckpoint({
    state,
    publicStore: inner,
    manifestMetadata: { source_observed_at: '2026-01-01T00:00:00.000Z', git_sha: 'e'.repeat(40) },
  })
  db.close()

  const hash = 'e'.repeat(64)
  const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
  await inner.putImmutableObject(imageOriginalKey(hash), pngBytes, 'image/png')

  const publicStore: PublicStore = {
    getCurrentRelease: () => inner.getCurrentRelease(),
    getSnapshotBytes: (ref) => inner.getSnapshotBytes(ref),
    putImmutableObject: (key, body, contentType) => inner.putImmutableObject(key, body, contentType),
    commitRelease: (expected, next) => inner.commitRelease(expected, next),
    async headObject(key) {
      const head = await inner.headObject(key)
      return head ? { ...head, contentType: 'image/png' } : null
    },
  }

  const response = await handlePortableReadRequest(
    new Request(`https://local/image/${hash}`),
    { publicStore },
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Content-Type'), 'image/png')
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), pngBytes)
})

test('image proxy sniffs bytes when HEAD Content-Type is missing or non-image', async () => {
  const inner = new MemoryPublicStore()
  await publishEmptyRelease(inner)
  const hash = 'c'.repeat(64)
  const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
  await inner.putImmutableObject(imageOriginalKey(hash), jpegBytes, 'application/octet-stream')

  const publicStore: PublicStore = {
    getCurrentRelease: () => inner.getCurrentRelease(),
    getSnapshotBytes: (ref) => inner.getSnapshotBytes(ref),
    putImmutableObject: (key, body, contentType) => inner.putImmutableObject(key, body, contentType),
    commitRelease: (expected, next) => inner.commitRelease(expected, next),
    async headObject(key) {
      const head = await inner.headObject(key)
      return head ? { ...head, contentType: 'application/octet-stream' } : null
    },
  }

  const response = await handlePortableReadRequest(
    new Request(`https://local/image/${hash}`),
    { publicStore },
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Content-Type'), 'image/jpeg')
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), jpegBytes)
})


function countingPublicStore(inner: MemoryPublicStore): PublicStore & {
  pointerReads: number
  byteReads: number
  resetCounts(): void
} {
  const store = {
    pointerReads: 0,
    byteReads: 0,
    resetCounts() {
      store.pointerReads = 0
      store.byteReads = 0
    },
    async getCurrentRelease() {
      store.pointerReads++
      return inner.getCurrentRelease()
    },
    async getSnapshotBytes(artifactRef: string) {
      store.byteReads++
      return inner.getSnapshotBytes(artifactRef)
    },
    putImmutableObject: (key: string, body: Uint8Array, contentType: string) =>
      inner.putImmutableObject(key, body, contentType),
    commitRelease: (expected: PublicReleasePointer | null, next: PublicReleasePointer) =>
      inner.commitRelease(expected, next),
    headObject: (key: string) => inner.headObject(key),
  }
  return store
}

async function publishEmptyRelease(publicStore: MemoryPublicStore): Promise<void> {
  const db = openBuilderDatabase(':memory:')
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-cache',
    mode: 'incremental',
    ownerToken: 'worker',
    fetchInput: async () => emptyFetch(),
    now: () => 1_700_000_000_000,
  })
  await publishBuilderCheckpoint({
    state,
    publicStore,
    manifestMetadata: { source_observed_at: '2026-01-01T00:00:00.000Z', git_sha: 'f'.repeat(40) },
  })
  db.close()
}

test('two sequential /api/collections with shared snapshotCache hit origin once', async () => {
  const inner = new MemoryPublicStore()
  await publishEmptyRelease(inner)
  const publicStore = countingPublicStore(inner)
  const snapshotCache = createVerifiedSnapshotCache({ softTtlMs: 60_000, now: () => 1_000 })
  const env = { publicStore, snapshotCache, nsfwShow: false }

  const first = await handlePortableReadRequest(
    new Request('https://local/api/collections?type=watching&page=1&limit=24'),
    env,
  )
  assert.equal(first.status, 200)
  assert.equal(publicStore.pointerReads, 1)
  assert.equal(publicStore.byteReads, 2)

  publicStore.resetCounts()
  const second = await handlePortableReadRequest(
    new Request('https://local/api/collections?type=watching&page=1&limit=24'),
    env,
  )
  assert.equal(second.status, 200)
  assert.equal(publicStore.pointerReads, 0)
  assert.equal(publicStore.byteReads, 0)
})

test('/image/:hash never loads the verified snapshot', async () => {
  const inner = new MemoryPublicStore()
  await publishEmptyRelease(inner)
  const hash = 'c'.repeat(64)
  await inner.putImmutableObject(imageOriginalKey(hash), new TextEncoder().encode('img'), 'image/jpeg')
  const publicStore = countingPublicStore(inner)
  const snapshotCache = createVerifiedSnapshotCache({ softTtlMs: 60_000, now: () => 1_000 })

  const response = await handlePortableReadRequest(
    new Request(`https://local/image/${hash}`),
    { publicStore, snapshotCache },
  )
  assert.equal(response.status, 200)
  assert.equal(publicStore.pointerReads, 0)
  assert.equal(publicStore.byteReads, 1, 'only the image object is fetched')
})

test('loader Error maps to 503 RELEASE_INVALID with no-store', async () => {
  const publicStore = new MemoryPublicStore()
  const snapshotCache = {
    async load() {
      throw new Error('Missing manifest object for current release: manifests/v1/x')
    },
    clear() {},
  }
  const response = await handlePortableReadRequest(
    new Request('https://local/api/collections?type=watching'),
    { publicStore, snapshotCache },
  )
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('Cache-Control'), V2_CACHE_CONTROL.error)
  const body = await response.json() as { ok: boolean; error: { code: string } }
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'RELEASE_INVALID')
})

test('image existence probe Error is not RELEASE_INVALID', async () => {
  const hash = 'a'.repeat(64)
  const publicStore = {
    async getCurrentRelease() {
      return null
    },
    async getSnapshotBytes() {
      throw new Error('R2 head failed')
    },
    async putImmutableObject() {},
    async headObject() {
      throw new Error('R2 head failed')
    },
  } as unknown as PublicStore

  await assert.rejects(
    () => handlePortableReadRequest(
      new Request(`https://local/image/${hash}`),
      { publicStore, publicBaseUrl: 'https://cdn.example' },
    ),
    (error: unknown) => error instanceof Error && error.message === 'R2 head failed',
  )
})
