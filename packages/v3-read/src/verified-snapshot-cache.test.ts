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
import { MemoryPublicStore } from '@airing-cal/v3-core'
import type { PublicReleasePointer, PublicStore } from '@airing-cal/v3-core/ports'
import { createVerifiedSnapshotCache } from './verified-snapshot-cache.ts'

const GIT_SHA = 'b'.repeat(40)

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

async function makeRelease(
  generation: number,
  subjectId: number,
  publishedAt = 1_722_000_000,
): Promise<{ snapshot: PublicSnapshotV1; pointer: PublicReleasePointer; snapshotBytes: Uint8Array; manifestBytes: Uint8Array }> {
  const snapshot = await buildPublicSnapshot(
    { collections: [collectionItem(subjectId)], calendar, published_at: publishedAt },
    generation,
  )
  const snapshotBytes = canonicalSnapshotBytes(snapshot)
  const manifest = buildManifest(snapshot, {
    source_observed_at: '2024-07-26T18:40:01.000Z',
    git_sha: GIT_SHA,
  })
  const manifestBytes = new TextEncoder().encode(canonicalJson(manifest))
  const manifestRef = manifestObjectKey(snapshot.generation, await sha256Canonical(manifest))
  const pointer: PublicReleasePointer = {
    schema_version: 1,
    generation: snapshot.generation,
    content_hash: snapshot.content_hash,
    published_at_unix: snapshot.published_at,
    artifact_ref: snapshotObjectKey(snapshot),
    manifest_ref: manifestRef,
  }
  return { snapshot, pointer, snapshotBytes, manifestBytes }
}

function countingStore(inner: MemoryPublicStore): PublicStore & {
  pointerReads: number
  byteReads: number
  totalReads: number
  resetCounts(): void
} {
  const store = {
    pointerReads: 0,
    byteReads: 0,
    get totalReads() {
      return store.pointerReads + store.byteReads
    },
    resetCounts() {
      store.pointerReads = 0
      store.byteReads = 0
    },
    async getCurrentRelease() {
      store.pointerReads++
      return inner.getCurrentRelease()
    },
    async getSnapshotBytes(artifactRef: string) {
      store.byteReads++
      return inner.getSnapshotBytes(artifactRef)
    },
    putImmutableObject: (key: string, body: Uint8Array, contentType: string) =>
      inner.putImmutableObject(key, body, contentType),
    commitRelease: (expected: PublicReleasePointer | null, next: PublicReleasePointer) =>
      inner.commitRelease(expected, next),
  }
  return store
}

async function seedStore(
  store: MemoryPublicStore,
  release: Awaited<ReturnType<typeof makeRelease>>,
): Promise<void> {
  await store.putImmutableObject(release.pointer.artifact_ref, release.snapshotBytes, 'application/json')
  await store.putImmutableObject(release.pointer.manifest_ref!, release.manifestBytes, 'application/json')
  store.current = release.pointer
}

test('cold miss loads pointer + snapshot + manifest (3 store reads)', async () => {
  const inner = new MemoryPublicStore()
  const release = await makeRelease(1, 101)
  await seedStore(inner, release)
  const store = countingStore(inner)
  const cache = createVerifiedSnapshotCache({ softTtlMs: 60_000, now: () => 1_000 })

  const loaded = await cache.load(store)

  assert.ok(loaded)
  assert.equal(loaded.generation, 1)
  assert.equal(loaded.content_hash, release.pointer.content_hash)
  assert.equal(loaded.artifact_ref, release.pointer.artifact_ref)
  assert.equal(store.pointerReads, 1)
  assert.equal(store.byteReads, 2)
  assert.equal(store.totalReads, 3)
})

test('hot hit within soft TTL returns resident snapshot with zero store reads', async () => {
  const inner = new MemoryPublicStore()
  const release = await makeRelease(1, 101)
  await seedStore(inner, release)
  const store = countingStore(inner)
  let now = 1_000
  const cache = createVerifiedSnapshotCache({ softTtlMs: 60_000, now: () => now })

  await cache.load(store)
  store.resetCounts()
  now = 30_000

  const loaded = await cache.load(store)

  assert.ok(loaded)
  assert.equal(loaded.generation, 1)
  assert.equal(store.totalReads, 0)
})

test('soft TTL not expired does not fetch pointer', async () => {
  const inner = new MemoryPublicStore()
  const release = await makeRelease(1, 101)
  await seedStore(inner, release)
  const store = countingStore(inner)
  let now = 0
  const cache = createVerifiedSnapshotCache({ softTtlMs: 60_000, now: () => now })

  await cache.load(store)
  store.resetCounts()
  now = 59_999
  const bumped = await makeRelease(2, 202)
  await seedStore(inner, bumped)

  const loaded = await cache.load(store)

  assert.ok(loaded)
  assert.equal(loaded.generation, 1)
  assert.equal(store.pointerReads, 0)
  assert.equal(store.totalReads, 0)
})

test('two concurrent cold loads share one in-flight fetch (singleflight)', async () => {
  const inner = new MemoryPublicStore()
  const release = await makeRelease(1, 101)
  await seedStore(inner, release)

  let resolvePointer!: (value: PublicReleasePointer | null) => void
  const pointerGate = new Promise<PublicReleasePointer | null>((resolve) => {
    resolvePointer = resolve
  })
  let pointerCalls = 0
  let byteCalls = 0
  const store: PublicStore = {
    async getCurrentRelease() {
      pointerCalls++
      return pointerGate
    },
    async getSnapshotBytes(artifactRef: string) {
      byteCalls++
      return inner.getSnapshotBytes(artifactRef)
    },
    putImmutableObject: (key, body, contentType) => inner.putImmutableObject(key, body, contentType),
    commitRelease: (expected, next) => inner.commitRelease(expected, next),
  }

  const cache = createVerifiedSnapshotCache({ softTtlMs: 60_000, now: () => 0 })
  const first = cache.load(store)
  const second = cache.load(store)

  await Promise.resolve()
  assert.equal(pointerCalls, 1)
  resolvePointer(release.pointer)

  const [a, b] = await Promise.all([first, second])
  assert.ok(a)
  assert.ok(b)
  assert.equal(a, b)
  assert.equal(a.generation, 1)
  assert.equal(pointerCalls, 1)
  assert.equal(byteCalls, 2)
})

test('generation bump after soft TTL triggers full reload', async () => {
  const inner = new MemoryPublicStore()
  const firstRelease = await makeRelease(1, 101)
  await seedStore(inner, firstRelease)
  const store = countingStore(inner)
  let now = 0
  const cache = createVerifiedSnapshotCache({ softTtlMs: 60_000, now: () => now })

  const first = await cache.load(store)
  assert.equal(first?.generation, 1)

  const secondRelease = await makeRelease(2, 202)
  await seedStore(inner, secondRelease)
  store.resetCounts()
  now = 60_000

  const second = await cache.load(store)

  assert.ok(second)
  assert.equal(second.generation, 2)
  assert.equal(second.content_hash, secondRelease.pointer.content_hash)
  assert.equal(store.pointerReads, 1)
  assert.equal(store.byteReads, 2)
  assert.equal(store.totalReads, 3)
})

test('rollback to older generation/hash reloads and matches rolled-back pointer identity', async () => {
  const inner = new MemoryPublicStore()
  const newer = await makeRelease(5, 505)
  await seedStore(inner, newer)
  const store = countingStore(inner)
  let now = 0
  const cache = createVerifiedSnapshotCache({ softTtlMs: 60_000, now: () => now })

  const warm = await cache.load(store)
  assert.equal(warm?.generation, 5)

  const older = await makeRelease(3, 303)
  await seedStore(inner, older)
  store.resetCounts()
  now = 60_000

  const rolled = await cache.load(store)

  assert.ok(rolled)
  assert.equal(rolled.generation, older.pointer.generation)
  assert.equal(rolled.content_hash, older.pointer.content_hash)
  assert.equal(rolled.artifact_ref, older.pointer.artifact_ref)
  assert.equal(store.totalReads, 3)
})

test('soft revalidate with unchanged four-field identity refreshes loadedAt without full reload', async () => {
  const inner = new MemoryPublicStore()
  const release = await makeRelease(1, 101)
  await seedStore(inner, release)
  const store = countingStore(inner)
  let now = 0
  const cache = createVerifiedSnapshotCache({ softTtlMs: 60_000, now: () => now })

  await cache.load(store)
  store.resetCounts()
  now = 60_000

  const refreshed = await cache.load(store)
  assert.ok(refreshed)
  assert.equal(refreshed.generation, 1)
  assert.equal(store.pointerReads, 1)
  assert.equal(store.byteReads, 0)

  store.resetCounts()
  now = 90_000
  const stillHot = await cache.load(store)
  assert.ok(stillHot)
  assert.equal(store.totalReads, 0)
})

test('manifest_ref missing vs present is treated as identity change', async () => {
  const inner = new MemoryPublicStore()
  const withManifest = await makeRelease(1, 101)
  await seedStore(inner, withManifest)
  const store = countingStore(inner)
  let now = 0
  const cache = createVerifiedSnapshotCache({ softTtlMs: 60_000, now: () => now })

  await cache.load(store)

  inner.current = {
    schema_version: 1,
    generation: withManifest.pointer.generation,
    content_hash: withManifest.pointer.content_hash,
    published_at_unix: withManifest.pointer.published_at_unix,
    artifact_ref: withManifest.pointer.artifact_ref,
  }
  store.resetCounts()
  now = 60_000

  const loaded = await cache.load(store)
  assert.ok(loaded)
  assert.equal(loaded.generation, 1)
  assert.equal(store.pointerReads, 1)
  assert.ok(store.byteReads >= 1)
})

test('clear drops resident entry so next load is cold', async () => {
  const inner = new MemoryPublicStore()
  const release = await makeRelease(1, 101)
  await seedStore(inner, release)
  const store = countingStore(inner)
  const cache = createVerifiedSnapshotCache({ softTtlMs: 60_000, now: () => 0 })

  await cache.load(store)
  cache.clear()
  store.resetCounts()

  const loaded = await cache.load(store)
  assert.ok(loaded)
  assert.equal(store.totalReads, 3)
})
