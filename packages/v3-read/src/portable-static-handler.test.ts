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
