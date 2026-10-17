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
