import assert from 'node:assert/strict'
import test from 'node:test'
import { appBoundary } from './index.ts'

test('web-worker app boundary exposes its app name', () => {
  assert.equal(appBoundary, 'web-worker')
})
