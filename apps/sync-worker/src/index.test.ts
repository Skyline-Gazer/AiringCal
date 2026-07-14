import assert from 'node:assert/strict'
import test from 'node:test'
import { appBoundary } from './index.ts'

test('sync-worker app boundary exposes its app name', () => {
  assert.equal(appBoundary, 'sync-worker')
})
