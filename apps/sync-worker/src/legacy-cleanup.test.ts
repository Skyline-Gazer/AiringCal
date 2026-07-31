import assert from 'node:assert/strict'
import test from 'node:test'
import {
  migrateCleanupCursorKey,
  migrateReadModeKey,
  type CleanupCursorV1,
  type CollectionRow,
  type ReadModeV1,
} from '@airing-cal/storage'
import {
  runLegacyCleanup,
  type LegacyCleanupD1,
  type LegacyCleanupDataR2,
  type LegacyCleanupKv,
} from './legacy-cleanup.ts'

const now = 1_785_104_400
const DAY = 86_400

function subjectRow(subjectId: number): CollectionRow {
  return {
    user_id: 'u1',
    subject_id: subjectId,
    collection_type: 2,
    rate: null,
    tags_json: '[]',
    comment: '',
    ep_status: 0,
    vol_status: 0,
    upstream_updated_at: null,
    subject_json: '{}',
    content_hash: 'a'.repeat(64),
    state_version: 1,
    temperature: 'cold',
    first_seen_at: now,
    changed_at: now,
    missing_since: null,
    deleted_at: null,
  }
}

class FakeCleanupD1 implements LegacyCleanupD1 {
  rows: CollectionRow[] = []
  appState = new Map<string, unknown>()

  async listCollectionRows(): Promise<CollectionRow[]> {
    return this.rows
  }

  async getAppState<T>(key: string, decode: (value: unknown) => T): Promise<T | undefined> {
    const value = this.appState.get(key)
    return value === undefined ? undefined : decode(value)
  }

  async putAppStateIfNewer<T>(key: string, value: T, _version: number): Promise<boolean> {
    this.appState.set(key, structuredClone(value))
    return true
  }
}

class FakeCleanupKv implements LegacyCleanupKv {
  values = new Map<string, unknown>()
  deleted = 0

  async get(key: string, _type?: 'json'): Promise<unknown> {
    return this.values.get(key) ?? null
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key)
    this.deleted++
  }
}

class FakeCleanupR2 implements LegacyCleanupDataR2 {
  hasObject = true

  async get(_key: string): Promise<{ key: string } | null> {
    return this.hasObject ? { key: 'snapshots/v1/9-ok.json' } : null
  }
}

function r2Mode(d1: FakeCleanupD1): void {
  d1.appState.set(migrateReadModeKey(), {
    mode: 'r2',
    switched_at: now - 15 * DAY,
  } satisfies ReadModeV1)
}

function seededKv(count: number): FakeCleanupKv {
  const kv = new FakeCleanupKv()
  kv.values.set('public:current', {
    schema_version: 1,
    generation: 9,
    content_hash: 'c'.repeat(64),
    r2_key: 'snapshots/v1/9-ok.json',
    published_at: now,
  })
  for (let id = 1; id <= count; id++) {
    kv.values.set(`subject:detail:${id}`, { subject: { id } })
    kv.values.set(`subject:meta:${id}`, { subject_id: id, exists: true, nsfw: false, checked_at: now, expires_at: null, reason: 'subject_detail' })
    kv.values.set(`image:status:${id}`, { common: { status: 'cached', hash: `h${id}`, uri: `/image/h${id}`, r2_key: `images/h${id}/original` } })
    kv.values.set(`subject:refresh:${id}`, { next_refresh_at: now })
  }
  return kv
}

test('cleanup deletes nothing before the fourteen-day observation window', async () => {
  const d1 = new FakeCleanupD1()
  d1.rows = [subjectRow(1)]
  d1.appState.set(migrateReadModeKey(), {
    mode: 'r2',
    switched_at: now - 10 * DAY,
  } satisfies ReadModeV1)
  const kv = seededKv(1)

  const cursor = await runLegacyCleanup(d1, kv, new FakeCleanupR2(), now)

  assert.equal(cursor.deleted_count, 0)
  assert.equal(kv.deleted, 0)
})

test('cleanup deletes at most one hundred legacy keys per run', async () => {
  const d1 = new FakeCleanupD1()
  d1.rows = Array.from({ length: 30 }, (_, index) => subjectRow(index + 1))
  r2Mode(d1)
  const kv = seededKv(30)

  const cursor = await runLegacyCleanup(d1, kv, new FakeCleanupR2(), now)

  assert.equal(cursor.deleted_count, 100)
  assert.equal(kv.deleted, 100)
  assert.equal(cursor.last_subject_id, 25)
})

test('cleanup resumes from the persisted cursor on a later run', async () => {
  const d1 = new FakeCleanupD1()
  d1.rows = Array.from({ length: 30 }, (_, index) => subjectRow(index + 1))
  r2Mode(d1)
  const kv = seededKv(30)

  const first = await runLegacyCleanup(d1, kv, new FakeCleanupR2(), now)
  const second = await runLegacyCleanup(d1, kv, new FakeCleanupR2(), now + DAY)

  assert.equal(first.last_subject_id, 25)
  assert.equal(second.deleted_count, 100 + 20)
  assert.equal(second.last_subject_id, 30)
  assert.equal(kv.deleted, 120)
})

test('cleanup aborts without deletes when the verified R2 generation is missing', async () => {
  const d1 = new FakeCleanupD1()
  d1.rows = [subjectRow(1)]
  r2Mode(d1)
  const kv = seededKv(1)
  const r2 = new FakeCleanupR2()
  r2.hasObject = false

  const cursor = await runLegacyCleanup(d1, kv, r2, now)

  assert.equal(cursor.deleted_count, 0)
  assert.equal(kv.deleted, 0)
})

test('cleanup stays idle while read mode is legacy', async () => {
  const d1 = new FakeCleanupD1()
  d1.rows = [subjectRow(1)]
  const kv = seededKv(1)

  const cursor = await runLegacyCleanup(d1, kv, new FakeCleanupR2(), now)

  assert.equal(cursor.deleted_count, 0)
  assert.equal(kv.deleted, 0)
})

test('a failing delete stops the run without advancing past the failed subject', async () => {
  const d1 = new FakeCleanupD1()
  d1.rows = Array.from({ length: 5 }, (_, index) => subjectRow(index + 1))
  r2Mode(d1)
  const kv = seededKv(5)
  const failingKv = new Proxy(kv, {
    get(target, property, receiver) {
      if (property === 'delete') {
        return async (key: string) => {
          if (key === 'image:status:3') throw new Error('injected delete failure')
          return await target.delete(key)
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })

  const cursor = await runLegacyCleanup(d1, failingKv as unknown as LegacyCleanupKv, new FakeCleanupR2(), now)

  assert.equal(cursor.last_subject_id, 2)
  assert.equal(cursor.deleted_count, 8)
})
