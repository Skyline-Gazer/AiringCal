import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assembleFullFetch } from '@airing-cal/bgm-api'
import {
  openBuilderDatabase,
  publishBuilderCheckpoint,
  runBuilderSyncJob,
  SqliteBuilderStateStore,
  SyncRunStore,
} from '@airing-cal/v3-builder'
import { FilesystemPublicStore, V2_CACHE_CONTROL } from '@airing-cal/v3-core'
import { handlePortableReadRequest } from './portable-read-handler.ts'
import { readPortableCronStatus } from './portable-builder-cron.ts'

function emptyFetch() {
  return assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 0, data: [] }] }],
    [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
    1_700_000_000,
  )
}

test('handlePortableReadRequest serves collections with v2 cache headers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-read-'))
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
    projectFetchMediaHints: true,
  })
  await publishBuilderCheckpoint({
    state,
    publicStore,
    manifestMetadata: { source_observed_at: '2026-01-01T00:00:00.000Z', git_sha: 'a'.repeat(40) },
  })

  const response = await handlePortableReadRequest(
    new Request('https://local/api/collections?type=watching&page=1&limit=24'),
    { publicStore, nsfwShow: false },
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), V2_CACHE_CONTROL.collections)
  const body = await response.json() as { data: unknown[]; limit: number }
  assert.equal(body.limit, 24)
})

test('handlePortableReadRequest /version includes platform when env set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-read-version-'))
  const publicStore = new FilesystemPublicStore(root)
  const response = await handlePortableReadRequest(new Request('https://local/api/version'), {
    publicStore,
    processEnv: { AIRINGCAL_PLATFORM: 'portable' },
  })
  assert.equal(response.status, 200)
  const body = await response.json() as { platform?: string; read: string }
  assert.equal(body.read, 'portable')
  assert.equal(body.platform, 'portable')
})

test('handlePortableReadRequest /health reports compose-scheduler cron from SQLite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-read-health-'))
  const sqlitePath = join(root, 'builder.sqlite')
  const publicStore = new FilesystemPublicStore(root)
  const db = openBuilderDatabase(sqlitePath)
  const state = new SqliteBuilderStateStore(db)
  const runs = new SyncRunStore(db)
  await runBuilderSyncJob({
    state,
    runs,
    runId: 'run-health',
    mode: 'incremental',
    ownerToken: 'worker',
    fetchInput: async () => emptyFetch(),
    now: () => 1_700_000_000_000,
  })
  await publishBuilderCheckpoint({
    state,
    publicStore,
    manifestMetadata: { source_observed_at: '2026-01-01T00:00:00.000Z', git_sha: 'c'.repeat(40) },
  })
  db.close()

  const response = await handlePortableReadRequest(new Request('https://local/api/health'), {
    publicStore,
    cronStatus: () => readPortableCronStatus({
      AIRINGCAL_BUILDER_SQLITE_PATH: sqlitePath,
      AIRINGCAL_SCHEDULER_DAILY_AT: '03:00',
    }),
  })
  assert.equal(response.status, 200)
  const body = await response.json() as { data: { cron: { scheduler: string; last: { status: string } | null } } }
  assert.equal(body.data.cron.scheduler, 'compose-scheduler')
  assert.equal(body.data.cron.last?.status, 'succeeded')

  const gatewayLike = await handlePortableReadRequest(new Request('https://local/api/health'), { publicStore })
  const gatewayLikeBody = await gatewayLike.json() as { data: { cron: { scheduler: string; next_at: string | null } } }
  assert.equal(gatewayLikeBody.data.cron.scheduler, 'external')
  assert.equal(gatewayLikeBody.data.cron.next_at, null)
})
