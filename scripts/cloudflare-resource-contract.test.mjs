import assert from 'node:assert/strict'
import test from 'node:test'

import { CLOUDFLARE_RESOURCES } from './cloudflare-resource-contract.mjs'

test('CLOUDFLARE_RESOURCES defines the fixed compatibility resources', () => {
  assert.deepEqual(CLOUDFLARE_RESOURCES, {
    d1DatabaseName: 'airing-cal-state',
    dataBucketName: 'airing-cal-data',
    imageBucketName: 'airing-cal-images',
    kvNamespaceTitle: 'airing-cal-kv',
    queueNames: ['airing-cal-media'],
  })
})
