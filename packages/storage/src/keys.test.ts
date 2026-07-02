import assert from 'node:assert/strict'
import test from 'node:test'
import { imageIndexKey, imageOriginalKey, imageStatusKey, snapshotCollectionsKey, subjectDetailKey, subjectMetaKey } from './index.ts'

test('storage key builders expose stable KV and R2 contracts', () => {
  assert.equal(snapshotCollectionsKey('watching'), 'snapshot:collections:watching')
  assert.equal(subjectMetaKey(23080), 'subject:meta:23080')
  assert.equal(subjectDetailKey(23080), 'subject:detail:23080')
  assert.equal(imageStatusKey(23080), 'image:status:23080')
  assert.equal(imageIndexKey('a'.repeat(64)), `image:index:${'a'.repeat(64)}`)
  assert.equal(imageOriginalKey('a'.repeat(64)), `images/${'a'.repeat(64)}/original`)
})
