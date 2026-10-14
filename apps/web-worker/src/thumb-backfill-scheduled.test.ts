import assert from 'node:assert/strict'
import test from 'node:test'
import { hashFromLargeR2Key } from './thumb-materialize.ts'
import { parseThumbBackfillBatchLimit } from './thumb-backfill-scheduled.ts'

const HASH = 'b'.repeat(64)

test('hashFromLargeR2Key parses images/{hash}/original', () => {
  assert.equal(hashFromLargeR2Key(`images/${HASH}/original`), HASH)
  assert.equal(hashFromLargeR2Key('images/not-a-hash/original'), null)
  assert.equal(hashFromLargeR2Key(null), null)
})

test('parseThumbBackfillBatchLimit defaults and clamps', () => {
  assert.equal(parseThumbBackfillBatchLimit(undefined), 30)
  assert.equal(parseThumbBackfillBatchLimit('10'), 10)
  assert.equal(parseThumbBackfillBatchLimit('99'), 50)
  assert.equal(parseThumbBackfillBatchLimit('0'), 30)
})
