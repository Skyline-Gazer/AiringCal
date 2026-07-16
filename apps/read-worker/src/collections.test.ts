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
      rating: { score: 8.1, total: 100 },
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
  assert.equal(body[0].items[0].eps, 99)
  assert.equal(body[0].items[0].total_episodes, 99)
  assert.equal(body[0].items[0].rating.score, 8.1)
  assert.equal(kv.gets.includes('subject:detail:23080'), true)
})

test('calendar ignores old detail while a not-found tombstone is active', async () => {
  const kv = new MockKV()
  const now = 1_782_650_300
  kv.values.set('snapshot:calendar', [{
    weekday: { id: 1 },
    items: [{
      id: 23080,
      subject_id: 23080,
      name: 'Stale name',
      name_cn: '陈旧名称',
      summary: 'Stale summary',
      date: '2020-01-01',
      eps: 99,
      eps_count: 98,
      total_episodes: 97,
      rating: { score: 9.9 },
      nsfw: false,
    }],
  }])
  kv.values.set('subject:meta:23080', {
    subject_id: 23080,
    exists: false,
    nsfw: true,
    checked_at: now,
    expires_at: now + 86400,
    reason: 'not_found',
  })
  kv.values.set('subject:detail:23080', {
    cached_at: now - 86400,
    subject: { id: 23080, eps: 99, total_episodes: 99, rating: { score: 9.9 } },
  })
  const originalNow = Date.now
  Date.now = () => (now + 86399) * 1000

  try {
    const response = await worker.fetch(new Request('https://read.local/calendar'), {
      AIRING_CAL_KV: kv,
      AIRING_CAL_R2: { get: async () => null },
    } as any)
    const item = (await response.json() as any)[0].items[0]

    assert.equal(item.nsfw, true)
    assert.equal(item.eps, undefined)
    assert.equal(item.eps_count, undefined)
    assert.equal(item.total_episodes, undefined)
    assert.equal(item.rating, undefined)
    assert.equal(item.name, undefined)
    assert.equal(item.name_cn, undefined)
    assert.equal(item.summary, undefined)
    assert.equal(item.date, undefined)
    assert.equal(item.id, 23080)
    assert.equal(item.subject_id, 23080)
  } finally {
    Date.now = originalNow
  }
})

test('collections remove snapshot detail fields under an active tombstone but preserve progress', async () => {
  const kv = new MockKV()
  const now = 1_782_650_300
  kv.values.set('snapshot:collections:watching', [{
    subject_id: 23080,
    name: 'Stale name',
    name_cn: '陈旧名称',
    summary: 'Stale summary',
    date: '2020-01-01',
    rating: { score: 9.9 },
    eps: 99,
    eps_count: 98,
    total_episodes: 97,
    ep_status: 7,
    nsfw: false,
  }])
  kv.values.set('snapshot:summary', { watching: 1, _total: 1 })
  kv.values.set('subject:meta:23080', { subject_id: 23080, exists: false, nsfw: true, checked_at: now, expires_at: now + 86400, reason: 'not_found' })
  const originalNow = Date.now
  Date.now = () => (now + 1) * 1000
  try {
    const response = await worker.fetch(new Request('https://read.local/collections?type=watching'), { AIRING_CAL_KV: kv, AIRING_CAL_R2: { get: async () => null } } as any)
    const item = (await response.json() as any).data[0]
    assert.equal(item.rating, undefined)
    assert.equal(item.eps, undefined)
    assert.equal(item.eps_count, undefined)
    assert.equal(item.total_episodes, undefined)
    assert.equal(item.name, undefined)
    assert.equal(item.name_cn, undefined)
    assert.equal(item.summary, undefined)
    assert.equal(item.date, undefined)
    assert.equal(item.subject_id, 23080)
    assert.equal(item.ep_status, 7)
    assert.equal(item.nsfw, true)
  } finally {
    Date.now = originalNow
  }
})

test('calendar reads the active Workflow snapshot version', async () => {
  const kv = new MockKV()
  kv.values.set('snapshot:calendar', [{ weekday: { id: 1 }, items: [{ id: 1, name: 'legacy' }] }])
  const calendar = [{ weekday: { id: 1 }, items: [{ id: 2, name: 'workflow' }] }]
  const key = 'snapshot:version:live-calendar:calendar'
  const values: Record<string, unknown> = {
    'snapshot:version:live-calendar:collections:want': [],
    'snapshot:version:live-calendar:collections:watched': [],
    'snapshot:version:live-calendar:collections:watching': [],
    'snapshot:version:live-calendar:collections:on_hold': [],
    'snapshot:version:live-calendar:collections:dropped': [],
    'snapshot:version:live-calendar:summary': { _total: 0 },
    [key]: calendar,
  }
  const digests: Record<string, string> = {}
  for (const [versionKey, value] of Object.entries(values)) {
    kv.values.set(versionKey, value)
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))
    digests[versionKey] = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  kv.values.set('snapshot:active', {
    instance_id: 'live-calendar', generation: 1, mode: 'live', published_at: 1, subject_count: 1,
    required_keys: Object.keys(values),
    digests,
  })

  const response = await worker.fetch(new Request('https://read.local/calendar'), {
    AIRING_CAL_KV: kv,
    AIRING_CAL_R2: { get: async () => null },
  } as any)
  const body = await response.json() as any

  assert.equal(body[0].items[0].id, 2)
})
