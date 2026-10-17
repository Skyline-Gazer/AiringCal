import assert from 'node:assert/strict'
import test from 'node:test'
import type { PublicSnapshotV1 } from '@airing-cal/storage'
import { collectReferencedImageHashes, planPublicImageGc } from './public-image-gc.ts'

test('collectReferencedImageHashes reads image ref hashes', () => {
  const hash = 'a'.repeat(64)
  const snapshot = {
    collections: {
      want: [],
      watched: [],
      watching: [{
        images: {
          common: { hash, uri: '/image/x', r2_key: `images/${hash}/original` },
          large: null,
        },
      }],
      on_hold: [],
      dropped: [],
    },
    calendar: [],
  } as unknown as PublicSnapshotV1
  assert.deepEqual([...collectReferencedImageHashes(snapshot)], [hash])
})

test('planPublicImageGc deletes unreferenced on-disk hashes', () => {
  const ref = 'a'.repeat(64)
  const orphan = 'b'.repeat(64)
  const plan = planPublicImageGc({
    onDiskHashes: [ref, orphan],
    referencedHashes: new Set([ref]),
    pinnedHashes: new Set(['c'.repeat(64)]),
  })
  assert.deepEqual(plan.delete, [orphan])
  assert.ok(plan.keep.includes(ref))
  assert.ok(plan.keep.includes('c'.repeat(64)))
})
