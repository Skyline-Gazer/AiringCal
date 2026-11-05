import assert from 'node:assert/strict'
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
  constructor(private readonly inner: MemoryPublicStore) {}

  async getCurrentRelease() {
    return this.inner.getCurrentRelease()
  }

  async getSnapshotBytes(ref: string) {
    return this.inner.getSnapshotBytes(ref)
  }

  async putImmutableObject(key: string, body: Uint8Array, contentType: string) {
    this.puts.push(key)
    return this.inner.putImmutableObject(key, body, contentType)
  }

  async commitRelease(expected: Parameters<PublicStore['commitRelease']>[0], next: Parameters<PublicStore['commitRelease']>[1]) {
    return this.inner.commitRelease(expected, next)
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

test('ensurePublishImagesComplete reuses existing public objects without re-upload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-gate-'))
  try {
    const store = new MemoryPublicStore()
    await store.putImmutableObject(imageOriginalKey(HASH_A), new TextEncoder().encode('public-orig'), 'image/jpeg')
    await store.putImmutableObject(imageThumbV2Key(HASH_A), new TextEncoder().encode('public-thumb'), 'image/webp')
    mkdirSync(join(dir, 'images', HASH_A), { recursive: true })
    writeFileSync(join(dir, 'images', HASH_A, 'original'), 'local-orig')
    const counting = new CountingPublicStore(store)
    const result = await ensurePublishImagesComplete({
      snapshot: snapshotWithHashes([HASH_A]),
      publicStore: counting,
      imageRoot: dir,
    })
    assert.equal(result.reused, 2)
    assert.equal(result.uploaded, 0)
    assert.deepEqual(counting.puts, [])
    assert.equal(new TextDecoder().decode((await store.getSnapshotBytes(imageOriginalKey(HASH_A)))!), 'public-orig')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
