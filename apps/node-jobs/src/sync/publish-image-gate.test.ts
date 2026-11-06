import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { PublicSnapshotV1 } from '@airing-cal/storage'
import { MemoryPublicStore, type PublicStore } from '@airing-cal/v3-core'
import { imageOriginalKey, imageThumbV2Key } from '@airing-cal/storage'
import { ensurePublishImagesComplete } from './publish-image-gate.ts'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function snapshotWithHashes(hashes: string[]): PublicSnapshotV1 {
  const items = hashes.map((hash) => ({
    subject_id: 1,
    images: { common: { hash, uri: '', r2_key: '' }, large: null },
  }))
  return {
    collections: { want: items, watched: [], watching: [], on_hold: [], dropped: [] },
    calendar: [],
  } as unknown as PublicSnapshotV1
}

class CountingPublicStore implements PublicStore {
  puts: string[] = []
  gets: string[] = []
  constructor(private readonly inner: PublicStore) {}

  async getCurrentRelease() {
    return this.inner.getCurrentRelease()
  }

  async getSnapshotBytes(ref: string) {
    this.gets.push(ref)
    return this.inner.getSnapshotBytes(ref)
  }
  async headObject(key: string) {
    return this.inner.headObject?.(key) ?? null
  }

  async putImmutableObject(key: string, body: Uint8Array, contentType: string) {
    this.puts.push(key)
    return this.inner.putImmutableObject(key, body, contentType)
  }

  async commitRelease(expected: Parameters<PublicStore['commitRelease']>[0], next: Parameters<PublicStore['commitRelease']>[1]) {
    return this.inner.commitRelease(expected, next)
  }
}

interface HeadShape {
  size: number
  etag: string | null
}

/** Store whose headObject reports S3-style md5 etags so the etag/size fast path is exercised. */
class Md5HeadStore implements PublicStore {
  constructor(private readonly inner: MemoryPublicStore) {}

  async getCurrentRelease() {
    return this.inner.getCurrentRelease()
  }

  async getSnapshotBytes(ref: string) {
    return this.inner.getSnapshotBytes(ref)
  }

  async putImmutableObject(key: string, body: Uint8Array, contentType: string) {
    return this.inner.putImmutableObject(key, body, contentType)
  }

  async commitRelease(expected: Parameters<PublicStore['commitRelease']>[0], next: Parameters<PublicStore['commitRelease']>[1]) {
    return this.inner.commitRelease(expected, next)
  }

  async headObject(key: string): Promise<HeadShape | null> {
    const bytes = await this.inner.getSnapshotBytes(key)
    if (!bytes) return null
    return { size: bytes.byteLength, etag: `"${createHash('md5').update(bytes).digest('hex')}"` }
  }
}

test('ensurePublishImagesComplete uploads missing referenced images from the local root', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-gate-'))
  try {
    mkdirSync(join(dir, 'images', HASH_A), { recursive: true })
    writeFileSync(join(dir, 'images', HASH_A, 'original'), 'orig-a')
    writeFileSync(join(dir, 'images', HASH_A, 'thumb.v2.webp'), 'thumb-a')
    const store = new MemoryPublicStore()
    const result = await ensurePublishImagesComplete({
      snapshot: snapshotWithHashes([HASH_A]),
      publicStore: store,
      imageRoot: dir,
    })
    assert.equal(result.hashes, 1)
    assert.equal(result.uploaded, 2)
    assert.equal(result.reused, 0)
    assert.equal(new TextDecoder().decode((await store.getSnapshotBytes(imageOriginalKey(HASH_A)))!), 'orig-a')
    assert.equal(new TextDecoder().decode((await store.getSnapshotBytes(imageThumbV2Key(HASH_A)))!), 'thumb-a')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensurePublishImagesComplete fails closed when an existing immutable image object has different content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-gate-'))
  try {
    const store = new MemoryPublicStore()
    await store.putImmutableObject(imageOriginalKey(HASH_A), new TextEncoder().encode('public-oriG'), 'image/jpeg')
    await store.putImmutableObject(imageThumbV2Key(HASH_A), new TextEncoder().encode('public-thumb'), 'image/webp')
    mkdirSync(join(dir, 'images', HASH_A), { recursive: true })
    // Same byte length as the published object, different content: only a byte
    // comparison can detect it (the store exposes no comparable md5 etag).
    writeFileSync(join(dir, 'images', HASH_A, 'original'), 'local-orig')
    const counting = new CountingPublicStore(store)
    await assert.rejects(
      () =>
        ensurePublishImagesComplete({
          snapshot: snapshotWithHashes([HASH_A]),
          publicStore: counting,
          imageRoot: dir,
        }),
      /publish gate.*images\/[0-9a-f]{64}\/original.*differs/i,
    )
    assert.deepEqual(counting.puts, [], 'immutable content must never be overwritten')
    assert.equal(
      new TextDecoder().decode((await store.getSnapshotBytes(imageOriginalKey(HASH_A)))!),
      'public-oriG',
      'the published object must be left untouched',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensurePublishImagesComplete skips unchanged images by size/md5 etag without downloading or uploading (C5)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-gate-c5-'))
  try {
    const bytes = 'identical-image-bytes'
    const store = new Md5HeadStore(new MemoryPublicStore())
    await store.putImmutableObject(imageOriginalKey(HASH_A), new TextEncoder().encode(bytes), 'image/jpeg')
    await store.putImmutableObject(imageThumbV2Key(HASH_A), new TextEncoder().encode('thumb-bytes'), 'image/webp')
    mkdirSync(join(dir, 'images', HASH_A), { recursive: true })
    writeFileSync(join(dir, 'images', HASH_A, 'original'), bytes)
    const counting = new CountingPublicStore(store)
    const result = await ensurePublishImagesComplete({
      snapshot: snapshotWithHashes([HASH_A]),
      publicStore: counting,
      imageRoot: dir,
    })
    assert.equal(result.hashes, 1)
    assert.equal(result.skipped_unchanged, 1)
    assert.equal(result.reused, 1)
    assert.equal(result.uploaded, 0)
    assert.deepEqual(counting.puts, [])
    assert.deepEqual(counting.gets, [], 'unchanged objects must be skipped via head, not downloaded')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensurePublishImagesComplete fails closed on an md5-etag mismatch without downloading the object', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-gate-etag-'))
  try {
    const store = new Md5HeadStore(new MemoryPublicStore())
    await store.putImmutableObject(imageOriginalKey(HASH_A), new TextEncoder().encode('published-bytes'), 'image/jpeg')
    mkdirSync(join(dir, 'images', HASH_A), { recursive: true })
    writeFileSync(join(dir, 'images', HASH_A, 'original'), 'local-bytes-xx')
    const counting = new CountingPublicStore(store)
    await assert.rejects(
      () =>
        ensurePublishImagesComplete({
          snapshot: snapshotWithHashes([HASH_A]),
          publicStore: counting,
          imageRoot: dir,
        }),
      /publish gate.*images\/[0-9a-f]{64}\/original.*differs/i,
    )
    assert.deepEqual(counting.gets, [], 'a comparable etag mismatch is conclusive; no download needed')
    assert.deepEqual(counting.puts, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensurePublishImagesComplete verifies actual bytes when the store exposes no comparable etag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-gate-size-'))
  try {
    const bytes = 'same-size-content'
    const store = new MemoryPublicStore()
    await store.putImmutableObject(imageOriginalKey(HASH_A), new TextEncoder().encode(bytes), 'image/jpeg')
    await store.putImmutableObject(imageThumbV2Key(HASH_A), new TextEncoder().encode(bytes), 'image/webp')
    mkdirSync(join(dir, 'images', HASH_A), { recursive: true })
    writeFileSync(join(dir, 'images', HASH_A, 'original'), bytes)
    const counting = new CountingPublicStore(store)
    const result = await ensurePublishImagesComplete({
      snapshot: snapshotWithHashes([HASH_A]),
      publicStore: counting,
      imageRoot: dir,
    })
    assert.equal(result.skipped_unchanged, 1)
    assert.equal(result.reused, 1)
    assert.deepEqual(counting.puts, [])
    assert.deepEqual(counting.gets, [imageOriginalKey(HASH_A)], 'size alone is not proof: the bytes are compared')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('ensurePublishImagesComplete still fails closed when a referenced image is nowhere available', async () => {
  const store = new MemoryPublicStore()
  await assert.rejects(
    () =>
      ensurePublishImagesComplete({
        snapshot: snapshotWithHashes([HASH_A, HASH_B]),
        publicStore: store,
        imageRoot: null,
      }),
    /publish gate.*images\/[0-9a-f]{64}\/(original|thumb\.v2\.webp)/i,
  )
})

test('ensurePublishImagesComplete fails closed when a referenced image is nowhere available', async () => {
  const store = new MemoryPublicStore()
  await assert.rejects(
    () =>
      ensurePublishImagesComplete({
        snapshot: snapshotWithHashes([HASH_A, HASH_B]),
        publicStore: store,
        imageRoot: null,
      }),
    /publish gate.*images\/[0-9a-f]{64}\/(original|thumb\.v2\.webp)/i,
  )
})

test('ensurePublishImagesComplete uploads with bounded concurrency while preserving counts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-gate-'))
  const hashes = ['c', 'd', 'e', 'f', '1', '2'].map((char) => char.repeat(64))
  try {
    for (const hash of hashes) {
      mkdirSync(join(dir, 'images', hash), { recursive: true })
      writeFileSync(join(dir, 'images', hash, 'original'), `orig-${hash.slice(0, 1)}`)
    }
    let inFlight = 0
    let maxInFlight = 0
    const inner = new MemoryPublicStore()
    const yieldingStore: PublicStore = {
      getCurrentRelease: () => inner.getCurrentRelease(),
      getSnapshotBytes: (ref) => inner.getSnapshotBytes(ref),
      headObject: (key) => inner.headObject(key),
      commitRelease: (expected, next) => inner.commitRelease(expected, next),
      async putImmutableObject(key, body, contentType) {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await Promise.resolve()
        try {
          return await inner.putImmutableObject(key, body, contentType)
        } finally {
          inFlight -= 1
        }
      },
    }
    const result = await ensurePublishImagesComplete({
      snapshot: snapshotWithHashes(hashes),
      publicStore: yieldingStore,
      imageRoot: dir,
      concurrency: 4,
    })
    assert.equal(result.hashes, hashes.length)
    assert.equal(result.uploaded, hashes.length)
    assert.ok(maxInFlight > 1, `expected concurrent uploads, max in flight was ${maxInFlight}`)
    assert.ok(maxInFlight <= 4, `concurrency must stay bounded, max in flight was ${maxInFlight}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensurePublishImagesComplete fails closed without uploading when an original is missing under concurrency', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-gate-'))
  try {
    mkdirSync(join(dir, 'images', HASH_A), { recursive: true })
    writeFileSync(join(dir, 'images', HASH_A, 'original'), 'orig-a')
    const store = new MemoryPublicStore()
    await assert.rejects(
      () =>
        ensurePublishImagesComplete({
          snapshot: snapshotWithHashes([HASH_A, HASH_B]),
          publicStore: store,
          imageRoot: dir,
          concurrency: 2,
        }),
      /publish gate.*images\/[0-9a-f]{64}\/(original|thumb\.v2\.webp)/i,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
