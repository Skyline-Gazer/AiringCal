import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleFullFetch, type BgmCollection } from '@airing-cal/bgm-api'
import { MemoryEdgeOneBlob } from '@airing-cal/v3-adapters/memory-edgeone-blob'
import { EdgeOnePublicStore } from '@airing-cal/v3-adapters/edgeone-public-store'
import {
  openBuilderDatabase,
  publishBuilderCheckpoint,
  runBuilderSyncJob,
  SqliteBuilderStateStore,
  SyncRunStore,
} from '@airing-cal/v3-builder'
import { V2_CACHE_CONTROL } from '@airing-cal/v3-core/read-contract'
import { PUBLIC_RELEASE_POINTER_KEY } from '@airing-cal/v3-core/public-pointer'
import { handleEdgeOneReadRequest } from './edgeone-read-handler.ts'

function collectionEntry(subjectId: number): BgmCollection {
  return {
    subject_id: subjectId,
    subject_type: 2,
    rate: 0,
    type: 3,
    comment: '',
    tags: [],
    ep_status: 0,
    vol_status: 0,
    updated_at: '2026-01-01T00:00:00.000Z',
    private: false,
    subject: {
      id: subjectId,
      type: 2,
      name: `Subject ${subjectId}`,
      name_cn: '',
      summary: '',
      nsfw: false,
      date: '2026-01-01',
      eps: 12,
      total_episodes: 12,
      images: { large: '', common: '', medium: '', small: '', grid: '' },
      rating: { score: 0, rank: 0, total: 0 },
    },
  }
}

function fetchFixture() {
  return assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 1, data: [collectionEntry(7)] }] }],
    [{ weekday: { en: 'Sat', cn: '六', ja: '土', id: 6 }, items: [] }],
    1_700_000_000,
  )
}

/**
 * Publishes into a Blob namespace the way the platform allows: immutable objects
 * through the store, and the release pointer through a single writer (Blob has no
 * conditional write, so `publishBuilderCheckpoint` reports `cas_unsupported`).
 */
async function seededBlob(): Promise<MemoryEdgeOneBlob> {
  const blob = new MemoryEdgeOneBlob()
  const store = new EdgeOnePublicStore(blob)
  const db = openBuilderDatabase(':memory:')
  try {
    const state = new SqliteBuilderStateStore(db)
    const runs = new SyncRunStore(db)
    await runBuilderSyncJob({
      state,
      runs,
      runId: 'edgeone-read',
      mode: 'incremental',
      ownerToken: 'edgeone',
      fetchInput: async () => fetchFixture(),
      now: () => 1_700_000_000_000,
      projectFetchMediaHints: true,
    })
    const published = await publishBuilderCheckpoint({
      state,
      publicStore: store,
      manifestMetadata: { source_observed_at: '2026-01-01T00:00:00.000Z', git_sha: 'e'.repeat(40) },
    })
    assert.equal(published.status, 'cas_unsupported', 'Blob publishing fails closed on the pointer commit')

    const pointer = await store.getCurrentRelease()
    assert.equal(pointer, null, 'no pointer was written by the failed commit')
    const snapshotKeys = await store.listObjectKeys('snapshots/')
    assert.equal(snapshotKeys.length, 1, 'the immutable snapshot object was still written')

    // Single-writer pointer move, as an operator/local publisher would do.
    const snapshotBytes = await store.getSnapshotBytes(snapshotKeys[0]!)
    assert.notEqual(snapshotBytes, null)
    const parsed = JSON.parse(new TextDecoder().decode(snapshotBytes!)) as {
      generation: number
      content_hash: string
    }
    await blob.set(PUBLIC_RELEASE_POINTER_KEY, `${JSON.stringify({
      schema_version: 1,
      generation: parsed.generation,
      content_hash: parsed.content_hash,
      published_at_unix: parsed.generation,
      artifact_ref: snapshotKeys[0],
    })}\n`)
  } finally {
    db.close()
  }
  return blob
}

test('EdgeOne read gateway serves the v2 read surface from Blob', async () => {
  const blob = await seededBlob()
  const env = { publicBlob: blob, nsfwShow: false, packageVersion: '3.0.0-alpha.0' }

  const health = await handleEdgeOneReadRequest(new Request('https://edgeone.example/api/health'), env)
  assert.equal(health.status, 200)
  const healthBody = await health.json() as {
    ok: boolean
    data: { cron: { scheduler: string }; publish: { generation: number }; cache: { total_subjects: number } }
  }
  assert.equal(healthBody.ok, true)
  assert.equal(healthBody.data.cron.scheduler, 'external')
  assert.equal(healthBody.data.cache.total_subjects, 1)

  const collections = await handleEdgeOneReadRequest(
    new Request('https://edgeone.example/api/collections?type=watching&page=1&limit=24'),
    env,
  )
  assert.equal(collections.status, 200)
  assert.equal(collections.headers.get('Cache-Control'), V2_CACHE_CONTROL.collections)
  const collectionsBody = await collections.json() as { data: Array<{ subject_id: number }>; limit: number }
  assert.deepEqual(collectionsBody.data.map((item) => item.subject_id), [7])

  const calendar = await handleEdgeOneReadRequest(new Request('https://edgeone.example/api/calendar'), env)
  assert.equal(calendar.status, 200)
  assert.equal(calendar.headers.get('Cache-Control'), V2_CACHE_CONTROL.calendar)

  const version = await handleEdgeOneReadRequest(new Request('https://edgeone.example/api/version'), env)
  assert.deepEqual(await version.json(), {
    app: 'airingcal',
    read: 'edgeone',
    package: '3.0.0-alpha.0',
    platform: 'edgeone',
  })
})

test('EdgeOne read gateway fails closed without a verified pointer', async () => {
  const env = { publicBlob: new MemoryEdgeOneBlob() }
  const collections = await handleEdgeOneReadRequest(
    new Request('https://edgeone.example/api/collections?type=watching'),
    env,
  )
  assert.equal(collections.status, 503)
  const health = await handleEdgeOneReadRequest(new Request('https://edgeone.example/api/health'), env)
  assert.equal(health.status, 503)
})
