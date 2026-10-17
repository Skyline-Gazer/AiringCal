import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleFullFetch, type BgmCollection } from '@airing-cal/bgm-api'
import {
  openBuilderDatabase,
  publishBuilderCheckpoint,
  runBuilderSyncJob,
  SqliteBuilderStateStore,
  SyncRunStore,
} from '@airing-cal/v3-builder'
import { MemoryPublicStore } from '@airing-cal/v3-core'
import { handlePortableReadRequest } from '@airing-cal/v3-read/portable-read-handler'
import { PUBLIC_READ_MODE_KV_KEY, type PublicSnapshotV1 } from '@airing-cal/storage'
import { handleReadRequest, type WebWorkerEnv } from './read-api.ts'

const COMMON_URL = 'https://lain.bgm.tv/pic/cover/c/common.jpg'
const LARGE_URL = 'https://lain.bgm.tv/pic/cover/l/large.jpg'

function collectionEntry(subjectId: number, collectionType: number, nsfw: boolean): BgmCollection {
  return {
    subject_id: subjectId,
    subject_type: 2,
    rate: 7,
    type: collectionType,
    comment: '',
    tags: ['tag'],
    ep_status: 2,
    vol_status: 0,
    updated_at: '2026-01-01T00:00:00.000Z',
    private: false,
    subject: {
      id: subjectId,
      type: 2,
      name: `Subject ${subjectId}`,
      name_cn: '中文',
      summary: 'summary',
      nsfw,
      date: '2026-01-01',
      eps: 12,
      total_episodes: 12,
      images: { large: LARGE_URL, common: COMMON_URL, medium: COMMON_URL, small: COMMON_URL, grid: COMMON_URL },
      rating: { score: 7, rank: 100, total: 10 },
    },
  }
}

function fetchFixture() {
  return assembleFullFetch(
    [{
      user_id: '1',
      pageLimit: 50,
      pages: [{ offset: 0, total: 2, data: [collectionEntry(11, 3, false), collectionEntry(12, 2, true)] }],
    }],
    [{
      weekday: { en: 'Sat', cn: '六', ja: '土', id: 6 },
      items: [{
        id: 11,
        type: 2,
        name: 'Subject 11',
        name_cn: '中文',
        summary: 'summary',
        nsfw: false,
        date: '2026-01-01',
        eps: 12,
        total_episodes: 12,
        images: { large: LARGE_URL, common: COMMON_URL, medium: COMMON_URL, small: COMMON_URL, grid: COMMON_URL },
        rating: { score: 7, rank: 100, total: 10 },
      }],
    }],
    1_700_000_000,
  )
}

/** Publishes one builder checkpoint into a memory public store, as the operator path does. */
async function publishedSnapshot(): Promise<{ store: MemoryPublicStore; snapshot: PublicSnapshotV1 }> {
  const store = new MemoryPublicStore()
  const db = openBuilderDatabase(':memory:')
  try {
    const state = new SqliteBuilderStateStore(db)
    const runs = new SyncRunStore(db)
    await runBuilderSyncJob({
      state,
      runs,
      runId: 'v2-v3-parity',
      mode: 'incremental',
      ownerToken: 'parity',
      fetchInput: async () => fetchFixture(),
      now: () => 1_700_000_000_000,
      projectFetchMediaHints: true,
    })
    const published = await publishBuilderCheckpoint({
      state,
      publicStore: store,
      manifestMetadata: { source_observed_at: '2026-01-01T00:00:00.000Z', git_sha: 'a'.repeat(40) },
    })
    assert.equal(published.status, 'published')
    const pointer = await store.getCurrentRelease()
    assert.notEqual(pointer, null)
    const bytes = await store.getSnapshotBytes(pointer!.artifact_ref)
    assert.notEqual(bytes, null)
    return { store, snapshot: JSON.parse(new TextDecoder().decode(bytes!)) as PublicSnapshotV1 }
  } finally {
    db.close()
  }
}

/**
 * v2 read path in R2 mode: the Worker reads `public:read-mode` from KV, then the
 * `public:current` pointer, then the snapshot object from the data bucket.
 */
function v2Env(snapshot: PublicSnapshotV1): WebWorkerEnv {
  const kvValues = new Map<string, unknown>([
    [PUBLIC_READ_MODE_KV_KEY, { mode: 'r2' }],
    ['public:current', {
      schema_version: 1,
      generation: snapshot.generation,
      content_hash: snapshot.content_hash,
      r2_key: `snapshots/v1/${snapshot.generation}-${snapshot.content_hash}.json`,
      published_at: snapshot.published_at,
    }],
  ])
  return {
    AIRING_CAL_D1: {} as WebWorkerEnv['AIRING_CAL_D1'],
    AIRING_CAL_DATA_R2: {
      async get(key: string) {
        if (key !== `snapshots/v1/${snapshot.generation}-${snapshot.content_hash}.json`) return null
        return { key, text: async () => JSON.stringify(snapshot) }
      },
    },
    AIRING_CAL_KV: {
      async get(key: string) {
        return kvValues.get(key) ?? null
      },
      async put() {},
      async delete() {},
      async list() {
        return { keys: [] }
      },
    },
    AIRING_CAL_R2: {} as WebWorkerEnv['AIRING_CAL_R2'],
    NSFW_SHOW: 'true',
  }
}

test('v2 Worker and v3 gateway return identical collection/calendar/config payloads for one release', async () => {
  const { store, snapshot } = await publishedSnapshot()
  const v2 = v2Env(snapshot)

  for (const route of [
    '/collections?type=watching&page=1&limit=24',
    '/collections?type=watched&page=1&limit=24',
    '/calendar',
    '/config',
  ]) {
    const v2Response = await handleReadRequest(new Request(`https://parity.example${route}`), v2)
    assert.notEqual(v2Response, null, `${route} must be served by the v2 Worker`)
    const v3Response = await handlePortableReadRequest(new Request(`https://parity.example/api${route}`), {
      publicStore: store,
      nsfwShow: true,
      processEnv: { AIRINGCAL_PLATFORM: 'portable' },
    })
    assert.equal(v3Response.status, v2Response!.status, `${route} status`)
    assert.equal(
      v3Response.headers.get('Cache-Control'),
      v2Response!.headers.get('Cache-Control'),
      `${route} Cache-Control`,
    )
    assert.deepEqual(
      await v3Response.json(),
      await v2Response!.json(),
      `${route} payload must match the v2 Worker`,
    )
  }
})
