import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assembleFullFetch, type BgmCollection } from '@airing-cal/bgm-api'
import { MemoryR2Bucket } from '@airing-cal/v3-adapters/memory-r2-binding'
import { CloudflareR2PublicStore } from '@airing-cal/v3-adapters/cloudflare-r2-public-store'
import {
  openBuilderDatabase,
  publishBuilderCheckpoint,
  runBuilderSyncJob,
  SqliteBuilderStateStore,
  SyncRunStore,
} from '@airing-cal/v3-builder'
import { FilesystemPublicStore, PUBLIC_RELEASE_POINTER_KEY } from '@airing-cal/v3-core'
import { handleCloudflareReadRequest } from './cloudflare-read-handler.ts'
import { handlePortableReadRequest, type PortableReadEnv } from './portable-read-handler.ts'

const IMAGE_HASH = 'a'.repeat(64)
const THUMB_HASH = 'b'.repeat(64)
const COMMON_URL = 'https://lain.bgm.tv/pic/cover/c/common.jpg'
const LARGE_URL = 'https://lain.bgm.tv/pic/cover/l/large.jpg'

function collectionEntry(subjectId: number, collectionType: number, nsfw: boolean): BgmCollection {
  return {
    subject_id: subjectId,
    subject_type: 2,
    rate: 7,
    type: collectionType,
    comment: '',
    tags: ['x'],
    ep_status: 3,
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

/** Two collections (watching with image + NSFW, watched without image) plus one calendar item. */
function richFetch() {
  return assembleFullFetch(
    [{
      user_id: '1',
      pageLimit: 50,
      pages: [{ offset: 0, total: 2, data: [collectionEntry(11, 3, true), collectionEntry(12, 2, false)] }],
    }],
    [{
      weekday: { en: 'Sat', cn: '六', ja: '土', id: 6 },
      items: [{
        id: 11,
        type: 2,
        name: 'Subject 11',
        name_cn: '中文',
        summary: 'summary',
        nsfw: true,
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

interface PublishedStores {
  filesystem: FilesystemPublicStore
  r2: CloudflareR2PublicStore
  r2Bucket: MemoryR2Bucket
}

/** Publishes the same builder checkpoint into both public stores, as the operator path does. */
async function publishedStores(): Promise<PublishedStores> {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-parity-'))
  const filesystem = new FilesystemPublicStore(root)
  const r2Bucket = new MemoryR2Bucket()
  const r2 = new CloudflareR2PublicStore(r2Bucket)
  const db = openBuilderDatabase(':memory:')
  try {
    const state = new SqliteBuilderStateStore(db)
    const runs = new SyncRunStore(db)
    for (const [label, store] of [['fs', filesystem], ['r2', r2]] as const) {
      await runBuilderSyncJob({
        state,
        runs,
        runId: `parity-${label}`,
        mode: 'incremental',
        ownerToken: 'parity',
        fetchInput: async () => richFetch(),
        now: () => 1_700_000_000_000,
        projectFetchMediaHints: true,
      })
      const published = await publishBuilderCheckpoint({
        state,
        publicStore: store,
        manifestMetadata: { source_observed_at: '2026-01-01T00:00:00.000Z', git_sha: 'f'.repeat(40) },
      })
      assert.equal(published.status, 'published', `publish into ${label}`)
    }
  } finally {
    db.close()
  }

  const imageBytes = new TextEncoder().encode('parity-image-bytes')
  const thumbBytes = new TextEncoder().encode('parity-thumb-bytes')
  for (const store of [filesystem, r2]) {
    await store.putImmutableObject(`images/${IMAGE_HASH}/original`, imageBytes, 'image/jpeg')
    await store.putImmutableObject(`images/${THUMB_HASH}/thumb.v2.webp`, thumbBytes, 'image/webp')
  }
  return { filesystem, r2, r2Bucket }
}

function filesystemEnv(store: FilesystemPublicStore): PortableReadEnv {
  return {
    publicStore: store,
    nsfwShow: false,
    packageVersion: '3.0.0-alpha.0',
    processEnv: { AIRINGCAL_PLATFORM: 'portable' },
  }
}

/** Reads one route from both gateways: filesystem (portable) and R2 (Workers). */
async function readBoth(path: string, stores: PublishedStores) {
  const url = `https://parity.example${path}`
  const filesystemResponse = await handlePortableReadRequest(new Request(url), filesystemEnv(stores.filesystem))
  const r2Response = await handleCloudflareReadRequest(new Request(url), {
    publicR2: stores.r2Bucket,
    nsfwShow: false,
    packageVersion: '3.0.0-alpha.0',
  })
  return { filesystemResponse, r2Response }
}

test('portable and Cloudflare gateways serve identical payloads from one published release', async () => {
  const stores = await publishedStores()
  const routes = [
    '/api/collections?type=watching&page=1&limit=24',
    '/api/collections?type=watched&page=1&limit=24',
    '/api/calendar',
    '/api/cache?limit=24',
    '/api/config?key=nsfw',
    `/image/${IMAGE_HASH}`,
    `/image/${THUMB_HASH}/thumb`,
  ]
  for (const route of routes) {
    const { filesystemResponse, r2Response } = await readBoth(route, stores)
    assert.equal(r2Response.status, filesystemResponse.status, `${route} status`)
    assert.equal(
      r2Response.headers.get('Cache-Control'),
      filesystemResponse.headers.get('Cache-Control'),
      `${route} Cache-Control`,
    )
    assert.equal(
      r2Response.headers.get('Content-Type'),
      filesystemResponse.headers.get('Content-Type'),
      `${route} Content-Type`,
    )
    const [filesystemBody, r2Body] = await Promise.all([filesystemResponse.arrayBuffer(), r2Response.arrayBuffer()])
    assert.deepEqual(
      new Uint8Array(r2Body),
      new Uint8Array(filesystemBody),
      `${route} payload must be byte-identical across public stores`,
    )
  }
})

test('portable and Cloudflare gateways agree on health, release identity and layouts', async () => {
  const stores = await publishedStores()
  const { filesystemResponse, r2Response } = await readBoth('/api/health', stores)
  const filesystemText = await filesystemResponse.text()
  const r2Text = await r2Response.text()
  assert.equal(r2Text, filesystemText)

  const body = JSON.parse(r2Text) as {
    ok: boolean
    data: {
      publish: { generation: number; artifact_ref: string; content_hash: string }
      cron: { scheduler: string }
      cache: { total_subjects: number }
    }
  }
  assert.equal(body.ok, true)
  assert.equal(body.data.publish.artifact_ref, `snapshots/v1/${body.data.publish.generation}-${body.data.publish.content_hash}.json`)
  assert.equal(body.data.cron.scheduler, 'external')
  assert.equal(body.data.cache.total_subjects, 2, 'fixture has two collection subjects')

  for (const [label, store] of [['filesystem', stores.filesystem], ['r2', stores.r2]] as const) {
    const pointer = await store.getCurrentRelease()
    assert.equal(pointer?.generation, body.data.publish.generation, `${label} pointer generation`)
    assert.equal(pointer?.artifact_ref, body.data.publish.artifact_ref, `${label} pointer artifact`)
    const manifest = await store.getSnapshotBytes('public/manifest.json')
    assert.notEqual(manifest, null, `${label} must publish the same manifest layout`)
  }

  const pointer = (store: FilesystemPublicStore | CloudflareR2PublicStore) =>
    store.getSnapshotBytes(PUBLIC_RELEASE_POINTER_KEY)
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode((await pointer(stores.r2)) ?? new Uint8Array())),
    JSON.parse(new TextDecoder().decode((await pointer(stores.filesystem)) ?? new Uint8Array())),
    'release pointers must match across stores',
  )
})

test('gateway version payload differs only by platform identity', async () => {
  const stores = await publishedStores()
  const { filesystemResponse, r2Response } = await readBoth('/api/version', stores)
  assert.deepEqual(await filesystemResponse.json(), {
    app: 'airingcal',
    read: 'portable',
    package: '3.0.0-alpha.0',
    platform: 'portable',
  })
  assert.deepEqual(await r2Response.json(), {
    app: 'airingcal',
    read: 'cloudflare',
    package: '3.0.0-alpha.0',
    platform: 'cloudflare',
  })
})
