import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleFullFetch } from '@airing-cal/bgm-api'
import {
  openBuilderDatabase,
  publishBuilderCheckpoint,
  runBuilderSyncJob,
  SqliteBuilderStateStore,
  SyncRunStore,
} from '@airing-cal/v3-builder'
import { MemoryR2Bucket } from '@airing-cal/v3-adapters/memory-r2-binding'
import { CloudflareR2PublicStore } from '@airing-cal/v3-adapters'
import { V2_CACHE_CONTROL } from '@airing-cal/v3-core/read-contract'
import { handleCloudflareReadRequest } from './cloudflare-read-handler.ts'

function emptyFetch() {
  return assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 0, data: [] }] }],
    [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
    1_700_000_000,
  )
}

test('handleCloudflareReadRequest serves /api/collections from R2 PublicStore', async () => {
  const bucket = new MemoryR2Bucket()
  const publicStore = new CloudflareR2PublicStore(bucket)
  const db = openBuilderDatabase(':memory:')
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-cf',
    mode: 'incremental',
    ownerToken: 'worker',
    fetchInput: async () => emptyFetch(),
    now: () => 1_700_000_000_000,
  })
  await publishBuilderCheckpoint({
    state,
    publicStore,
    manifestMetadata: { source_observed_at: '2026-01-01T00:00:00.000Z', git_sha: 'b'.repeat(40) },
  })

  const response = await handleCloudflareReadRequest(
    new Request('https://worker.example/api/collections?type=watching&page=1&limit=24'),
    { publicR2: bucket, nsfwShow: false, packageVersion: '3.0.0-alpha.0' },
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), V2_CACHE_CONTROL.collections)

  const version = await handleCloudflareReadRequest(new Request('https://worker.example/api/version'), {
    publicR2: bucket,
  })
  const versionBody = await version.json() as { read: string; platform: string }
  assert.equal(versionBody.read, 'cloudflare')
  assert.equal(versionBody.platform, 'cloudflare')
})
