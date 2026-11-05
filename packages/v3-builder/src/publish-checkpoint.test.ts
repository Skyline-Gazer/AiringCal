import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleFullFetch } from '@airing-cal/bgm-api'
import {
  parsePublicSnapshotManifestV1,
  type PublicSnapshotManifestV1,
} from '@airing-cal/domain'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PUBLIC_RELEASE_POINTER_KEY,
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
  const pointerRaw = readFileSync(join(root, PUBLIC_RELEASE_POINTER_KEY), 'utf8')
  assert.match(pointerRaw, /content_hash/)
  assert.ok(await publicStore.getSnapshotBytes(result.pointer!.artifact_ref))
  const manifestRaw = readFileSync(join(root, result.pointer!.manifest_ref!), 'utf8')
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

const COMMON_URL = 'https://lain.bgm.tv/pic/cover/c/common.jpg'
const LARGE_URL = 'https://lain.bgm.tv/pic/cover/l/large.jpg'

function collectionFetch(subjectId: number) {
  const entry = {
    subject_id: subjectId,
    subject_type: 2,
    rate: 0,
    type: 3,
    comment: '',
    tags: [],
    ep_status: 1,
    vol_status: 0,
    updated_at: '2026-01-01T00:00:00.000Z',
    private: false,
    subject: {
      id: subjectId,
      type: 2,
      name: 'Name',
      name_cn: '中文',
      summary: 'summary',
      nsfw: false,
      date: '2026-01-01',
      eps: 12,
      total_episodes: 12,
      images: { large: LARGE_URL, common: COMMON_URL, medium: COMMON_URL, small: COMMON_URL, grid: COMMON_URL },
      rating: { score: 7, rank: 100, total: 10 },
    },
  }
  return assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 1, data: [entry] }] }],
    [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
    1_700_000_000,
  )
}

test('publishBuilderCheckpoint writes a generation-scoped manifest_ref on the pointer', async () => {
  const db = openBuilderDatabase(':memory:')
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  const publicStore = new MemoryPublicStore()
  await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-ref',
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
      git_sha: 'd'.repeat(40),
    },
  })
  assert.equal(result.status, 'published')
  assert.ok(result.pointer!.manifest_ref)
  assert.match(result.pointer!.manifest_ref!, /^public\/manifests\/1-[0-9a-f]{64}\.json$/)
  const manifestBytes = await publicStore.getSnapshotBytes(result.pointer!.manifest_ref!)
  assert.ok(manifestBytes)
  const manifest = parsePublicSnapshotManifestV1(JSON.parse(new TextDecoder().decode(manifestBytes!)))
  assert.equal(manifest.snapshot_key, result.pointer!.artifact_ref)
  assert.equal(await publicStore.getSnapshotBytes('public/manifest.json'), null)
})

test('publishBuilderCheckpoint reuses persisted metadata so same-generation retries are byte-identical', async () => {
  const db = openBuilderDatabase(':memory:')
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-retry',
    mode: 'incremental',
    ownerToken: 'worker',
    fetchInput: async () => emptyFetch(),
    now: () => 1_700_000_000_000,
  })
  const firstStore = new MemoryPublicStore()
  const first = await publishBuilderCheckpoint({
    state,
    publicStore: firstStore,
    manifestMetadata: {
      source_observed_at: '2026-01-01T00:00:00.000Z',
      git_sha: 'e'.repeat(40),
    },
  })
  assert.equal(first.status, 'published')

  // Retry against a fresh public store with advanced wall clock: fresh caller metadata is ignored.
  const retryStore = new MemoryPublicStore()
  const retry = await publishBuilderCheckpoint({
    state,
    publicStore: retryStore,
    manifestMetadata: {
      source_observed_at: '2026-06-01T12:00:00.000Z',
      git_sha: 'f'.repeat(40),
    },
  })
  assert.equal(retry.status, 'published')
  assert.equal(retry.pointer!.manifest_ref, first.pointer!.manifest_ref)
  assert.deepEqual(
    await retryStore.getSnapshotBytes(retry.pointer!.manifest_ref!),
    await firstStore.getSnapshotBytes(first.pointer!.manifest_ref!),
  )
})

test('publishBuilderCheckpoint publishes a distinct manifest per generation', async () => {
  const db = openBuilderDatabase(':memory:')
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  const publicStore = new MemoryPublicStore()
  const metadata = {
    source_observed_at: '2026-01-01T00:00:00.000Z',
    git_sha: 'a'.repeat(40),
  }
  await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-gen1',
    mode: 'incremental',
    ownerToken: 'worker',
    fetchInput: async () => emptyFetch(),
    now: () => 1_700_000_000_000,
  })
  const first = await publishBuilderCheckpoint({ state, publicStore, manifestMetadata: metadata })
  assert.equal(first.status, 'published')

  await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-gen2',
    mode: 'incremental',
    ownerToken: 'worker',
    fetchInput: async () => collectionFetch(42),
    now: () => 1_700_100_000_000,
  })
  const second = await publishBuilderCheckpoint({ state, publicStore, manifestMetadata: metadata })
  assert.equal(second.status, 'published')
  assert.notEqual(second.pointer!.manifest_ref, first.pointer!.manifest_ref)
  assert.match(second.pointer!.manifest_ref!, /^public\/manifests\/2-[0-9a-f]{64}\.json$/)
  const manifest = parsePublicSnapshotManifestV1(
    JSON.parse(new TextDecoder().decode(
      (await publicStore.getSnapshotBytes(second.pointer!.manifest_ref!))!,
    )),
  ) as PublicSnapshotManifestV1
  assert.equal(manifest.generation, 2)
  assert.equal(manifest.snapshot_key, second.pointer!.artifact_ref)
})
