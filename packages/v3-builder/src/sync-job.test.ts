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
