import assert from 'node:assert/strict'
import test from 'node:test'
import { packageBoundary } from './index.ts'

test('storage package boundary exposes its package name', () => {
  assert.equal(packageBoundary, '@airing-cal/storage')
})
