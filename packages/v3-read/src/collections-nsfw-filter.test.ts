import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPublicSnapshot, canonicalSnapshotBytes, snapshotObjectKey } from '@airing-cal/domain'
import type { PublicCollectionItemV1 } from '@airing-cal/storage'
import { MemoryPublicStore, V2_CACHE_CONTROL } from '@airing-cal/v3-core'
import type { PublicReleasePointer } from '@airing-cal/v3-core/ports'
import { handlePortableReadRequest } from './portable-read-handler.ts'

function item(subjectId: number, nsfw: boolean): PublicCollectionItemV1 {
  return {
    subject_id: subjectId,
    name: `Subject ${subjectId}`,
    name_cn: '',
    summary: '',
    images: { common: null, large: null },
    image_status: { common: 'pending_next_cron', large: 'pending_next_cron' },
    eps: 0,
    total_episodes: 0,
    ep_status: 0,
    vol_status: 0,
    type: 2,
    collection_type: 3,
    rate: 0,
    nsfw,
    date: '',
    tags: [],
    updated_at: '',
  }
}

async function storeWithMixedNsfw(): Promise<MemoryPublicStore> {
  const snapshot = await buildPublicSnapshot({
    collections: [
      item(1, false),
      item(2, true),
      item(3, false),
      item(4, true),
      item(5, false),
    ],
    calendar: [],
    published_at: 1_722_000_000,
  }, 1)
  const store = new MemoryPublicStore()
  await store.putImmutableObject(snapshotObjectKey(snapshot), canonicalSnapshotBytes(snapshot), 'application/json')
  const pointer: PublicReleasePointer = {
    schema_version: 1,
    generation: snapshot.generation,
    content_hash: snapshot.content_hash,
    published_at_unix: snapshot.published_at,
    artifact_ref: snapshotObjectKey(snapshot),
  }
  store.current = pointer
  return store
}

const env = (store: MemoryPublicStore) => ({ publicStore: store, nsfwShow: true })

test('nsfw=hide filters before totals and pagination', async () => {
  const store = await storeWithMixedNsfw()
  const response = await handlePortableReadRequest(
    new Request('https://local/api/collections?type=watching&page=2&limit=2&nsfw=hide'),
    env(store),
  )
  assert.equal(response.status, 200)
  const body = await response.json() as { data: Array<{ subject_id: number; nsfw: boolean }>; total: number; page: number; limit: number }
  assert.equal(body.total, 3)
  assert.equal(body.page, 2)
  assert.equal(body.limit, 2)
  assert.deepEqual(body.data.map((entry) => entry.subject_id), [5])
  assert.equal(body.data.every((entry) => entry.nsfw === false), true)
})

test('omitting nsfw keeps the original contract; nsfw=show is equivalent', async () => {
  const store = await storeWithMixedNsfw()
  const all = await handlePortableReadRequest(
    new Request('https://local/api/collections?type=watching&page=1&limit=10'),
    env(store),
  )
  const shown = await handlePortableReadRequest(
    new Request('https://local/api/collections?type=watching&page=1&limit=10&nsfw=show'),
    env(store),
  )
  const allBody = await all.json() as { total: number; data: unknown[] }
  const shownBody = await shown.json() as { total: number; data: unknown[] }
  assert.equal(allBody.total, 5)
  assert.equal(shownBody.total, 5)
  assert.deepEqual(shownBody.data, allBody.data)
  assert.equal(all.headers.get('ETag'), shown.headers.get('ETag'))
})

test('invalid nsfw values are rejected without touching the store', async () => {
  const store = await storeWithMixedNsfw()
  const response = await handlePortableReadRequest(
    new Request('https://local/api/collections?type=watching&nsfw=maybe'),
    env(store),
  )
  assert.equal(response.status, 400)
  const body = await response.json() as { error: { code: string } }
  assert.equal(body.error.code, 'INVALID_QUERY')
  assert.equal(response.headers.get('Cache-Control'), V2_CACHE_CONTROL.error)
})

test('filtered responses carry their own ETag and 304', async () => {
  const store = await storeWithMixedNsfw()
  const filtered = await handlePortableReadRequest(
    new Request('https://local/api/collections?type=watching&nsfw=hide'),
    env(store),
  )
  const unfiltered = await handlePortableReadRequest(
    new Request('https://local/api/collections?type=watching'),
    env(store),
  )
  const filteredEtag = filtered.headers.get('ETag')
  assert.ok(filteredEtag)
  assert.notEqual(filteredEtag, unfiltered.headers.get('ETag'))

  const notModified = await handlePortableReadRequest(
    new Request('https://local/api/collections?type=watching&nsfw=hide', {
      headers: { 'If-None-Match': filteredEtag! },
    }),
    env(store),
  )
  assert.equal(notModified.status, 304)
  assert.equal(notModified.headers.get('ETag'), filteredEtag)
  assert.equal(await notModified.text(), '')
})
