import assert from 'node:assert/strict'
import test from 'node:test'
import { progressBar } from './sync-progress.ts'

test('progressBar renders filled and empty segments', () => {
  assert.equal(progressBar(0), '····················')
  assert.equal(progressBar(100), '####################')
  assert.match(progressBar(50), /^#{10,11}/)
})
