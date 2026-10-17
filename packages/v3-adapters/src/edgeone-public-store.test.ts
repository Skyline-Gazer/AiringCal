import assert from 'node:assert/strict'
import test from 'node:test'
import type { PublicReleasePointer } from '@airing-cal/v3-core/ports'
import { PUBLIC_RELEASE_POINTER_KEY } from '@airing-cal/v3-core/public-pointer'
import { EdgeOnePublicStore } from './edgeone-public-store.ts'
import { MemoryEdgeOneBlob } from './memory-edgeone-blob.ts'

function samplePointer(generation: number): PublicReleasePointer {
  return {
    schema_version: 1,
    generation,
    content_hash: `hash-${generation}`,
    published_at_unix: 1_700_000_000 + generation,
    artifact_ref: `snapshots/v1/${generation}-hash-${generation}.json`,
  }
}

test('EdgeOnePublicStore reads pointers and snapshot bytes with the shared key layout', async () => {
  const store = new EdgeOnePublicStore(new MemoryEdgeOneBlob())
  assert.equal(await store.getCurrentRelease(), null)
  assert.equal(await store.getSnapshotBytes('snapshots/v1/1-hash-1.json'), null)

  await store.putImmutableObject(
    'snapshots/v1/1-hash-1.json',
    new TextEncoder().encode('{"schema_version":1}'),
    'application/json',
  )
  await store.store.set(PUBLIC_RELEASE_POINTER_KEY, `${JSON.stringify(samplePointer(1))}\n`)

  assert.deepEqual(await store.getCurrentRelease(), samplePointer(1))
  assert.equal(
    new TextDecoder().decode((await store.getSnapshotBytes('snapshots/v1/1-hash-1.json')) ?? new Uint8Array()),
    '{"schema_version":1}',
  )
})

test('EdgeOnePublicStore enforces immutability with a read-back check', async () => {
  const blob = new MemoryEdgeOneBlob()
  const store = new EdgeOnePublicStore(blob)
  const body = new TextEncoder().encode('{"schema_version":1}')

  await store.putImmutableObject('snapshots/v1/1-a.json', body, 'application/json')
  await store.putImmutableObject('snapshots/v1/1-a.json', body, 'application/json')
  await assert.rejects(
    () => store.putImmutableObject('snapshots/v1/1-a.json', new TextEncoder().encode('{"schema_version":2}'), 'application/json'),
    /different bytes/,
  )

  blob.dropWrites = true
  await assert.rejects(
    () => store.putImmutableObject('snapshots/v1/2-b.json', body, 'application/json'),
    /read-back mismatch/,
  )
})

test('EdgeOnePublicStore reports pointer commits as unsupported and detects conflicts', async () => {
  const store = new EdgeOnePublicStore(new MemoryEdgeOneBlob())
  await store.store.set(PUBLIC_RELEASE_POINTER_KEY, `${JSON.stringify(samplePointer(1))}\n`)

  assert.equal(await store.commitRelease(samplePointer(1), samplePointer(2)), 'unsupported')
  assert.equal(
    await store.commitRelease(null, samplePointer(2)),
    'conflict',
    'a mismatched expectation is a conflict regardless of CAS support',
  )
  assert.equal(
    await store.commitRelease(samplePointer(1), samplePointer(2)),
    'unsupported',
    'no conditional write exists on EdgeOne Blob',
  )
})

test('EdgeOnePublicStore rejects malformed pointers and lists keys by prefix', async () => {
  const blob = new MemoryEdgeOneBlob()
  const store = new EdgeOnePublicStore(blob)
  await blob.set(PUBLIC_RELEASE_POINTER_KEY, '{"schema_version":2}')
  await assert.rejects(() => store.getCurrentRelease(), /Invalid public release pointer/)
  await blob.set(PUBLIC_RELEASE_POINTER_KEY, '')

  for (const key of ['images/a/original', 'images/b/original', 'images/c/original', 'snapshots/v1/1-hash.json']) {
    await blob.set(key, 'x')
  }
  assert.deepEqual(await store.listObjectKeys('images/'), [
    'images/a/original',
    'images/b/original',
    'images/c/original',
  ])
  assert.deepEqual(await store.listObjectKeys('missing/'), [])
})

test('EdgeOne Blob list cursors that repeat are rejected', async () => {
  const blob = new MemoryEdgeOneBlob()
  const store = new EdgeOnePublicStore(blob)
  blob.list = async () => ({ blobs: [{ key: 'images/a/original', etag: 'e' }], cursor: 'images/a/original' })
  await assert.rejects(() => store.listObjectKeys('images/'), /repeated cursor/)
})
