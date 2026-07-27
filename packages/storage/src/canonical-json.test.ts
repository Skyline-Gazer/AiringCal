import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalJson,
  canonicalize,
  collectionContentHash,
  sha256Canonical,
} from './canonical-json.ts'

test('canonical JSON recursively sorts object keys and preserves array order', () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: 2, x: 3 }, list: [{ b: 2, a: 1 }, 3, 2] }),
    '{"a":{"x":3,"y":2},"list":[{"a":1,"b":2},3,2],"z":1}',
  )
})

test('canonical JSON normalizes explicit undefined values to null', () => {
  assert.deepEqual(canonicalize({ optional: undefined, list: [1, undefined] }), {
    list: [1, null],
    optional: null,
  })
  assert.equal(canonicalJson(undefined), 'null')
})

test('canonical JSON preserves UTF-8 content', async () => {
  assert.equal(canonicalJson({ title: '葬送のフリーレン 🌙' }), '{"title":"葬送のフリーレン 🌙"}')
  assert.match(await sha256Canonical({ title: '葬送のフリーレン 🌙' }), /^[0-9a-f]{64}$/)
})

test('canonical JSON rejects non-finite numbers at any depth', () => {
  assert.throws(() => canonicalJson({ nested: [1, Number.NaN] }), /non-finite number/i)
  assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY), /non-finite number/i)
})

test('canonical SHA-256 is stable across object insertion order', async () => {
  assert.equal(
    await sha256Canonical({ a: 1, nested: { b: 2, c: 3 } }),
    await sha256Canonical({ nested: { c: 3, b: 2 }, a: 1 }),
  )
})

const baseCollection = {
  user_id: 'alice',
  subject_id: 23080,
  collection_type: 3,
  rate: 8,
  tags: ['daily'],
  comment: 'great',
  ep_status: 4,
  vol_status: 1,
  subject: {
    id: 23080,
    name: 'A',
    name_cn: 'A CN',
    type: 2,
    eps: 12,
  },
  upstream_updated_at: '2026-07-20T00:00:00Z',
  fetched_at: 100,
  first_seen_at: 100,
  changed_at: 100,
  missing_since: null,
  deleted_at: null,
  generation: 7,
}

test('collection content hash detects every public business field without trusting upstream timestamp', async () => {
  const original = await collectionContentHash(baseCollection)
  const changes = [
    { rate: 9 },
    { tags: ['daily', 'favorite'] },
    { comment: 'excellent' },
    { collection_type: 2 },
    { ep_status: 5 },
    { vol_status: 2 },
  ]

  for (const change of changes) {
    assert.notEqual(
      await collectionContentHash({ ...baseCollection, ...change }),
      original,
      `expected ${Object.keys(change)[0]} to affect the business hash`,
    )
  }
})

test('collection content hash excludes upstream and runtime fields', async () => {
  assert.equal(
    await collectionContentHash(baseCollection),
    await collectionContentHash({
      ...baseCollection,
      upstream_updated_at: '2099-01-01T00:00:00Z',
      fetched_at: 999,
      first_seen_at: 999,
      changed_at: 999,
      missing_since: 999,
      deleted_at: 999,
      generation: 999,
      instance_id: 'run-2',
      heartbeat_at: 999,
      published_at: 999,
    }),
  )
})

test('collection content hash supplies stable defaults for missing optional business fields', async () => {
  const required = {
    user_id: 'alice',
    subject_id: 23080,
    collection_type: 3,
    ep_status: 0,
    vol_status: 0,
    subject: null,
  }

  assert.equal(
    await collectionContentHash(required),
    await collectionContentHash({
      ...required,
      rate: null,
      tags: [],
      comment: '',
    }),
  )
})
