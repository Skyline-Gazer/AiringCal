import assert from 'node:assert/strict'
import test from 'node:test'
import { appBoundary } from './index.ts'

test('frontend-worker app boundary exposes its app name', () => {
  assert.equal(appBoundary, 'frontend-worker')
})
