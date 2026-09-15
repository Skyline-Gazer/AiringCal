import assert from 'node:assert/strict'
import test from 'node:test'
import { buildManifest, buildPublicSnapshot } from '@airing-cal/domain'
import worker from './index.ts'
import {
  buildMigrationHealth,
  type MigrationHealthEnv,
} from './health.ts'
import type { SnapshotSource } from './r2-snapshot.ts'

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

class FakeHealthR2 {
  objects = new Map<string, string>()

  async get(key: string): Promise<{ key: string; text(): Promise<string> } | null> {
    const value = this.objects.get(key)
    return value === undefined ? null : { key, async text() { return value } }
  }
}

function env(kv = new FakeHealthKv(), d1 = new FakeHealthD1()): MigrationHealthEnv {
  return { AIRING_CAL_KV: kv, AIRING_CAL_D1: d1 }
}

async function verifiedSource(): Promise<Extract<SnapshotSource, { mode: 'r2' }>> {
  const snapshot = await buildPublicSnapshot({ collections: [], calendar: [], published_at: 1_000 }, 9)
  const manifest = buildManifest(snapshot, { source_observed_at: 2_000, git_sha: 'b'.repeat(40) })
  return { mode: 'r2' as const, snapshot, manifest }
}

test('legacy source reports the existing migration fields', async () => {
  const kv = new FakeHealthKv()
  const health = await buildMigrationHealth(env(kv), { mode: 'legacy' })

  assert.equal(health.snapshot.source, 'legacy')
  assert.equal(health.snapshot.generation, null)
  assert.equal(health.migration.read_mode, 'legacy')
  assert.equal(health.migration.shadow_streak, 0)
  assert.equal(health.degraded, false)
  assert.deepEqual(Object.keys(health.snapshot).sort(), ['generation', 'r2_key', 'source', 'verified_at'])
})

test('health reports validated manifest metadata independently from migration read mode', async () => {
  const kv = new FakeHealthKv()
  kv.values.set('public:read-mode', { mode: 'legacy' })
  const source = await verifiedSource()
  const health = await buildMigrationHealth(env(kv), source)

  assert.equal(health.snapshot.source, 'r2')
  assert.equal(health.snapshot.generation, source.manifest.generation)
  assert.equal(health.snapshot.r2_key, source.manifest.snapshot_key)
  assert.equal(health.snapshot.verified_at, source.snapshot.published_at)
  assert.equal(health.migration.read_mode, 'legacy')
})

test('an unavailable D1 degrades instead of failing health', async () => {
  const d1 = new FakeHealthD1()
  d1.fail = true

  const health = await buildMigrationHealth(env(new FakeHealthKv(), d1), { mode: 'legacy' })

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

  const health = await buildMigrationHealth(env(kv, d1), { mode: 'legacy' })

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

test('health handler keeps its existing response shape in legacy mode', async () => {
  const response = await worker.fetch(
    new Request('https://airingcal.test/health'),
    {
      AIRING_CAL_KV: new FakeHealthKv(),
      AIRING_CAL_D1: new FakeHealthD1(),
      AIRING_CAL_DATA_R2: new FakeHealthR2(),
      AIRING_CAL_R2: { async get() { return null } },
    } as never,
  )

  assert.equal(response.status, 200)
  const body = await response.json() as Record<string, any>
  assert.deepEqual(Object.keys(body).sort(), ['budget', 'data', 'degraded', 'migration', 'ok', 'snapshot', 'worker'])
  assert.deepEqual(Object.keys(body.snapshot).sort(), ['generation', 'r2_key', 'source', 'verified_at'])
  assert.equal(body.ok, true)
  assert.equal(body.worker, 'read-worker')
  assert.ok(body.data.collections)
  assert.ok(body.data.cache)
  assert.ok(body.data.cron)
  assert.ok('workflow' in body.data)
  assert.deepEqual(body.snapshot, {
    source: 'legacy',
    generation: null,
    r2_key: null,
    verified_at: null,
  })
})

test('health handler reports the validated manifest without changing its response shape', async () => {
  const kv = new FakeHealthKv()
  kv.values.set('public:read-mode', { mode: 'legacy' })
  const source = await verifiedSource()
  const r2 = new FakeHealthR2()
  r2.objects.set('public/manifest.json', JSON.stringify(source.manifest))
  r2.objects.set(source.manifest.snapshot_key, JSON.stringify(source.snapshot))

  const response = await worker.fetch(
    new Request('https://airingcal.test/health'),
    {
      AIRING_CAL_KV: kv,
      AIRING_CAL_D1: new FakeHealthD1(),
      AIRING_CAL_DATA_R2: r2,
      AIRING_CAL_R2: { async get() { return null } },
    } as never,
  )

  assert.equal(response.status, 200)
  const body = await response.json() as Record<string, any>
  assert.deepEqual(Object.keys(body).sort(), ['budget', 'data', 'degraded', 'migration', 'ok', 'snapshot', 'worker'])
  assert.deepEqual(Object.keys(body.snapshot).sort(), ['generation', 'r2_key', 'source', 'verified_at'])
  assert.deepEqual(body.snapshot, {
    source: 'r2',
    generation: source.manifest.generation,
    r2_key: source.manifest.snapshot_key,
    verified_at: source.snapshot.published_at,
  })
  assert.equal(body.migration.read_mode, 'legacy')
});
