import assert from 'node:assert/strict'
import test from 'node:test'
import { buildManifest, buildPublicSnapshot } from '@airing-cal/domain'
import type { PublicCollectionItemV1, PublicSnapshotV1 } from '@airing-cal/storage'
import worker from './index.ts'

class MockKV {
  values = new Map<string, unknown>()

  async get(key: string, type?: 'json') {
    const value = this.values.get(key)
    if (type === 'json') return value ?? null
    return value == null ? null : JSON.stringify(value)
  }

  async put(key: string, value: string) {
    this.values.set(key, JSON.parse(value))
  }

  async delete(key: string) {
    this.values.delete(key)
  }
}

class FakeR2 {
  objects = new Map<string, string>()

  async get(key: string) {
    const bytes = this.objects.get(key)
    if (bytes === undefined) return null
    return { key, text: async () => bytes }
  }
}

const hash = 'a'.repeat(64)

function collectionItem(subjectId: number): PublicCollectionItemV1 {
  return {
    subject_id: subjectId,
    name: `Subject ${subjectId}`,
    name_cn: `条目 ${subjectId}`,
    summary: 'summary',
    images: {
      common: { hash, uri: `/image/${hash}`, r2_key: `images/${hash}/original` },
      large: null,
    },
    image_status: { common: 'cached', large: 'pending_next_cron' },
    eps: 12,
    total_episodes: 12,
    ep_status: 2,
    vol_status: 0,
    type: 2,
    collection_type: 3,
    rate: 8,
    nsfw: false,
    date: '2026-07-27',
    tags: ['daily'],
    updated_at: '2026-07-27T00:00:00Z',
    rating: { score: 8.1, rank: 12, total: 340 },
  }
}

async function fixtureSnapshot(): Promise<PublicSnapshotV1> {
  return buildPublicSnapshot({
    collections: [collectionItem(23080)],
    calendar: [{
      weekday: { en: 'Mon', cn: '星期一', ja: '月', id: 1 },
      items: [{
        subject_id: 23080,
        id: 23080,
        type: 2,
        name: 'Calendar A',
        name_cn: '日历 A',
        summary: '',
        images: { common: null, large: null },
        image_status: { common: 'pending_next_cron', large: 'failed' },
        nsfw: true,
        date: '2026-07-27',
        eps: 12,
        total_episodes: 12,
        rating: { score: 7.2, rank: 5, total: 99 },
      }],
    }],
    published_at: 1_722_000_000,
  }, 9)
}

test('R2 collections keep the legacy image_status and rating contract', async () => {
  const kv = new MockKV()
  const snapshot = await fixtureSnapshot()
  const manifest = buildManifest(snapshot, {
    source_observed_at: '2026-07-27T00:00:00.000Z',
    git_sha: 'a'.repeat(40),
  })
  const r2 = new FakeR2()
  r2.objects.set('public/manifest.json', JSON.stringify(manifest))
  r2.objects.set(manifest.snapshot_key, JSON.stringify(snapshot))

  const response = await worker.fetch(new Request('https://read.local/collections?type=watching&page=1&limit=24'), {
    AIRING_CAL_KV: kv,
    AIRING_CAL_DATA_R2: r2,
  } as any)
  const body = await response.json() as any

  assert.equal(response.status, 200)
  assert.equal(body.total, 1)
  assert.equal(body.data[0].subject_id, 23080)
  assert.equal(body.data[0].images.common.uri, `/image/${hash}`)
  assert.deepEqual(body.data[0].image_status, { common: 'cached', large: 'pending_next_cron' })
  assert.deepEqual(body.data[0].rating, { score: 8.1, rank: 12, total: 340 })
  assert.deepEqual(body.types, { want: 0, watched: 0, watching: 1, on_hold: 0, dropped: 0, _total: 1 })
})

test('R2 calendar keeps the legacy image_status and rating contract', async () => {
  const kv = new MockKV()
  const snapshot = await fixtureSnapshot()
  const manifest = buildManifest(snapshot, {
    source_observed_at: '2026-07-27T00:00:00.000Z',
    git_sha: 'a'.repeat(40),
  })
  const r2 = new FakeR2()
  r2.objects.set('public/manifest.json', JSON.stringify(manifest))
  r2.objects.set(manifest.snapshot_key, JSON.stringify(snapshot))

  const response = await worker.fetch(new Request('https://read.local/calendar'), {
    AIRING_CAL_KV: kv,
    AIRING_CAL_DATA_R2: r2,
  } as any)
  const body = await response.json() as any

  assert.equal(response.status, 200)
  assert.equal(body[0].items[0].subject_id, 23080)
  assert.deepEqual(body[0].items[0].image_status, { common: 'pending_next_cron', large: 'failed' })
  assert.deepEqual(body[0].items[0].rating, { score: 7.2, rank: 5, total: 99 })
})

test('R2 collections fall back to the legacy manifest when the snapshot object is missing', async () => {
  const kv = new MockKV()
  const snapshot = await fixtureSnapshot()
  kv.values.set('public:read-mode', { mode: 'r2', switched_at: 1_234 })
  kv.values.set('public:current', {
    schema_version: 1,
    generation: snapshot.generation,
    content_hash: snapshot.content_hash,
    r2_key: `snapshots/v1/${snapshot.generation}-${snapshot.content_hash}.json`,
    published_at: snapshot.published_at,
  })
  kv.values.set('snapshot:collections:watching', [{
    subject_id: 23080,
    name: 'Legacy A',
    name_cn: '旧 A',
    images: { common: null, large: null },
  }])
  kv.values.set('snapshot:summary', { watching: 1, _total: 1 })

  const response = await worker.fetch(new Request('https://read.local/collections?type=watching'), {
    AIRING_CAL_KV: kv,
    AIRING_CAL_DATA_R2: new FakeR2(),
  } as any)
  const body = await response.json() as any

  assert.equal(response.status, 200)
  assert.equal(body.data[0].name, 'Legacy A')
  assert.equal(body.total, 1)
})
