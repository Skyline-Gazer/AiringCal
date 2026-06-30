import assert from 'node:assert/strict'
import test from 'node:test'
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
})
