import assert from 'node:assert/strict'
import test from 'node:test'
import worker from './index.ts'
import {
  buildMigrationHealth,
  type MigrationHealthEnv,
} from './health.ts'

const hash = 'c'.repeat(64)

class FakeHealthKv {
  values = new Map<string, unknown>()

  async get(key: string, _type: 'json'): Promise<unknown> {
    return this.values.get(key) ?? null
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }
}

class FakeHealthD1 {
  appState = new Map<string, unknown>()
  fail = false

  async getAppState<T>(key: string, decode: (value: unknown) => T): Promise<T | undefined> {
    if (this.fail) throw new Error('D1 unavailable')
    const value = this.appState.get(key)
    return value === undefined ? undefined : decode(value)
  }

  prepare(_sql: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null> } } {
    return {
      bind() {
        return {
          async first<T>(): Promise<T | null> {
            return null
          },
        }
      },
    }
  }
}

function env(kv: FakeHealthKv, d1: FakeHealthD1): MigrationHealthEnv {
  return { AIRING_CAL_KV: kv, AIRING_CAL_D1: d1 }
}

test('legacy read mode reports legacy source with zeroed migration fields', async () => {
  const kv = new FakeHealthKv()
  const health = await buildMigrationHealth(env(kv, new FakeHealthD1()))

  assert.equal(health.snapshot.source, 'legacy')
  assert.equal(health.snapshot.generation, null)
  assert.equal(health.migration.read_mode, 'legacy')
  assert.equal(health.migration.shadow_streak, 0)
  assert.equal(health.degraded, false)
})

test('r2 read mode reports the resolved snapshot generation', async () => {
  const kv = new FakeHealthKv()
  kv.values.set('public:read-mode', { mode: 'r2', switched_at: 1_234 })
  const health = await buildMigrationHealth(env(kv, new FakeHealthD1()), {
    mode: 'r2',
    snapshot: {
      schema_version: 1,
      generation: 9,
      content_hash: hash,
      published_at: 1_000,
      collections: { want: [], watched: [], watching: [], on_hold: [], dropped: [] },
      calendar: [],
      summary: { want: 0, watched: 0, watching: 0, on_hold: 0, dropped: 0, _total: 0 },
    },
  })

  assert.equal(health.snapshot.source, 'r2')
  assert.equal(health.snapshot.generation, 9)
  assert.equal(health.snapshot.r2_key, `snapshots/v1/9-${hash}.json`)
  assert.equal(health.migration.read_mode, 'r2')
})

test('health reports cache when the resolved snapshot source is the verified envelope', async () => {
  const health = await buildMigrationHealth(env(new FakeHealthKv(), new FakeHealthD1()), {
    mode: 'cache',
    snapshot: {
      schema_version: 1,
      generation: 9,
      content_hash: hash,
      published_at: 1_000,
      collections: { want: [], watched: [], watching: [], on_hold: [], dropped: [] },
      calendar: [],
      summary: { want: 0, watched: 0, watching: 0, on_hold: 0, dropped: 0, _total: 0 },
    },
  })

  assert.equal(health.snapshot.source, 'cache')
  assert.equal(health.snapshot.generation, 9)
})

test('an unavailable D1 degrades instead of failing health', async () => {
  const d1 = new FakeHealthD1()
  d1.fail = true

  const health = await buildMigrationHealth(env(new FakeHealthKv(), d1))

  assert.equal(health.degraded, true)
  assert.equal(health.snapshot.source, 'legacy')
  assert.equal(health.migration.shadow_streak, 0)
})

test('migration summary and budget are surfaced when D1 state exists', async () => {
  const kv = new FakeHealthKv()
  const d1 = new FakeHealthD1()
  d1.appState.set('migrate:legacy:summary', {
    imported: 10,
    skipped_existing: 2,
    missing_keys: 3,
    errored: 0,
    updated_at: 1_000,
  })
  d1.appState.set('migrate:shadow:streak', {
    streak: 4,
    last_success_at: 1_000,
    last_diff_summary: null,
    updated_at: 1_000,
  })

  const health = await buildMigrationHealth(env(kv, d1))

  assert.equal(health.migration.imported, 10)
  assert.equal(health.migration.skipped_existing, 2)
  assert.equal(health.migration.missing_keys, 3)
  assert.equal(health.migration.shadow_streak, 4)
  assert.deepEqual(health.budget.media, {
    reserved: 0,
    consumed: 0,
    soft_limit: 50,
    hard_limit: 100,
  })
})

test('health handler keeps existing fields and adds migration fields in legacy mode', async () => {
  const response = await worker.fetch(
    new Request('https://airingcal.test/health'),
    {
      AIRING_CAL_KV: new FakeHealthKv(),
      AIRING_CAL_D1: new FakeHealthD1(),
      AIRING_CAL_DATA_R2: { async get() { return null } },
      AIRING_CAL_R2: { async get() { return null } },
    } as never,
  )

  assert.equal(response.status, 200)
  const body = await response.json() as Record<string, unknown>
  assert.equal(body.ok, true)
  assert.equal(body.worker, 'read-worker')
  const data = body.data as Record<string, unknown>
  assert.ok(data.collections)
  assert.ok(data.cache)
  assert.ok(data.cron)
  assert.ok('workflow' in data)
  assert.deepEqual(body.snapshot, {
    source: 'legacy',
    generation: null,
    r2_key: null,
    verified_at: null,
  })
  assert.equal(body.degraded, false)
})
