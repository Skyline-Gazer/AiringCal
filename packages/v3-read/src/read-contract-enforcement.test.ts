import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildManifest,
  buildPublicSnapshot,
  canonicalSnapshotBytes,
  manifestObjectKey,
  snapshotObjectKey,
} from '@airing-cal/domain'
import { canonicalJson, sha256Canonical } from '@airing-cal/storage'
import type { PublicCalendarDayV1, PublicCollectionItemV1, PublicSnapshotV1 } from '@airing-cal/storage'
import { MemoryPublicStore, V2_CACHE_CONTROL } from '@airing-cal/v3-core'
import type { PublicReleasePointer, PublicStore } from '@airing-cal/v3-core/ports'
import { handlePortableReadRequest } from './portable-read-handler.ts'
import { handlePortableStaticRequest } from './portable-static-handler.ts'
import { loadVerifiedPublicSnapshot } from './load-public-snapshot.ts'

const GIT_SHA = 'c'.repeat(40)

function collectionItem(subjectId: number): PublicCollectionItemV1 {
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
    collection_type: 1,
    rate: 0,
    nsfw: false,
    date: '',
    tags: [],
    updated_at: '',
  }
}

const calendar: PublicCalendarDayV1[] = []

async function makeRelease(generation: number, subjectId: number): Promise<{
  snapshot: PublicSnapshotV1
  pointer: PublicReleasePointer
  snapshotBytes: Uint8Array
  manifestBytes: Uint8Array
}> {
  const snapshot = await buildPublicSnapshot(
    { collections: [collectionItem(subjectId)], calendar, published_at: 1_722_000_000 },
    generation,
  )
  const snapshotBytes = canonicalSnapshotBytes(snapshot)
  const manifest = buildManifest(snapshot, {
    source_observed_at: '2024-07-26T18:40:01.000Z',
    git_sha: GIT_SHA,
  })
  const manifestBytes = new TextEncoder().encode(canonicalJson(manifest))
  const pointer: PublicReleasePointer = {
    schema_version: 1,
    generation: snapshot.generation,
    content_hash: snapshot.content_hash,
    published_at_unix: snapshot.published_at,
    artifact_ref: snapshotObjectKey(snapshot),
    manifest_ref: manifestObjectKey(snapshot.generation, await sha256Canonical(manifest)),
  }
  return { snapshot, pointer, snapshotBytes, manifestBytes }
}

async function publishedStore(): Promise<{ store: MemoryPublicStore; pointer: PublicReleasePointer; snapshot: PublicSnapshotV1 }> {
  const release = await makeRelease(7, 42)
  const store = new MemoryPublicStore()
  await store.putImmutableObject(release.pointer.artifact_ref, release.snapshotBytes, 'application/json')
  await store.putImmutableObject(release.pointer.manifest_ref!, release.manifestBytes, 'application/json')
  await store.commitRelease(null, release.pointer)
  return { store, pointer: release.pointer, snapshot: release.snapshot }
}

/** Wraps a store and counts every read so refusals can be proven side-effect-free. */
function countingStore(inner: MemoryPublicStore): PublicStore & { reads: number } {
  let reads = 0
  return {
    get reads() {
      return reads
    },
    async getCurrentRelease() {
      reads += 1
      return inner.getCurrentRelease()
    },
    async getSnapshotBytes(key: string) {
      reads += 1
      return inner.getSnapshotBytes(key)
    },
    headObject: (key) => inner.headObject(key),
    putImmutableObject: (key, bytes, contentType) => inner.putImmutableObject(key, bytes, contentType),
    commitRelease: (expected, next) => inner.commitRelease(expected, next),
  }
}

test('non-GET/HEAD methods are refused with 405 + Allow and never touch the store', async () => {
  const { store } = await publishedStore()
  const counting = countingStore(store)
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const response = await handlePortableReadRequest(
      new Request('https://local/api/collections', { method }),
      { publicStore: counting },
    )
    assert.equal(response.status, 405, `${method} must be refused`)
    assert.equal(response.headers.get('Allow'), 'GET, HEAD', `${method} Allow header`)
    assert.equal(response.headers.get('Cache-Control'), V2_CACHE_CONTROL.error, `${method} no-store`)
  }
  assert.equal(counting.reads, 0, 'refusal must not read the store')
})

test('snapshot routes carry a release-identity ETag and answer If-None-Match with 304', async () => {
  const { store, pointer, snapshot } = await publishedStore()
  const expectedEtag = `"g${pointer.generation}-${pointer.content_hash}"`
  assert.equal(snapshot.content_hash, pointer.content_hash)
  for (const [path, cacheControl] of [
    ['/api/collections', V2_CACHE_CONTROL.collections],
    ['/api/calendar', V2_CACHE_CONTROL.calendar],
    ['/api/cache', V2_CACHE_CONTROL.defaultJson],
  ] as const) {
    const first = await handlePortableReadRequest(new Request(`https://local${path}`), { publicStore: store })
    assert.equal(first.status, 200)
    assert.equal(first.headers.get('ETag'), expectedEtag, `${path} ETag`)
    const conditional = await handlePortableReadRequest(
      new Request(`https://local${path}`, { headers: { 'If-None-Match': expectedEtag } }),
      { publicStore: store },
    )
    assert.equal(conditional.status, 304, `${path} conditional GET`)
    assert.equal(conditional.headers.get('ETag'), expectedEtag, `${path} 304 ETag`)
    assert.equal(conditional.headers.get('Cache-Control'), cacheControl, `${path} 304 Cache-Control`)
    assert.equal(await conditional.text(), '', `${path} 304 body must be empty`)
    const staleValidator = await handlePortableReadRequest(
      new Request(`https://local${path}`, { headers: { 'If-None-Match': '"g6-older"' } }),
      { publicStore: store },
    )
    assert.equal(staleValidator.status, 200, `${path} stale validator must refetch`)
  }
})

test('HEAD on a snapshot route returns 200 headers with the ETag', async () => {
  const { store, pointer } = await publishedStore()
  const response = await handlePortableReadRequest(
    new Request('https://local/api/calendar', { method: 'HEAD' }),
    { publicStore: store },
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('ETag'), `"g${pointer.generation}-${pointer.content_hash}"`)
})

test('a pointer whose artifact_ref escapes the snapshot prefix fails closed without reading the object', async () => {
  const release = await makeRelease(8, 43)
  const store = new MemoryPublicStore()
  await store.putImmutableObject(release.pointer.artifact_ref, release.snapshotBytes, 'application/json')
  await store.putImmutableObject('checkpoints/latest.sqlite', new Uint8Array([1, 2, 3]), 'application/octet-stream')
  await store.commitRelease(null, { ...release.pointer, artifact_ref: 'checkpoints/latest.sqlite' })
  const counting = countingStore(store)
  await assert.rejects(
    () => loadVerifiedPublicSnapshot(counting),
    /artifact_ref is not the content-addressed snapshot key/,
  )
  assert.equal(counting.reads, 1, 'only the pointer is read; the escaped object is never fetched')
  const response = await handlePortableReadRequest(new Request('https://local/api/calendar'), { publicStore: store })
  assert.equal(response.status, 503)
  const body = await response.json() as { error?: { code?: string } }
  assert.equal(body.error?.code, 'RELEASE_INVALID')
})

test('a pointer whose manifest_ref is not a content-addressed manifest key fails closed', async () => {
  const release = await makeRelease(9, 44)
  const store = new MemoryPublicStore()
  await store.putImmutableObject(release.pointer.artifact_ref, release.snapshotBytes, 'application/json')
  await store.putImmutableObject('checkpoints/manifest.json', release.manifestBytes, 'application/json')
  await store.commitRelease(null, { ...release.pointer, manifest_ref: 'checkpoints/manifest.json' })
  await assert.rejects(
    () => loadVerifiedPublicSnapshot(store),
    /manifest_ref is not a content-addressed manifest key/,
  )
})

test('dot-segment manifest_ref traversal is refused', async () => {
  const release = await makeRelease(10, 45)
  const store = new MemoryPublicStore()
  await store.putImmutableObject(release.pointer.artifact_ref, release.snapshotBytes, 'application/json')
  await store.commitRelease(null, { ...release.pointer, manifest_ref: 'public/manifests/../../checkpoints/x-0000000000000000000000000000000000000000000000000000000000000000.json' })
  await assert.rejects(
    () => loadVerifiedPublicSnapshot(store),
    /manifest_ref is not a content-addressed manifest key/,
  )
})

test('static handler refuses non-GET/HEAD methods with 405 + Allow', () => {
  for (const path of ['/', '/src/bangumi.js', '/src/bangumi.css']) {
    const response = handlePortableStaticRequest(
      new Request(`https://local${path}`, { method: 'POST' }),
    )
    assert.ok(response, `${path} POST must be refused by the static handler itself`)
    assert.equal(response.status, 405, path)
    assert.equal(response.headers.get('Allow'), 'GET, HEAD', path)
  }
  const head = handlePortableStaticRequest(new Request('https://local/', { method: 'HEAD' }))
  assert.equal(head?.status, 200, 'HEAD on the index page still serves')
  const deprecated = handlePortableStaticRequest(new Request('https://local/api/sync/apply', { method: 'POST' }))
  assert.equal(deprecated?.status, 410, 'deprecated sync routes keep answering 410 ahead of the method guard')
})

test('If-None-Match follows RFC 9110: weak validators, lists, and * (ShipReview #4)', async () => {
  const { store, pointer } = await publishedStore()
  const expectedEtag = `"g${pointer.generation}-${pointer.content_hash}"`
  for (const header of [`W/${expectedEtag}`, `"stale", ${expectedEtag}`, '*', `${expectedEtag}, "x"`]) {
    const res = await handlePortableReadRequest(
      new Request('https://local/api/cache', { headers: { 'If-None-Match': header } }),
      { publicStore: store },
    )
    assert.equal(res.status, 304, `${header} must match (got ${res.status})`)
  }
  for (const header of ['W/"g9-nope"', '"a", "b"']) {
    const res = await handlePortableReadRequest(
      new Request('https://local/api/cache', { headers: { 'If-None-Match': header } }),
      { publicStore: store },
    )
    assert.equal(res.status, 200, `${header} must not match`)
  }
})

test('unknown paths answer 404 with NO published release — never 503 (ShipReview #3)', async () => {
  const empty = new MemoryPublicStore()
  for (const path of [
    '/checkpoints/_isolation-probe.txt',
    '/checkpoints/latest.sqlite',
    '/whatever.txt',
    '/snapshots/v9/1-' + 'a'.repeat(64) + '.json',
  ]) {
    for (const method of ['GET', 'HEAD'] as const) {
      const res = await handlePortableReadRequest(new Request(`https://local${path}`, { method }), {
        publicStore: empty,
      })
      assert.equal(res.status, 404, `${method} ${path} on a clean bucket must be 404 (got ${res.status})`)
    }
  }
  // release-dependent routes keep their 503 NO_RELEASE semantics
  const api = await handlePortableReadRequest(new Request('https://local/api/collections'), {
    publicStore: empty,
  })
  assert.equal(api.status, 503)
})

test('deprecated sync routes answer 410 on EVERY method and runtime entry (ShipReview #7)', async () => {
  const { store } = await publishedStore()
  const env = { publicStore: store }
  for (const path of ['/api/sync/apply', '/api/sync/compare', '/api/check/whatever', '/sync/apply', '/check/x']) {
    for (const method of ['GET', 'POST', 'OPTIONS', 'DELETE'] as const) {
      const res = await handlePortableReadRequest(
        new Request(`https://local${path}`, { method, headers: { Origin: 'https://embed.test' } }),
        { ...env, corsAllowedOrigins: ['https://embed.test'] },
      )
      assert.equal(res.status, 410, `${method} ${path} -> ${res.status}; old clients must learn it is GONE`)
    }
  }
  // The CF/Node entries (static-first) keep identical semantics:
  const { handlePortableStaticRequest } = await import('./portable-static-handler.ts')
  const staticGone = handlePortableStaticRequest(new Request('https://local/api/sync/apply', { method: 'POST' }))
  assert.equal(staticGone?.status, 410)
})
