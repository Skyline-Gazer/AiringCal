import assert from 'node:assert/strict'
import test from 'node:test'
import { appBoundary } from './index.ts'

test('legacy frontend.test merged into web-worker boundary', () => {
  assert.equal(appBoundary, 'web-worker')
})
