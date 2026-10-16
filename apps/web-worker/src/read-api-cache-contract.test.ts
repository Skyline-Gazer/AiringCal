import assert from 'node:assert/strict'
import test from 'node:test'
import { V2_CACHE_CONTROL } from '@airing-cal/v3-core/read-contract'
import { buildPublicSnapshot } from '@airing-cal/domain'
import type { PublicCollectionItemV1 } from '@airing-cal/storage'
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

const hash = 'd'.repeat(64)

function collectionItem(): PublicCollectionItemV1 {
  return {
    subject_id: 42,
    name: 'Contract',
    name_cn: '契约',
    summary: 'summary',
    images: { common: { hash, uri: `/image/${hash}`, r2_key: `images/${hash}/original` }, large: null },
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

async function seedR2Snapshot(kv: MockKV, r2: FakeR2) {
  const item = collectionItem()
  const snapshot = await buildPublicSnapshot({
    collections: [item],
    calendar: [{
      weekday: { en: 'Mon', cn: '星期一', ja: '月', id: 1 },
      items: [{
        subject_id: item.subject_id,
        id: item.subject_id,
        type: item.type,
        name: item.name,
        name_cn: item.name_cn,
        summary: item.summary,
        images: item.images,
        image_status: item.image_status,
        nsfw: item.nsfw,
        date: item.date,
        eps: item.eps,
        total_episodes: item.total_episodes,
        rating: item.rating,
      }],
    }],
    published_at: 1_722_000_000,
  }, 3)
  kv.values.set('public:read-mode', { mode: 'r2', switched_at: 1 })
  kv.values.set('public:current', {
    schema_version: 1,
    generation: snapshot.generation,
    content_hash: snapshot.content_hash,
    r2_key: `snapshots/v1/${snapshot.generation}-${snapshot.content_hash}.json`,
    published_at: snapshot.published_at,
  })
  r2.objects.set(`snapshots/v1/${snapshot.generation}-${snapshot.content_hash}.json`, JSON.stringify(snapshot))
}

test('GET /api/collections Cache-Control matches v2 contract', async () => {
  const kv = new MockKV()
  const r2 = new FakeR2()
  await seedR2Snapshot(kv, r2)
  const response = await worker.fetch(new Request('https://read.local/api/collections?type=watching'), {
    AIRING_CAL_KV: kv,
    AIRING_CAL_DATA_R2: r2,
  } as any)
  assert.equal(response.headers.get('Cache-Control'), V2_CACHE_CONTROL.collections)
})

test('GET /api/calendar Cache-Control matches v2 contract', async () => {
  const kv = new MockKV()
  const r2 = new FakeR2()
  await seedR2Snapshot(kv, r2)
  const response = await worker.fetch(new Request('https://read.local/api/calendar'), {
    AIRING_CAL_KV: kv,
    AIRING_CAL_DATA_R2: r2,
  } as any)
  assert.equal(response.headers.get('Cache-Control'), V2_CACHE_CONTROL.calendar)
})

test('GET /api/config Cache-Control matches v2 contract', async () => {
  const response = await worker.fetch(new Request('https://read.local/api/config'), {} as any)
  assert.equal(response.headers.get('Cache-Control'), V2_CACHE_CONTROL.config)
})
