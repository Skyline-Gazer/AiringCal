import assert from 'node:assert/strict'
import test from 'node:test'
import { V2_CACHE_CONTROL, V2_PUBLIC_READ_ROUTES, V2_RETIRED_ROUTES } from './read-contract.ts'

test('v2 read route inventory is stable for contract tests', () => {
  assert.deepEqual(V2_PUBLIC_READ_ROUTES, [
    'GET /api/collections',
    'GET /api/calendar',
    'GET /api/config',
    'GET /api/health',
    'GET /api/version',
    'GET /api/cache',
    'GET /image/:hash',
    'GET /image/:hash/thumb',
  ])
  assert.ok(V2_RETIRED_ROUTES.length >= 3)
})

test('v2 cache-control literals match web-worker read-api constants', () => {
  assert.match(V2_CACHE_CONTROL.collections, /max-age=30/)
  assert.match(V2_CACHE_CONTROL.calendar, /s-maxage=600/)
  assert.equal(V2_CACHE_CONTROL.image, 'public, max-age=31536000, immutable')
})
