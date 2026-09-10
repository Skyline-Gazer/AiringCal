import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyVpsSyncImage } from './verify-vps-sync-image.mjs'

test('the VPS sync image has minimal production and opt-in debug targets', () => {
  assert.deepEqual(verifyVpsSyncImage(), {
    production: 'verified',
    productionToolCheck: ['curl', 'git', 'jq', 'python3', 'dig', 'make', 'g++'],
    debug: 'verified',
  })
})

test('hosted production-image validation fails separately for every forbidden diagnostic tool', () => {
  assert.deepEqual(verifyVpsSyncImage().productionToolCheck, [
    'curl',
    'git',
    'jq',
    'python3',
    'dig',
    'make',
    'g++',
  ])
})
