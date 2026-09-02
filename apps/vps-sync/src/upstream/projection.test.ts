import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleFullFetch, type BgmSlimSubject, type CompleteFullFetch } from '@airing-cal/bgm-api'
import { canonicalProjectionHash, projectCompleteFullFetch } from './projection.ts'
import { assertCompleteStateInput } from '../postgres/persistence-validation.ts'

const userA = { id: '11111111-1111-4111-8111-111111111111', upstreamUserId: '42' }
const userB = { id: '22222222-2222-4222-8222-222222222222', upstreamUserId: '84' }

const collection = (userId: string, subjectId: number, subject: BgmSlimSubject | undefined = undefined) => ({
  user_id: userId,
  collection: {
    subject_id: subjectId, subject_type: 2, rate: 8, type: 3, comment: 'note', tags: ['tag'], ep_status: 4,
    vol_status: 0, updated_at: '2026-08-31T00:00:00.000Z', private: false, ...(subject ? { subject } : {}),
  },
})

const subject = (id: number, values: Partial<BgmSlimSubject> = {}): BgmSlimSubject => ({
  id, type: 2, name: `collection-${id}`, name_cn: `收藏-${id}`, summary: `collection summary ${id}`,
  nsfw: true, date: '2026-01-01', eps: 12, total_episodes: 13,
  images: { large: `collection-large-${id}`, common: `collection-common-${id}`, medium: '', small: '', grid: '' },
  rating: { score: 7, rank: 70, total: 700 }, ...values,
})

const fullFetch = (
  collections: CompleteFullFetch['collections'],
  items: Record<string, unknown>[],
  observedUsers = [...new Set(collections.map(({ user_id }) => user_id))],
): CompleteFullFetch => ({
  collections,
  observedUsers,
  calendar: [{ weekday: { id: 1, en: 'Mon', cn: '星期一', ja: '月曜日' }, items }] as CompleteFullFetch['calendar'],
  observedAt: 1_788_134_400,
  complete: true,
})

test('calendar fields win conflicts while collection fills calendar fields that are absent', async () => {
  const input = fullFetch(
    [collection(userA.id, 1, subject(1))],
    [{ id: 1, type: 2, name: 'calendar-name', summary: 'calendar summary', eps: 0, images: { common: 'calendar-common' } }],
  )
  const projected = await projectCompleteFullFetch(input, 'run-1', [userA])
  const calendarSubject = projected.calendarEntries[0]!.subject
  assert.doesNotThrow(() => assertCompleteStateInput(projected))
  assert.deepEqual(calendarSubject.payload, {
    id: 1, type: 2, name: 'calendar-name', name_cn: '收藏-1', summary: 'calendar summary', nsfw: true,
    date: '2026-01-01', eps: 0, total_episodes: 13,
    images: { common: 'calendar-common', large: 'collection-large-1' },
    rating: { score: 7, rank: 70, total: 700 },
  })
  assert.deepEqual(projected.users[0]!.items[0]!.subject, calendarSubject)
})

test('projects collection-only and calendar-only subjects', async () => {
  const input = fullFetch(
    [collection(userA.id, 2, subject(2))],
    [{ id: 3, type: 2, name: 'calendar-only', name_cn: '', summary: '', nsfw: false, date: '', eps: 0, images: {} }],
  )
  const projected = await projectCompleteFullFetch(input, 'run-2', [userA])
  assert.doesNotThrow(() => assertCompleteStateInput(projected))
  assert.equal(projected.users[0]!.items[0]!.subject.id, 2)
  assert.equal(projected.calendarEntries[0]!.subject.id, 3)
  assert.equal(projected.calendarEntries[0]!.subject.payload.name, 'calendar-only')
})

test('stably merges one subject repeated across multiple users', async () => {
  const input = fullFetch([
    collection(userB.id, 4, subject(4, { name: 'second-user' })),
    collection(userA.id, 4, subject(4, { name: 'first-user' })),
  ], [])
  const projected = await projectCompleteFullFetch(input, 'run-3', [userA, userB])
  assert.deepEqual(projected.users.map((user) => user.id), [userA.id, userB.id])
  assert.deepEqual(projected.users.map((user) => user.items[0]!.subject.payload.name), ['first-user', 'first-user'])
  assert.equal(projected.users[0]!.items[0]!.subject.contentHash, projected.users[1]!.items[0]!.subject.contentHash)
})

test('rejects incomplete input and unknown users to preserve deletion protection', async () => {
  await assert.rejects(
    () => projectCompleteFullFetch({ ...fullFetch([], []), complete: false } as unknown as CompleteFullFetch, 'run-4', [userA]),
    /INCOMPLETE_FULL_FETCH/,
  )
  await assert.rejects(
    () => projectCompleteFullFetch(fullFetch([collection(userB.id, 5, subject(5))], [], [userA.id]), 'run-4', [userA]),
    /UNKNOWN_PROJECTION_USER/,
  )
})

test('requires exact observed-user evidence and preserves a genuinely observed empty user', async () => {
  const projected = await projectCompleteFullFetch(fullFetch([], [], [userA.id]), 'run-empty', [userA])
  assert.deepEqual(projected.users, [{ ...userA, items: [] }])

  const withoutEvidence = { ...fullFetch([], [], [userA.id]) } as Partial<CompleteFullFetch>
  delete withoutEvidence.observedUsers
  await assert.rejects(
    () => projectCompleteFullFetch(withoutEvidence as CompleteFullFetch, 'run-missing-evidence', [userA]),
    /MISSING_OBSERVED_USER_EVIDENCE/,
  )

  for (const [observedUsers, pattern] of [
    [[], /MISSING_OBSERVED_PROJECTION_USER/],
    [[userA.id, userA.id], /DUPLICATE_OBSERVED_PROJECTION_USER/],
    [[userA.id, userB.id], /UNKNOWN_OBSERVED_PROJECTION_USER/],
  ] as const) {
    await assert.rejects(
      () => projectCompleteFullFetch(fullFetch([], [], [...observedUsers]), 'run-invalid-evidence', [userA]),
      pattern,
    )
  }
})

test('merges rating presence field by field and treats explicit zero as authoritative', async () => {
  const scoreOnly = await projectCompleteFullFetch(fullFetch(
    [collection(userA.id, 6, subject(6))],
    [{ id: 6, type: 2, rating: { score: 9 } }],
  ), 'run-score-only', [userA])
  assert.deepEqual(scoreOnly.calendarEntries[0]!.subject.payload.rating, { score: 9, rank: 70, total: 700 })

  const explicitZero = await projectCompleteFullFetch(fullFetch(
    [collection(userA.id, 7, subject(7))],
    [{ id: 7, type: 2, rating: { score: 0, rank: 0, total: 0 } }],
  ), 'run-zero', [userA])
  assert.deepEqual(explicitZero.calendarEntries[0]!.subject.payload.rating, { score: 0, rank: 0, total: 0 })
})

test('shared full-fetch producer preserves every legal partial rating through VPS projection and hashing', async () => {
  const input = assembleFullFetch(
    [{ user_id: userA.id, pages: [{ offset: 0, total: 0, data: [] }], pageLimit: 50 }],
    [{
      weekday: { id: 1, en: 'Mon', cn: '星期一', ja: '月曜日' },
      items: [
        { id: 20, type: 2, rating: { rank: 0 } },
        { id: 21, type: 2, rating: { total: 0 } },
        { id: 22, type: 2, rating: { score: 0, rank: 0 } },
      ],
    }],
    1_788_134_400,
  )

  const projected = await projectCompleteFullFetch(input, 'run-shared-partial-ratings', [userA])

  assert.deepEqual(projected.calendarEntries.map(({ subject }) => subject.payload.rating), [
    { rank: 0 },
    { total: 0 },
    { score: 0, rank: 0 },
  ])
  for (const entry of projected.calendarEntries) {
    assert.equal(entry.subject.contentHash, canonicalProjectionHash(entry.subject.payload))
  }
})

test('preserves calendar-only partial rating presence without inventing zero fields', async () => {
  const scoreOnly = await projectCompleteFullFetch(fullFetch(
    [],
    [{ id: 8, type: 2, rating: { score: 9 } }],
    [userA.id],
  ), 'run-calendar-score-only', [userA])
  const rating = scoreOnly.calendarEntries[0]!.subject.payload.rating

  assert.deepEqual(rating, { score: 9 })
  assert.doesNotThrow(() => assertCompleteStateInput(scoreOnly))
  assert.notEqual(
    scoreOnly.calendarEntries[0]!.subject.contentHash,
    canonicalProjectionHash({ ...scoreOnly.calendarEntries[0]!.subject.payload, rating: { score: 9, rank: 0, total: 0 } }),
  )
})

test('preserves explicit zero in a calendar-only partial rating', async () => {
  const explicitZero = await projectCompleteFullFetch(fullFetch(
    [],
    [{ id: 11, type: 2, rating: { score: 0 } }],
    [userA.id],
  ), 'run-calendar-explicit-zero', [userA])

  assert.deepEqual(explicitZero.calendarEntries[0]!.subject.payload.rating, { score: 0 })
  assert.doesNotThrow(() => assertCompleteStateInput(explicitZero))
})

test('merges independently absent rating fields without inventing fields absent from both sources', async () => {
  const collectionRating = { rank: 70 } as unknown as NonNullable<BgmSlimSubject['rating']>
  const projected = await projectCompleteFullFetch(fullFetch(
    [collection(userA.id, 12, subject(12, { rating: collectionRating }))],
    [{ id: 12, type: 2, rating: { score: 9 } }],
  ), 'run-split-partial-rating', [userA])

  assert.deepEqual(projected.calendarEntries[0]!.subject.payload.rating, { score: 9, rank: 70 })
  assert.doesNotThrow(() => assertCompleteStateInput(projected))
})

test('canonical hashes use stable code-unit key ordering for insertion order and Unicode keys', async () => {
  const left = { 'ä': 1, Z: 2, a: 3, '😀': 4, nested: { total: 700, score: 7, rank: 70 } }
  const right = { nested: { rank: 70, score: 7, total: 700 }, '😀': 4, a: 3, Z: 2, 'ä': 1 }

  const originalLocaleCompare = String.prototype.localeCompare
  String.prototype.localeCompare = function forbiddenLocaleCompare(): never {
    throw new Error('canonical ordering must not depend on host locale')
  }
  try {
    assert.equal(canonicalProjectionHash(left), canonicalProjectionHash(right))
  } finally {
    String.prototype.localeCompare = originalLocaleCompare
  }
})

test('canonical hashes continue to reject undefined and non-finite values', async () => {
  const invalidUndefined = collection(userA.id, 9, subject(9))
  invalidUndefined.collection.tags = [undefined as unknown as string]
  await assert.rejects(
    () => projectCompleteFullFetch(fullFetch([invalidUndefined], []), 'run-undefined', [userA]),
    /canonicalize undefined/i,
  )

  const invalidNumber = collection(userA.id, 10, subject(10))
  invalidNumber.collection.rate = Number.NaN
  await assert.rejects(
    () => projectCompleteFullFetch(fullFetch([invalidNumber], []), 'run-non-finite', [userA]),
    /non-finite number/i,
  )
})
