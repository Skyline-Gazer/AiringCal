import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPublicSnapshot, snapshotObjectKey } from '@airing-cal/domain'
import { handleReadRequest } from './read-api.ts'

class MockKv {
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

class MockD1 {
  prepare(_sql: string) {
    return {
      bind() {
        return { async first() { return null } }
      },
    }
  }

  async getAppState(_key: string, decode: (value: unknown) => unknown) {
    return decode(undefined)
  }
}

class MockDataR2 {
  objects = new Map<string, string>()

  async get(key: string) {
    const text = this.objects.get(key)
    if (text === undefined) return null
    return { text: async () => text }
  }
}

test('/health reports QingLong scheduler when public read mode is r2', async () => {
  const kv = new MockKv()
  const snapshot = await buildPublicSnapshot({
    collections: [],
    calendar: [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
    published_at: 1_700_000_000,
  }, 1)
  const key = snapshotObjectKey(snapshot)
  const dataR2 = new MockDataR2()
  dataR2.objects.set(key, JSON.stringify(snapshot))
  kv.values.set('public:read-mode', { mode: 'r2', switched_at: 1_700_000_100 })
  kv.values.set('public:current', {
    schema_version: 1,
    generation: snapshot.generation,
    content_hash: snapshot.content_hash,
    r2_key: key,
    published_at: 1_700_000_100,
  })

  const response = await handleReadRequest(new Request('https://read.local/health'), {
    AIRING_CAL_KV: kv,
    AIRING_CAL_D1: new MockD1() as never,
    AIRING_CAL_DATA_R2: dataR2,
    AIRING_CAL_R2: { get: async () => null },
  })
  assert.ok(response)
  const body = await response!.json() as { data: { cron: { scheduler: string; last: { source: string } } } }
  assert.equal(body.data.cron.scheduler, 'qinglong')
  assert.equal(body.data.cron.last.source, 'qinglong')
})
