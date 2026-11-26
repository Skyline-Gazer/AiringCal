import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assembleFullFetch } from '@airing-cal/bgm-api'
import { canonicalJson } from '@airing-cal/storage'
import {
  openBuilderDatabase,
  publishBuilderCheckpoint,
  runBuilderSyncJob,
  SqliteBuilderStateStore,
  SyncRunStore,
} from '@airing-cal/v3-builder'
import { PUBLIC_RELEASE_POINTER_KEY, FilesystemPublicStore } from '@airing-cal/v3-core'
import { loadVerifiedPublicSnapshot } from './load-public-snapshot.ts'

function emptyFetch() {
  return assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 0, data: [] }] }],
    [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
    1_700_000_000,
  )
}

test('loadVerifiedPublicSnapshot rejects manifest that disagrees with pointer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-read-manifest-'))
  const publicStore = new FilesystemPublicStore(root)
  const db = openBuilderDatabase(':memory:')
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-1',
    mode: 'incremental',
    ownerToken: 'worker',
    fetchInput: async () => emptyFetch(),
    now: () => 1_700_000_000_000,
  })
  const published = await publishBuilderCheckpoint({
    state,
    publicStore,
    manifestMetadata: {
      source_observed_at: '2026-01-01T00:00:00.000Z',
      git_sha: 'a'.repeat(40),
    },
  })
  assert.equal(published.status, 'published')
  const manifestRef = published.pointer!.manifest_ref!

  const loaded = await loadVerifiedPublicSnapshot(publicStore)
  assert.ok(loaded)

  const manifest = JSON.parse(readFileSync(join(root, manifestRef), 'utf8')) as {
    generation: number
    content_sha256: string
    snapshot_key: string
  }
  manifest.content_sha256 = 'b'.repeat(64)
  manifest.snapshot_key = `snapshots/v1/${manifest.generation}-${manifest.content_sha256}.json`
  writeFileSync(join(root, manifestRef), `${canonicalJson(manifest)}\n`)
  await assert.rejects(() => loadVerifiedPublicSnapshot(publicStore), /disagrees with current release pointer/)
})

test('loadVerifiedPublicSnapshot hard-errors when the pointer manifest_ref object is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-read-missing-'))
  const publicStore = new FilesystemPublicStore(root)
  const db = openBuilderDatabase(':memory:')
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-2',
    mode: 'incremental',
    ownerToken: 'worker',
    fetchInput: async () => emptyFetch(),
    now: () => 1_700_000_000_000,
  })
  const published = await publishBuilderCheckpoint({
    state,
    publicStore,
    manifestMetadata: {
      source_observed_at: '2026-01-01T00:00:00.000Z',
      git_sha: 'a'.repeat(40),
    },
  })
  assert.equal(published.status, 'published')
  rmSync(join(root, published.pointer!.manifest_ref!))
  await assert.rejects(() => loadVerifiedPublicSnapshot(publicStore), /Missing manifest object for current release/)
})

test('loadVerifiedPublicSnapshot reads public/manifest.json once for legacy pointers without manifest_ref', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-read-legacy-'))
  const publicStore = new FilesystemPublicStore(root)
  const db = openBuilderDatabase(':memory:')
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-3',
    mode: 'incremental',
    ownerToken: 'worker',
    fetchInput: async () => emptyFetch(),
    now: () => 1_700_000_000_000,
  })
  const published = await publishBuilderCheckpoint({ state, publicStore })
  assert.equal(published.status, 'published')
  assert.equal(published.pointer!.manifest_ref, undefined)

  // No manifest object present: legacy readers still verify the snapshot alone.
  assert.ok(await loadVerifiedPublicSnapshot(publicStore))

  const legacyPointer = published.pointer!
  writeFileSync(
    join(root, PUBLIC_RELEASE_POINTER_KEY),
    `${canonicalJson({
      schema_version: 1,
      generation: legacyPointer.generation,
      content_hash: legacyPointer.content_hash,
      published_at_unix: legacyPointer.published_at_unix,
      artifact_ref: legacyPointer.artifact_ref,
    })}\n`,
  )
  const tampered = {
    schema_version: 1,
    generation: legacyPointer.generation,
    snapshot_key: legacyPointer.artifact_ref,
    content_sha256: 'b'.repeat(64),
    published_at: new Date(legacyPointer.published_at_unix * 1000).toISOString(),
    source_observed_at: '2026-01-01T00:00:00.000Z',
    item_count: 0,
    git_sha: 'a'.repeat(40),
  }
  writeFileSync(join(root, 'public/manifest.json'), `${canonicalJson(tampered)}\n`)
  assert.equal(await loadVerifiedPublicSnapshot(publicStore), null)
})
