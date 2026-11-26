import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FilesystemPublicStore } from './filesystem-public-store.ts'
import { PUBLIC_RELEASE_POINTER_KEY } from './public-pointer.ts'
import type { PublicReleasePointer } from './ports.ts'

function samplePointer(generation: number): PublicReleasePointer {
  return {
    schema_version: 1,
    generation,
    content_hash: `${generation}`.padStart(64, 'a'),
    published_at_unix: 1_700_000_000,
    artifact_ref: `snapshots/v1/${generation}-aaa.json`,
  }
}

test('FilesystemPublicStore rejects path traversal keys', () => {
  const store = new FilesystemPublicStore('/tmp/airingcal-public')
  assert.throws(() => store.resolveObjectPath('../escape.json'))
})

test('FilesystemPublicStore enforces immutable objects and pointer CAS', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-public-'))
  const store = new FilesystemPublicStore(root)
  const body = new TextEncoder().encode('{"generation":1}')
  const pointer = samplePointer(1)

  await store.putImmutableObject(pointer.artifact_ref, body, 'application/json')
  await store.putImmutableObject(pointer.artifact_ref, body, 'application/json')

  const conflicting = new TextEncoder().encode('{"generation":2}')
  await assert.rejects(
    () => store.putImmutableObject(pointer.artifact_ref, conflicting, 'application/json'),
    /different bytes/,
  )

  assert.equal(await store.commitRelease(null, pointer), 'committed')
  const pointerPath = join(root, PUBLIC_RELEASE_POINTER_KEY)
  assert.ok(readFileSync(pointerPath, 'utf8').includes(pointer.content_hash))

  assert.equal(await store.commitRelease(null, samplePointer(2)), 'conflict')
  const readback = await store.getSnapshotBytes(pointer.artifact_ref)
  assert.equal(readback?.byteLength, body.byteLength)
})

test('FilesystemPublicStore headObject returns put contentType', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-public-head-'))
  const store = new FilesystemPublicStore(root)
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
  const key = 'images/' + 'a'.repeat(64) + '/original'

  await store.putImmutableObject(key, jpeg, 'image/jpeg')
  const head = await store.headObject(key)

  assert.equal(head?.size, jpeg.byteLength)
  assert.equal(head?.etag, null)
  assert.equal(head?.contentType, 'image/jpeg')
  assert.equal(await store.headObject('images/missing/original'), null)
})
