import assert from 'node:assert/strict'
import test from 'node:test'
import { formatUtcStamp, shortCommit } from './format.ts'

test('timestamps render in explicit UTC and never invent a value', () => {
  assert.equal(formatUtcStamp('2026-11-30T08:26:00.000Z'), '2026-11-30 08:26 UTC')
  assert.equal(formatUtcStamp('2026-11-30T08:26:00Z'), '2026-11-30 08:26 UTC')
  assert.equal(formatUtcStamp(''), null)
  assert.equal(formatUtcStamp(null), null)
  assert.equal(formatUtcStamp('not-a-date'), null)
})

test('build sha is shortened for display', () => {
  assert.equal(shortCommit('56d344389547b1b877599e8cf78fefa78b88748a'), '56d3443')
  assert.equal(shortCommit('  '), null)
  assert.equal(shortCommit(undefined), null)
})
