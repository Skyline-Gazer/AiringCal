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
import worker from './index.ts'
import { isV3ReleaseReadPath, parseReadMode, resolveReadModeConfig } from './read-mode.ts'

const IMAGE_HASH = 'a'.repeat(64)

function collectionEntry(subjectId: number, title: string): BgmCollection {
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
      name: title,
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

function fetchFixture(subjectId: number, title: string) {
  return assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 1, data: [collectionEntry(subjectId, title)] }] }],
    [{
      weekday: { en: 'Sat', cn: '六', ja: '土', id: 6 },
      items: [{
        id: subjectId,
        type: 2,
        name: title,
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
      }],
    }],
    1_700_000_000,
  )
}

/**
 * Builder harness: keeps one SQLite checkpoint across runs so successive publishes
 * advance the generation exactly like the scheduled GHA writer does.
 */
function builderHarness() {
  const db = openBuilderDatabase(':memory:')
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  return {
    async publish(
      store: CloudflareR2PublicStore,
      options: { runId: string; subjectId: number; title: string; now: number },
    ): Promise<number> {
      await runBuilderSyncJob({
        state,
        runs,
        runId: options.runId,
        mode: 'incremental',
        ownerToken: 'parity-owner',
        fetchInput: async () => fetchFixture(options.subjectId, options.title),
        now: () => options.now,
        projectFetchMediaHints: true,
      })
      const published = await publishBuilderCheckpoint({
        state,
        publicStore: store,
        manifestMetadata: { source_observed_at: '2026-01-01T00:00:00.000Z', git_sha: 'c'.repeat(40) },
      })
      if (published.status !== 'published') {
        throw new Error(`builder publish failed: ${published.status} ${published.error ?? ''}`)
      }
      const pointer = await store.getCurrentRelease()
      if (!pointer) throw new Error('publish did not commit a release pointer')
      return pointer.generation
    },
    close(): void {
      db.close()
    },
  }
}

/** Counting wrapper: proves the legacy path never touches the public Release store. */
function countingBucket(bucket: MemoryR2Bucket) {
  const calls: string[] = []
  const originalGet = bucket.get.bind(bucket)
  const originalHead = bucket.head.bind(bucket)
  bucket.get = async (key: string) => {
    calls.push(key)
    return originalGet(key)
  }
  bucket.head = async (key: string) => {
    calls.push(key)
    return originalHead(key)
  }
  return calls
}

/** Legacy phase-0 env: KV snapshot + D1/R2 stubs. */
function legacyEnv() {
  const kv = new Map<string, unknown>([
    ['snapshot:collections:watching', [{ subject_id: 11, title: 'legacy-subject' }]],
    ['snapshot:summary', { watching: 1, _total: 1 }],
  ])
  return {
    AIRING_CAL_KV: {
      async get(key: string, type?: 'json') {
        const value = kv.get(key)
        if (type === 'json') return value ?? null
        return value == null ? null : JSON.stringify(value)
      },
      async put() {},
      async delete() {},
      async list() {
        return { keys: [], list_complete: true }
      },
    },
    AIRING_CAL_D1: {
      async getAppState() {
        return undefined
      },
      prepare() {
        return { bind() { return { async first() { return null } } } }
      },
    },
    AIRING_CAL_DATA_R2: { async get() { return null } },
    AIRING_CAL_R2: { async get() { return null } },
    NSFW_SHOW: 'true',
  }
}

function publishedRelease() {
  const bucket = new MemoryR2Bucket()
  const builder = builderHarness()
  return {
    bucket,
    store: new CloudflareR2PublicStore(bucket),
    builder,
  }
}

test('default read mode keeps the legacy path and never reads the public Release', async () => {
  const release = publishedRelease()
  await release.builder.publish(release.store, {
    runId: 'legacy-run',
    subjectId: 7,
    title: 'release-subject',
    now: 1_700_000_000_000,
  })
  release.builder.close()
  const releaseCalls = countingBucket(release.bucket)

  const env = { ...legacyEnv(), AIRINGCAL_PUBLIC_R2: release.bucket }
  const collections = await worker.fetch(
    new Request('https://read.local/api/collections?type=watching&page=1&limit=24'),
    env as never,
  )
  assert.equal(collections.status, 200)
  const body = await collections.json() as { data: Array<{ subject_id: number }>; types: Record<string, number> }
  assert.deepEqual(body.data.map((item) => item.subject_id), [11], 'legacy KV data is served')
  assert.deepEqual(body.types, { watching: 1, _total: 1 })
  assert.equal(collections.headers.get('Cache-Control'), 'public, max-age=30, s-maxage=300, stale-while-revalidate=120')
  assert.deepEqual(releaseCalls, [], 'the public Release store must stay untouched in legacy mode')

  const config = await worker.fetch(new Request('https://read.local/api/config'), env as never)
  assert.equal(config.status, 200)
  assert.deepEqual(releaseCalls, [], 'no public Release reads on other live routes either')
})

test('AIRINGCAL_READ_MODE=legacy is explicit legacy and stays unchanged', async () => {
  const env = { ...legacyEnv(), AIRINGCAL_READ_MODE: 'legacy' }
  const response = await worker.fetch(
    new Request('https://read.local/api/collections?type=watching'),
    env as never,
  )
  assert.equal(response.status, 200)
  const body = await response.json() as { data: Array<{ subject_id: number }> }
  assert.deepEqual(body.data.map((item) => item.subject_id), [11])
})

test('v3-release mode serves catalog, health and images from the current Release generation', async () => {
  const release = publishedRelease()
  const firstGeneration = await release.builder.publish(release.store, {
    runId: 'gen-1',
    subjectId: 7,
    title: 'release-subject',
    now: 1_700_000_000_000,
  })
  await release.store.putImmutableObject(
    `images/${IMAGE_HASH}/original`,
    new TextEncoder().encode('image-bytes'),
    'image/jpeg',
  )
  const env = {
    ...legacyEnv(),
    AIRINGCAL_READ_MODE: 'v3-release',
    AIRINGCAL_PUBLIC_R2: release.bucket,
    NSFW_SHOW: 'false',
  }

  const health = await worker.fetch(new Request('https://read.local/api/health'), env as never)
  assert.equal(health.status, 200)
  const healthBody = await health.json() as {
    ok: boolean
    data: { publish: { generation: number }; cron: { scheduler: string }; cache: { total_subjects: number } }
  }
  assert.equal(healthBody.ok, true)
  assert.equal(healthBody.data.cron.scheduler, 'external')
  assert.equal(healthBody.data.publish.generation, firstGeneration, 'health reports the pointer generation')

  const collections = await worker.fetch(
    new Request('https://read.local/api/collections?type=watching&page=1&limit=24'),
    env as never,
  )
  assert.equal(collections.status, 200)
  assert.equal(collections.headers.get('Cache-Control'), V2_CACHE_CONTROL.collections)
  const collectionsBody = await collections.json() as { data: Array<{ subject_id: number }>; types: Record<string, number> }
  assert.deepEqual(collectionsBody.data.map((item) => item.subject_id), [7])
  assert.equal(collectionsBody.types._total, 1)

  const calendar = await worker.fetch(new Request('https://read.local/api/calendar'), env as never)
  assert.equal(calendar.status, 200)
  assert.equal(calendar.headers.get('Cache-Control'), V2_CACHE_CONTROL.calendar)
  const calendarBody: unknown = await calendar.json()
  assert.ok(Array.isArray(calendarBody))
  assert.equal(calendarBody.length, 1)

  const config = await worker.fetch(new Request('https://read.local/api/config'), env as never)
  assert.deepEqual(await config.json(), { nsfw: false })

  const image = await worker.fetch(new Request(`https://read.local/image/${IMAGE_HASH}`), env as never)
  assert.equal(image.status, 200)
  assert.equal(await image.text(), 'image-bytes')

  const missingImage = await worker.fetch(new Request(`https://read.local/image/${'b'.repeat(64)}`), env as never)
  assert.equal(missingImage.status, 404)

  // A new Release generation must be served without a redeploy: same pointer, new data.
  const secondGeneration = await release.builder.publish(release.store, {
    runId: 'gen-2',
    subjectId: 8,
    title: 'release-subject-2',
    now: 1_700_003_600_000,
  })
  release.builder.close()
  assert.equal(secondGeneration, firstGeneration + 1)

  const advanced = await worker.fetch(new Request('https://read.local/api/health'), env as never)
  const advancedHealth = await advanced.json() as { data: { publish: { generation: number } } }
  assert.equal(advancedHealth.data.publish.generation, secondGeneration)

  const advancedCollections = await worker.fetch(
    new Request('https://read.local/api/collections?type=watching'),
    env as never,
  )
  const advancedBody = await advancedCollections.json() as { data: Array<{ subject_id: number }> }
  assert.deepEqual(advancedBody.data.map((item) => item.subject_id), [8], 'reads follow the current pointer generation')
})

test('v3-release mode redirects images to a validated public base URL only when the object exists', async () => {
  const release = publishedRelease()
  await release.builder.publish(release.store, {
    runId: 'redirect-run',
    subjectId: 7,
    title: 'release-subject',
    now: 1_700_000_000_000,
  })
  release.builder.close()
  const env = {
    AIRINGCAL_READ_MODE: 'v3-release',
    AIRINGCAL_PUBLIC_BASE_URL: 'https://cdn.example.com/',
    AIRINGCAL_PUBLIC_R2: release.bucket,
  }

  // The thumbnail is optional: without it the Worker must answer itself instead of
  // bouncing the client to a CDN key that 404s.
  const missingThumb = await worker.fetch(new Request(`https://read.local/image/${IMAGE_HASH}/thumb`), env as never)
  assert.equal(missingThumb.status, 404)
  assert.equal(missingThumb.headers.get('Location'), null)

  await release.store.putImmutableObject(
    `images/${IMAGE_HASH}/original`,
    new TextEncoder().encode('image-bytes'),
    'image/jpeg',
  )
  const image = await worker.fetch(new Request(`https://read.local/image/${IMAGE_HASH}`), env as never)
  assert.equal(image.status, 302)
  assert.equal(image.headers.get('Location'), `https://cdn.example.com/images/${IMAGE_HASH}/original`)

  await release.store.putImmutableObject(
    `images/${IMAGE_HASH}/thumb.v2.webp`,
    new TextEncoder().encode('thumb-bytes'),
    'image/webp',
  )
  const thumb = await worker.fetch(new Request(`https://read.local/image/${IMAGE_HASH}/thumb`), env as never)
  assert.equal(thumb.status, 302)
  assert.equal(thumb.headers.get('Location'), `https://cdn.example.com/images/${IMAGE_HASH}/thumb.v2.webp`)
})

test('v3-release mode rejects placeholder base URLs at configuration time', async () => {
  const env = {
    AIRINGCAL_READ_MODE: 'v3-release',
    AIRINGCAL_PUBLIC_BASE_URL: 'https://PLACEHOLDER_PUBLIC_CDN',
    AIRINGCAL_PUBLIC_R2: new MemoryR2Bucket(),
  }
  const api = await worker.fetch(new Request('https://read.local/api/health'), env as never)
  assert.equal(api.status, 503)
  const apiBody = await api.json() as { error: { code: string; message: string } }
  assert.equal(apiBody.error.code, 'INVALID_READ_CONFIG')
  assert.match(apiBody.error.message, /placeholder value/i)

  const page = await worker.fetch(new Request('https://read.local/'), env as never)
  assert.equal(page.status, 503, 'a misconfigured deployment fails before serving any route')
})

test('unknown read modes fail closed with an explicit code', async () => {
  const response = await worker.fetch(
    new Request('https://read.local/api/collections?type=watching'),
    { AIRINGCAL_READ_MODE: 'release', ...legacyEnv() } as never,
  )
  assert.equal(response.status, 503)
  const body = await response.json() as { error: { code: string; message: string } }
  assert.equal(body.error.code, 'INVALID_READ_CONFIG')
  assert.match(body.error.message, /AIRINGCAL_READ_MODE must be one of legacy\|v3-release/)
})

test('v3-release mode fails closed without the public Release binding', async () => {
  const response = await worker.fetch(
    new Request('https://read.local/api/collections?type=watching'),
    { AIRINGCAL_READ_MODE: 'v3-release' } as never,
  )
  assert.equal(response.status, 503)
  const body = await response.json() as { error: { code: string } }
  assert.equal(body.error.code, 'NO_PUBLIC_STORE_BINDING')
  assert.equal(response.headers.get('Cache-Control'), V2_CACHE_CONTROL.error)
})

test('v3-release mode fails closed without a published Release instead of using legacy KV', async () => {
  const env = {
    ...legacyEnv(),
    AIRINGCAL_READ_MODE: 'v3-release',
    AIRINGCAL_PUBLIC_R2: new MemoryR2Bucket(),
  }
  const collections = await worker.fetch(
    new Request('https://read.local/api/collections?type=watching'),
    env as never,
  )
  assert.equal(collections.status, 503)
  const health = await worker.fetch(new Request('https://read.local/api/health'), env as never)
  assert.equal(health.status, 503)
  const body = await health.json() as { error: { code: string } }
  assert.equal(body.error.code, 'NO_RELEASE')
})

test('read mode parsing accepts only documented values', () => {
  assert.equal(parseReadMode(undefined), 'legacy')
  assert.equal(parseReadMode(''), 'legacy')
  assert.equal(parseReadMode(' legacy '), 'legacy')
  assert.equal(parseReadMode('v3-release'), 'v3-release')
  assert.throws(() => parseReadMode('release'), /AIRINGCAL_READ_MODE must be one of legacy\|v3-release/)
  assert.deepEqual(resolveReadModeConfig({}), { mode: 'legacy' })
  assert.deepEqual(
    resolveReadModeConfig({ AIRINGCAL_READ_MODE: 'v3-release' }),
    { mode: 'v3-release', publicBaseUrl: undefined },
  )
  assert.deepEqual(
    resolveReadModeConfig({
      AIRINGCAL_READ_MODE: 'v3-release',
      AIRINGCAL_PUBLIC_BASE_URL: 'https://cdn.example.com/airingcal/',
    }),
    { mode: 'v3-release', publicBaseUrl: 'https://cdn.example.com/airingcal' },
  )
  assert.equal(isV3ReleaseReadPath('/api/collections'), true)
  assert.equal(isV3ReleaseReadPath(`/image/${'a'.repeat(64)}`), true)
  assert.equal(isV3ReleaseReadPath('/api/version'), false, '/api/version keeps build metadata')
  assert.equal(isV3ReleaseReadPath('/api/thumb-gen'), false, 'thumb-gen stays a legacy write endpoint')
  assert.equal(isV3ReleaseReadPath('/'), false)
})
