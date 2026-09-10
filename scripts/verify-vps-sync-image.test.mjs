import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyVpsSyncImage } from './verify-vps-sync-image.mjs'

test('the VPS sync image has minimal production and opt-in debug targets', () => {
  assert.deepEqual(verifyVpsSyncImage(), {
    production: 'verified',
    debug: 'verified',
  })
})
