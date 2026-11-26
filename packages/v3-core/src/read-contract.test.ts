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

test('v2 cache-control literals match unified reader soft/CDN budget', () => {
  assert.equal(V2_CACHE_CONTROL.collections, 'public, max-age=30, s-maxage=60, stale-while-revalidate=30')
  assert.equal(V2_CACHE_CONTROL.calendar, 'public, max-age=30, s-maxage=60, stale-while-revalidate=30')
  assert.equal(V2_CACHE_CONTROL.image, 'public, max-age=31536000, immutable')
})
