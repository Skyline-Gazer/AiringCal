import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
import { FilesystemPublicStore } from '@airing-cal/v3-core'
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

  const loaded = await loadVerifiedPublicSnapshot(publicStore)
  assert.ok(loaded)

  const manifest = JSON.parse(readFileSync(join(root, 'public/manifest.json'), 'utf8')) as {
    generation: number
    content_sha256: string
    snapshot_key: string
  }
  manifest.content_sha256 = 'b'.repeat(64)
  manifest.snapshot_key = `snapshots/v1/${manifest.generation}-${manifest.content_sha256}.json`
  writeFileSync(join(root, 'public/manifest.json'), `${canonicalJson(manifest)}\n`)
  assert.equal(await loadVerifiedPublicSnapshot(publicStore), null)
})
