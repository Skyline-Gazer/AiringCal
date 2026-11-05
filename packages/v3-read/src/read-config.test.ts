import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveNsfwShow } from './read-config.ts'

/**
 * Cloudflare, EdgeOne and the node gateway must agree on the NSFW default.
 * v2 semantics: NSFW content is shown unless `NSFW_SHOW` is exactly `false`.
 */
test('resolveNsfwShow defaults to showing NSFW content (v2 semantics)', () => {
  assert.equal(resolveNsfwShow(undefined), true)
  assert.equal(resolveNsfwShow(null), true)
  assert.equal(resolveNsfwShow(''), true)
  assert.equal(resolveNsfwShow('true'), true)
  assert.equal(resolveNsfwShow(' FALSE '), false)
  assert.equal(resolveNsfwShow('false'), false)
})
