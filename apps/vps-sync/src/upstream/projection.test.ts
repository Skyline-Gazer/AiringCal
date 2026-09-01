import assert from 'node:assert/strict'
import test from 'node:test'
import type { BgmSlimSubject, CompleteFullFetch } from '@airing-cal/bgm-api'
import { projectCompleteFullFetch } from './projection.ts'
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

const fullFetch = (collections: CompleteFullFetch['collections'], items: Record<string, unknown>[]): CompleteFullFetch => ({
  collections,
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
    () => projectCompleteFullFetch(fullFetch([collection(userB.id, 5, subject(5))], []), 'run-4', [userA]),
    /UNKNOWN_PROJECTION_USER/,
  )
})
