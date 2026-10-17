import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleFullFetch } from '@airing-cal/bgm-api'
import { parsePublicSnapshotManifestV1 } from '@airing-cal/domain'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FILESYSTEM_PUBLIC_POINTER_KEY,
  FilesystemPublicStore,
  MemoryPublicStore,
} from '@airing-cal/v3-core'
import { openBuilderDatabase } from './migrate.ts'
import { publishBuilderCheckpoint } from './publish-checkpoint.ts'
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

test('publishBuilderCheckpoint verifies readback and commits release pointer', async () => {
  const db = openBuilderDatabase(':memory:')
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  const publicStore = new MemoryPublicStore()

  const sync = await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-1',
    mode: 'incremental',
    ownerToken: 'worker',
    fetchInput: async () => emptyFetch(),
    now: () => 1_700_000_000_000,
  })
  assert.equal(sync.status, 'ok')

  const first = await publishBuilderCheckpoint({
    state,
    publicStore,
    manifestMetadata: {
      source_observed_at: '2026-01-01T00:00:00.000Z',
      git_sha: 'a'.repeat(40),
    },
  })
  assert.equal(first.status, 'published')
  assert.equal(publicStore.current?.generation, 1)

  const second = await publishBuilderCheckpoint({ state, publicStore })
  assert.equal(second.status, 'already_current')
})

test('publishBuilderCheckpoint persists release to filesystem PublicStore', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-public-'))
  const publicStore = new FilesystemPublicStore(root)
  const db = openBuilderDatabase(':memory:')
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)

  await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-fs',
    mode: 'incremental',
    ownerToken: 'worker',
    fetchInput: async () => emptyFetch(),
    now: () => 1_700_000_000_000,
  })

  const result = await publishBuilderCheckpoint({
    state,
    publicStore,
    manifestMetadata: {
      source_observed_at: '2026-01-01T00:00:00.000Z',
      git_sha: 'b'.repeat(40),
    },
  })
  assert.equal(result.status, 'published')
  const pointerRaw = readFileSync(join(root, FILESYSTEM_PUBLIC_POINTER_KEY), 'utf8')
  assert.match(pointerRaw, /content_hash/)
  assert.ok(await publicStore.getSnapshotBytes(result.pointer!.artifact_ref))
  const manifestRaw = readFileSync(join(root, 'public/manifest.json'), 'utf8')
  const manifest = parsePublicSnapshotManifestV1(JSON.parse(manifestRaw))
  assert.equal(manifest.snapshot_key, result.pointer!.artifact_ref)
  assert.equal(manifest.generation, result.pointer!.generation)
})

test('publishBuilderCheckpoint fails closed when CAS is unsupported', async () => {
  const db = openBuilderDatabase(':memory:')
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  const publicStore = new MemoryPublicStore()
  publicStore.casSupported = false

  await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-2',
    mode: 'full',
    ownerToken: 'worker',
    fetchInput: async () => emptyFetch(),
    now: () => 1_700_000_000_000,
  })

  const result = await publishBuilderCheckpoint({ state, publicStore })
  assert.equal(result.status, 'cas_unsupported')
  assert.equal(publicStore.current, null)
})
