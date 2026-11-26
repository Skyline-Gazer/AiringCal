import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bytesEqual,
  parsePublicReleasePointer,
  releasePointersMatch,
} from './public-pointer.ts'
import type { PublicReleasePointer } from './ports.ts'

function pointer(overrides: Partial<PublicReleasePointer> = {}): PublicReleasePointer {
  return {
    schema_version: 1,
    generation: 1,
    content_hash: 'hash-1',
    published_at_unix: 1_700_000_000,
    artifact_ref: 'snapshots/v1/1-hash-1.json',
    ...overrides,
  }
}

test('parsePublicReleasePointer rejects malformed pointers', () => {
  assert.deepEqual(parsePublicReleasePointer(JSON.stringify(pointer())), pointer())
  assert.throws(() => parsePublicReleasePointer(JSON.stringify({ ...pointer(), schema_version: 2 })), /Invalid public release pointer/)
  assert.throws(() => parsePublicReleasePointer(JSON.stringify({ ...pointer(), generation: 1.5 })), /Invalid public release pointer/)
  assert.throws(() => parsePublicReleasePointer(JSON.stringify({ ...pointer(), artifact_ref: undefined })), /Invalid public release pointer/)
})

test('releasePointersMatch compares generation and content hash', () => {
  assert.equal(releasePointersMatch(null, null), true)
  assert.equal(releasePointersMatch(null, pointer()), false)
  assert.equal(releasePointersMatch(pointer(), pointer()), true)
  assert.equal(releasePointersMatch(pointer(), pointer({ generation: 2 })), false)
  assert.equal(releasePointersMatch(pointer(), pointer({ content_hash: 'hash-2' })), false)
  assert.equal(
    releasePointersMatch(pointer({ artifact_ref: 'other.json' }), pointer()),
    true,
    'artifact_ref is not part of CAS identity for the same generation/hash',
  )
})

test('bytesEqual compares immutable object bytes', () => {
  assert.equal(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true)
  assert.equal(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false)
  assert.equal(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([2, 1])), false)
})
