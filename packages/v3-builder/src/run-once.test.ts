import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleFullFetch } from '@airing-cal/bgm-api'
import { MemoryPublicStore } from '@airing-cal/v3-core'
import { openBuilderDatabase } from './migrate.ts'
import { runBuilderOnce } from './run-once.ts'
import { SqliteBuilderStateStore } from './sqlite-state.ts'
import { SyncRunStore } from './sync-runs.ts'

function emptyFetch() {
  return assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 0, data: [] }] }],
    [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
    1_700_000_000,
  )
}

function builderDeps(publicStore = new MemoryPublicStore()) {
  const db = openBuilderDatabase(':memory:')
  return {
    state: new SqliteBuilderStateStore(db),
    runs: new SyncRunStore(db),
    publicStore,
    fetchInput: async () => emptyFetch(),
    now: () => 1_700_000_000_000,
  }
}

test('runBuilderOnce skips publish when publishAfterSync is false', async () => {
  const deps = builderDeps()
  const result = await runBuilderOnce({
    ...deps,
    runId: 'run-once-a',
    mode: 'incremental',
    ownerToken: 'worker',
    publishAfterSync: false,
  })
  assert.equal(result.sync.status, 'ok')
  assert.equal(result.publish, null)
})

test('runBuilderOnce publishes checkpoint after successful sync', async () => {
  const publicStore = new MemoryPublicStore()
  const deps = builderDeps(publicStore)
  const result = await runBuilderOnce({
    ...deps,
    runId: 'run-once-b',
    mode: 'incremental',
    ownerToken: 'worker',
    publishAfterSync: true,
    manifestMetadata: {
      source_observed_at: '2026-01-01T00:00:00.000Z',
      git_sha: 'b'.repeat(40),
    },
  })
  assert.equal(result.sync.status, 'ok')
  assert.equal(result.publish?.status, 'published')
  assert.equal(publicStore.current?.generation, 1)
})
