import assert from 'node:assert/strict'
import test from 'node:test'
import type { CollectionRow } from '@airing-cal/storage'
import { normalizeCollection, planCollectionDiff, type CollectionInput } from './collection-diff.ts'

const observedAt = 1_700_000_000

function collection(overrides: Partial<CollectionInput> = {}): CollectionInput {
  return {
    subject_id: 23080,
    subject_type: 2,
    rate: 8,
    type: 3,
    comment: 'good',
    tags: ['TV', 'daily'],
    ep_status: 6,
    vol_status: 0,
    updated_at: '2026-07-20T00:00:00Z',
    private: false,
    subject: {
      id: 23080,
      type: 2,
      name: 'A',
      name_cn: 'A CN',
      summary: 'summary',
      nsfw: false,
      date: '2026-01-01',
      eps: 12,
      total_episodes: 12,
      images: {
        large: 'https://img.example/large.jpg',
        common: 'https://img.example/common.jpg',
        medium: '',
        small: '',
        grid: '',
      },
      rating: { score: 8, rank: 1, total: 100 },
    },
    ...overrides,
  }
}

async function normalized(overrides: Partial<CollectionInput> = {}, at = observedAt) {
  const value = await normalizeCollection('ian', collection(overrides))
  return {
    ...value,
    row: { ...value.row, first_seen_at: at, changed_at: at },
  }
}

test('normalizeCollection creates a hot row and explicit subject_type public projection', async () => {
  const value = await normalizeCollection('ian', collection())

  assert.equal(value.row.user_id, 'ian')
  assert.equal(value.row.subject_id, 23080)
  assert.equal(value.row.temperature, 'hot')
  assert.equal(value.row.first_seen_at, 0)
  assert.equal(value.row.changed_at, 0)
  assert.equal(value.row.missing_since, null)
  assert.equal(value.row.deleted_at, null)
  assert.equal(value.public_item.type, 2)
  assert.equal(value.public_item.collection_type, 3)
  assert.match(value.row.content_hash, /^[0-9a-f]{64}$/)
})

test('normalizeCollection marks watched as cold and every other collection type as hot', async () => {
  for (const type of [1, 2, 3, 4, 5]) {
    const value = await normalized({ type })
    assert.equal(value.row.temperature, type === 2 ? 'cold' : 'hot')
  }
})

test('planCollectionDiff inserts a new collection', async () => {
  const incoming = await normalized()
  const plan = await planCollectionDiff({ current: [], incoming: [incoming], observedAt, complete: true })

  assert.deepEqual(plan.inserts, [incoming.row])
  assert.equal(plan.unchanged, 0)
})

test('identical input at a later observation produces zero writes', async () => {
  const incoming = await normalized()
  const later = await normalized({}, observedAt + 86_400)
  const plan = await planCollectionDiff({
    current: [incoming.row], incoming: [later], observedAt: observedAt + 86_400, complete: true,
  })

  assert.deepEqual(plan.updates, [])
  assert.equal(plan.unchanged, 1)
})

for (const [name, mutate] of [
  ['rate', (entry: CollectionInput) => ({ ...entry, rate: 9 })],
  ['tags', (entry: CollectionInput) => ({ ...entry, tags: ['TV', 'favorite'] })],
  ['comment', (entry: CollectionInput) => ({ ...entry, comment: 'changed' })],
  ['collection type', (entry: CollectionInput) => ({ ...entry, type: 2 })],
  ['episode progress', (entry: CollectionInput) => ({ ...entry, ep_status: 7 })],
  ['volume progress', (entry: CollectionInput) => ({ ...entry, vol_status: 1 })],
  ['updated_at', (entry: CollectionInput) => ({ ...entry, updated_at: '2026-07-21T00:00:00Z' })],
  ['subject_type', (entry: CollectionInput) => ({ ...entry, subject_type: 1 })],
  ['public subject', (entry: CollectionInput) => ({
    ...entry,
    subject: { ...entry.subject!, name_cn: 'Changed CN' },
  })],
] as const) {
  test(`business change in ${name} changes hash and plans one write`, async () => {
    const before = await normalized()
    const changedInput = mutate(collection())
    const after = await normalizeCollection('ian', changedInput)
    const plan = await planCollectionDiff({
      current: [before.row], incoming: [after], observedAt: observedAt + 1, complete: true,
    })

    assert.notEqual(after.row.content_hash, before.row.content_hash)
    assert.equal(plan.updates.length, 1)
    assert.equal(plan.updates[0]?.first_seen_at, observedAt)
    assert.equal(plan.updates[0]?.changed_at, observedAt + 1)
  })
}

test('first complete missing observation sets missing_since without deleting', async () => {
  const current = (await normalized()).row
  const plan = await planCollectionDiff({
    current: [current], incoming: [], observedAt: observedAt + 86_400, complete: true,
  })

  assert.equal(plan.firstMissing.length, 1)
  assert.equal(plan.firstMissing[0]?.missing_since, observedAt + 86_400)
  assert.equal(plan.firstMissing[0]?.deleted_at, null)
})

test('second complete missing observation confirms deletion', async () => {
  const current: CollectionRow = {
    ...(await normalized()).row,
    missing_since: observedAt + 86_400,
  }
  const plan = await planCollectionDiff({
    current: [current], incoming: [], observedAt: observedAt + 172_800, complete: true,
  })

  assert.equal(plan.confirmedDeleted.length, 1)
  assert.equal(plan.confirmedDeleted[0]?.missing_since, observedAt + 86_400)
  assert.equal(plan.confirmedDeleted[0]?.deleted_at, observedAt + 172_800)
})

test('restored collection clears missing and deleted state even when content is unchanged', async () => {
  const incoming = await normalized()
  const current: CollectionRow = {
    ...incoming.row,
    missing_since: observedAt + 1,
    deleted_at: observedAt + 2,
  }
  const plan = await planCollectionDiff({
    current: [current],
    incoming: [await normalized({}, observedAt + 3)],
    observedAt: observedAt + 3,
    complete: true,
  })

  assert.equal(plan.restored.length, 1)
  assert.equal(plan.restored[0]?.missing_since, null)
  assert.equal(plan.restored[0]?.deleted_at, null)
})

test('incomplete fetch never marks missing or deleted', async () => {
  const first: CollectionRow = (await normalized()).row
  const alreadyMissing: CollectionRow = { ...first, subject_id: 23081, missing_since: observedAt - 1 }
  const plan = await planCollectionDiff({
    current: [first, alreadyMissing], incoming: [], observedAt: observedAt + 1, complete: false,
  })

  assert.deepEqual(plan.firstMissing, [])
  assert.deepEqual(plan.confirmedDeleted, [])
})
