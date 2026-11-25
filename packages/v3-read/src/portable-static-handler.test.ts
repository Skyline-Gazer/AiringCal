import assert from 'node:assert/strict'
import test from 'node:test'
import { handlePortableStaticRequest } from './portable-static-handler.ts'

test('handlePortableStaticRequest serves index and widget assets', () => {
  const index = handlePortableStaticRequest(new Request('https://local/'))
  assert.ok(index?.ok)
  assert.match(index?.headers.get('Content-Type') ?? '', /text\/html/)
  const js = handlePortableStaticRequest(new Request('https://local/src/bangumi.js'))
  assert.ok(js?.ok)
  assert.match(js?.headers.get('Content-Type') ?? '', /javascript/)
})

test('handlePortableStaticRequest returns 410 for deprecated sync routes', () => {
  const response = handlePortableStaticRequest(
    new Request('https://local/api/sync/compare', { method: 'POST' }),
  )
  assert.equal(response?.status, 410)
})

test('method refusals are scoped to owned assets; other paths fall through (ShipReview #1)', () => {
  // OPTIONS/POST on read-gateway paths must return null so the read handler
  // can answer its CORS preflight (204) or its own 405.
  for (const [path, method] of [
    ['/api/collections', 'OPTIONS'],
    ['/api/config', 'POST'],
    ['/public/current-release.json', 'OPTIONS'],
    ['/checkpoints/latest.sqlite', 'OPTIONS'],
  ] as const) {
    const response = handlePortableStaticRequest(new Request(`https://local${path}`, { method }))
    assert.equal(response, null, `${method} ${path} must fall through`)
  }
  // Owned static assets keep the read-only refusal.
  for (const path of ['/', '/src/bangumi.js', '/src/bangumi.css', '/src/cache.js']) {
    const response = handlePortableStaticRequest(new Request(`https://local${path}`, { method: 'POST' }))
    assert.equal(response?.status, 405, `${path} POST`)
  }
  // Deprecated sync routes answer 410 for every method, including OPTIONS.
  const gone = handlePortableStaticRequest(new Request('https://local/api/sync/apply', { method: 'OPTIONS' }))
  assert.equal(gone?.status, 410)
})
