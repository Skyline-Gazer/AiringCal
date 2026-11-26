import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleFullFetch } from '@airing-cal/bgm-api'
import { openBuilderDatabase } from './migrate.ts'
import { runBuilderSyncJob } from './sync-job.ts'
import { SqliteBuilderStateStore } from './sqlite-state.ts'
import { SyncRunStore } from './sync-runs.ts'

function emptyFetch() {
  return assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 0, data: [] }] }],
    [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
    1_700_000_000,
  )
}

test('runBuilderSyncJob writes checkpoint and records sync run', async () => {
  const db = openBuilderDatabase(':memory:')
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  const first = await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-a',
    mode: 'incremental',
    ownerToken: 'worker-1',
    leaseSeconds: 60,
    fetchInput: async () => emptyFetch(),
    now: () => 1_700_000_000_000,
  })
  assert.equal(first.status, 'ok')
  assert.equal(first.generation, 1)

  const second = await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-b',
    mode: 'incremental',
    ownerToken: 'worker-1',
    leaseSeconds: 60,
    fetchInput: async () => emptyFetch(),
    now: () => 1_700_000_100_000,
  })
  assert.equal(second.status, 'no_change')
  assert.equal(runs.latestRun()?.run_id, 'run-b')
})

test('runBuilderSyncJob skips when lease is held', async () => {
  const db = openBuilderDatabase(':memory:')
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  assert.equal(await state.acquireLease('builder-sync', 'other', 120, 100), true)
  const result = await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-c',
    mode: 'full',
    ownerToken: 'worker-2',
    fetchInput: async () => emptyFetch(),
    now: () => 100_000,
  })
  assert.equal(result.status, 'skipped')
})

// ---------------------------------------------------------------------------
// #195 P3: episode progress + collection ledger persistence in sync-job
// ---------------------------------------------------------------------------

function collectionEntry(subjectId: number, overrides: Record<string, unknown> = {}) {
  return {
    subject_id: subjectId,
    subject_type: 2,
    rate: 0,
    type: 3,
    tags: [],
    ep_status: 2,
    vol_status: 0,
    updated_at: '2026-01-01T00:00:00Z',
    private: false,
    ...overrides,
  }
}

function fetchInputOf(subjectIds: number[], episodes: unknown[] = []) {
  return assembleFullFetch(
    [{
      user_id: '42',
      pageLimit: 50,
      pages: [{
        offset: 0,
        total: subjectIds.length,
        data: subjectIds.map((id) => collectionEntry(id)) as never,
      }],
    }],
    [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
    1_700_000_000,
    episodes as never,
  )
}

const EPISODES_900 = [{
  user_id: '42',
  subject_id: 900,
  observed_at: 1_700_000_000,
  episodes: [
    { episode_id: 1, collection_type: 2, episode_type: 0, sort: 1, ep: 1, airdate: '2026-01-01', updated_at: 10 },
    { episode_id: 2, collection_type: 0, episode_type: 0, sort: 2, ep: 2, updated_at: 0 },
    { episode_id: 3, collection_type: 2, episode_type: 1, sort: 1, ep: 0, updated_at: 12 },
  ],
}]

function runJob(db: ReturnType<typeof openBuilderDatabase>, input: unknown, now: number, runId = 'r') {
  return runBuilderSyncJob({
    state: new SqliteBuilderStateStore(db),
    runs: new SyncRunStore(db),
    runId,
    mode: 'full',
    ownerToken: 'owner-' + runId,
    leaseSeconds: 60,
    fetchInput: async () => input as never,
    now: () => now,
  })
}

test('#195 sync-job persists episode progress with the checkpoint', async () => {
  const db = openBuilderDatabase(':memory:')
  const result = await runJob(db, fetchInputOf([900, 901], EPISODES_900), 1_700_000_000_000, 'run-1')
  assert.equal(result.status, 'ok')
  const rows = db.prepare('SELECT * FROM v3_episode_progress ORDER BY episode_id').all() as Array<Record<string, unknown>>
  assert.equal(rows.length, 3)
  assert.equal(rows[2].episode_type, 1, 'SP type stored')
  assert.equal(rows[1].collection_type, 0, 'explicit unwatched gap stored')
  const ledger = db.prepare('SELECT * FROM v3_collections ORDER BY subject_id').all() as Array<Record<string, unknown>>
  assert.equal(ledger.length, 2)
  assert.equal(ledger[0].state_version, 1)
  assert.equal(ledger[0].first_seen_at, 1_700_000_000)
})

test('#195 ledger reconciles missing → deleted → restored across runs', async () => {
  const db = openBuilderDatabase(':memory:')
  await runJob(db, fetchInputOf([900, 901], EPISODES_900), 1_700_000_000_000, 'run-1')
  await runJob(db, fetchInputOf([900], EPISODES_900), 1_700_000_100_000, 'run-2')
  let row = db.prepare("SELECT * FROM v3_collections WHERE subject_id = 901").get() as Record<string, unknown>
  assert.equal(row.missing_since, 1_700_000_100)
  assert.equal(row.deleted_at, null)
  await runJob(db, fetchInputOf([900], EPISODES_900), 1_700_000_200_000, 'run-3')
  row = db.prepare("SELECT * FROM v3_collections WHERE subject_id = 901").get() as Record<string, unknown>
  assert.equal(row.deleted_at, 1_700_000_200)
  await runJob(db, fetchInputOf([900, 901], EPISODES_900), 1_700_000_300_000, 'run-4')
  row = db.prepare("SELECT * FROM v3_collections WHERE subject_id = 901").get() as Record<string, unknown>
  assert.equal(row.missing_since, null, 'restored clears missing')
  assert.equal(row.deleted_at, null, 'restored clears deleted')
  assert.ok(Number(row.state_version) > 1, 'restore advances state_version')
})

test('#195 no-change public run still refreshes episode progress', async () => {
  const db = openBuilderDatabase(':memory:')
  const first = await runJob(db, fetchInputOf([900], EPISODES_900), 1_700_000_000_000, 'run-1')
  assert.equal(first.status, 'ok')
  const changed = [{
    ...EPISODES_900[0],
    episodes: [{ ...EPISODES_900[0].episodes[1], collection_type: 2, updated_at: 99 }],
    observed_at: 1_700_000_100,
  }]
  const second = await runJob(db, fetchInputOf([900], changed), 1_700_000_100_000, 'run-2')
  assert.equal(second.status, 'no_change', 'public payload (counts) unchanged')
  const row = db.prepare('SELECT * FROM v3_episode_progress WHERE episode_id = 2').get() as Record<string, unknown>
  assert.equal(row.collection_type, 2, 'episode state refreshed even without a new generation')
  assert.equal(row.updated_at, 99)
})

test('#195 public snapshot never contains episode or private-comment data', async () => {
  const db = openBuilderDatabase(':memory:')
  const input = assembleFullFetch(
    [{
      user_id: '42',
      pageLimit: 50,
      pages: [{
        offset: 0,
        total: 1,
        data: [collectionEntry(900, { private: true, comment: 'deep-personal-note' })] as never,
      }],
    }],
    [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
    1_700_000_000,
    EPISODES_900 as never,
  )
  await runJob(db, input, 1_700_000_000_000, 'run-1')
  const raw = await new SqliteBuilderStateStore(db).getKv('checkpoint:public-snapshot')
  assert.ok(raw)
  assert.equal(raw.includes('deep-personal-note'), false, 'private comment never projected')
  assert.equal(raw.includes('airdate'), false, 'episode fields never projected')
  assert.equal(raw.includes('"episodes"'), false)
  const ledger = db.prepare('SELECT comment FROM v3_collections WHERE subject_id = 900').get() as Record<string, unknown>
  assert.equal(ledger.comment, 'deep-personal-note', 'internal ledger keeps it')
})
