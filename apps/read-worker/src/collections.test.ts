import assert from 'node:assert/strict'
import test from 'node:test'
import worker from './index.ts'

class MockKV {
  values = new Map<string, unknown>()
  gets: string[] = []

  async get(key: string, type?: 'json') {
    this.gets.push(key)
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

const hash = 'a'.repeat(64)

test('collections hydrate cached image refs from media-worker status', async () => {
  const kv = new MockKV()
  kv.values.set('snapshot:collections:watching', [{
    subject_id: 23080,
    name: 'A',
    name_cn: 'A CN',
    images: { common: null, large: null },
  }])
  kv.values.set('snapshot:summary', { watching: 1, _total: 1 })
  kv.values.set('image:status:23080', {
    subject_id: 23080,
    title: 'A CN',
    common: {
      status: 'cached',
      hash,
      uri: `/image/${hash}`,
      r2_key: `images/${hash}/original`,
    },
    large: { status: 'failed', hash: null, uri: null, r2_key: null },
  })

  const response = await worker.fetch(new Request('https://read.local/collections?type=watching'), {
    AIRING_CAL_KV: kv,
    AIRING_CAL_R2: { get: async () => null },
  } as any)
  const body = await response.json() as any

  assert.equal(body.data[0].images.common.uri, `/image/${hash}`)
  assert.equal(body.data[0].images.large, null)
  assert.equal(body.data[0].image_status.common, 'cached')
  assert.equal(body.data[0].image_status.large, 'failed')
})

test('calendar hydrates cached image refs and subject metadata like collections', async () => {
  const kv = new MockKV()
  kv.values.set('snapshot:calendar', [{
    weekday: { en: 'Mon', cn: '星期一', ja: '月曜日', id: 1 },
    items: [{
      id: 23080,
      name: 'A',
      name_cn: 'A CN',
      images: { common: 'https://lain.bgm.tv/common.jpg', large: 'https://lain.bgm.tv/large.jpg' },
      nsfw: false,
    }],
  }])
  kv.values.set('image:status:23080', {
    subject_id: 23080,
    title: 'A CN',
    common: {
      status: 'cached',
      hash,
      uri: `/image/${hash}`,
      r2_key: `images/${hash}/original`,
    },
    large: { status: 'failed', hash: null, uri: null, r2_key: null },
  })
  kv.values.set('subject:meta:23080', {
    subject_id: 23080,
    exists: true,
    nsfw: true,
    checked_at: 1782650300,
    reason: 'subject_detail',
  })
  kv.values.set('subject:detail:23080', {
    cached_at: 1782650300,
    subject: {
      id: 23080,
      name: 'A',
      name_cn: 'A CN',
      eps: 99,
      total_episodes: 99,
    },
  })

  const response = await worker.fetch(new Request('https://read.local/calendar'), {
    AIRING_CAL_KV: kv,
    AIRING_CAL_R2: { get: async () => null },
  } as any)
  const body = await response.json() as any

  assert.equal(body[0].items[0].images.common.uri, `/image/${hash}`)
  assert.equal(body[0].items[0].images.large, null)
  assert.equal(body[0].items[0].image_status.common, 'cached')
  assert.equal(body[0].items[0].image_status.large, 'failed')
  assert.equal(body[0].items[0].nsfw, true)
  assert.equal(body[0].items[0].eps, undefined)
  assert.equal(body[0].items[0].total_episodes, undefined)
  assert.equal(kv.gets.includes('subject:detail:23080'), false)
})
