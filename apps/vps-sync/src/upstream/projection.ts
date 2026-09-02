import { createHash } from 'node:crypto'
import type { BgmCalendarItem, BgmCollection, CompleteFullFetch } from '@airing-cal/bgm-api'
import type { CompleteStateInput, SubjectInput } from '../postgres/repositories.ts'

export interface ProjectionUser {
  id: string
  upstreamUserId: string
}

type SubjectPayload = SubjectInput['payload']
type CalendarSubject = BgmCalendarItem['items'][number]

export function canonicalProjectionHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function canonical(value: unknown): unknown {
  if (value === undefined) throw new TypeError('Cannot canonicalize undefined')
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Cannot canonicalize non-finite number')
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, nested]) => [key, canonical(nested)]))
}

function collectionSubject(entry: BgmCollection): SubjectPayload {
  const subject = entry.subject
  return {
    id: entry.subject_id,
    type: subject?.type ?? entry.subject_type,
    ...(subject && Object.hasOwn(subject, 'name') ? { name: subject.name } : {}),
    ...(subject && Object.hasOwn(subject, 'name_cn') ? { name_cn: subject.name_cn } : {}),
    ...(subject && Object.hasOwn(subject, 'summary') ? { summary: subject.summary } : {}),
    ...(subject && Object.hasOwn(subject, 'nsfw') ? { nsfw: subject.nsfw } : {}),
    ...(subject && Object.hasOwn(subject, 'date') ? { date: subject.date } : {}),
    ...(subject && Object.hasOwn(subject, 'eps') ? { eps: subject.eps } : {}),
    ...(subject && Object.hasOwn(subject, 'total_episodes') ? { total_episodes: subject.total_episodes } : {}),
    ...(subject?.images ? { images: { common: subject.images.common, large: subject.images.large } } : {}),
    ...(subject?.rating ? { rating: subject.rating } : {}),
  }
}

function calendarSubject(subject: CalendarSubject, fallback?: SubjectPayload): SubjectPayload {
  const images = subject.images as CalendarSubject['images'] | undefined
  const calendarRating = subject.rating as Partial<NonNullable<SubjectPayload['rating']>> | undefined
  const fallbackRating = fallback?.rating
  const rating = calendarRating || fallbackRating ? {
    ...(calendarRating && Object.hasOwn(calendarRating, 'score') ? { score: calendarRating.score } : fallbackRating && Object.hasOwn(fallbackRating, 'score') ? { score: fallbackRating.score } : {}),
    ...(calendarRating && Object.hasOwn(calendarRating, 'rank') ? { rank: calendarRating.rank } : fallbackRating && Object.hasOwn(fallbackRating, 'rank') ? { rank: fallbackRating.rank } : {}),
    ...(calendarRating && Object.hasOwn(calendarRating, 'total') ? { total: calendarRating.total } : fallbackRating && Object.hasOwn(fallbackRating, 'total') ? { total: fallbackRating.total } : {}),
  } : undefined
  const payload: SubjectPayload = {
    id: subject.id,
    type: Object.hasOwn(subject, 'type') ? subject.type : fallback?.type,
    ...(Object.hasOwn(subject, 'name') ? { name: subject.name } : fallback && Object.hasOwn(fallback, 'name') ? { name: fallback.name } : {}),
    ...(Object.hasOwn(subject, 'name_cn') ? { name_cn: subject.name_cn } : fallback?.name_cn !== undefined ? { name_cn: fallback.name_cn } : {}),
    ...(Object.hasOwn(subject, 'summary') ? { summary: subject.summary } : fallback?.summary !== undefined ? { summary: fallback.summary } : {}),
    ...(Object.hasOwn(subject, 'nsfw') ? { nsfw: subject.nsfw } : fallback?.nsfw !== undefined ? { nsfw: fallback.nsfw } : {}),
    ...(Object.hasOwn(subject, 'date') ? { date: subject.date } : fallback?.date !== undefined ? { date: fallback.date } : {}),
    ...(Object.hasOwn(subject, 'eps') ? { eps: subject.eps } : fallback?.eps !== undefined ? { eps: fallback.eps } : {}),
    ...(Object.hasOwn(subject, 'total_episodes') ? { total_episodes: subject.total_episodes } : Object.hasOwn(subject, 'eps_count') ? { total_episodes: subject.eps_count } : fallback?.total_episodes !== undefined ? { total_episodes: fallback.total_episodes } : {}),
    ...((images || fallback?.images) ? { images: {
      ...(images && Object.hasOwn(images, 'common') ? { common: images.common } : fallback?.images?.common !== undefined ? { common: fallback.images.common } : {}),
      ...(images && Object.hasOwn(images, 'large') ? { large: images.large } : fallback?.images?.large !== undefined ? { large: fallback.images.large } : {}),
    } } : {}),
    ...(rating ? { rating } : {}),
  }
  return payload
}

function normalizedSubject(payload: SubjectPayload, upstreamUpdatedAt: string | null): SubjectInput {
  return { id: payload.id, subjectType: payload.type ?? 0, payload, contentHash: canonicalProjectionHash(payload), upstreamUpdatedAt }
}

export async function projectCompleteFullFetch(
  input: CompleteFullFetch,
  runId: string,
  configuredUsers: readonly ProjectionUser[],
): Promise<CompleteStateInput> {
  if (input.complete !== true) throw new Error('INCOMPLETE_FULL_FETCH')
  const userMap = new Map(configuredUsers.map((user) => [user.id, user]))
  if (userMap.size !== configuredUsers.length) throw new Error('DUPLICATE_PROJECTION_USER')
  if (!Array.isArray(input.observedUsers) || input.observedUsers.some((userId) => typeof userId !== 'string' || userId.length === 0)) {
    throw new Error('MISSING_OBSERVED_USER_EVIDENCE')
  }
  const observedUsers = new Set<string>()
  for (const userId of input.observedUsers) {
    if (observedUsers.has(userId)) throw new Error(`DUPLICATE_OBSERVED_PROJECTION_USER: ${userId}`)
    if (!userMap.has(userId)) throw new Error(`UNKNOWN_OBSERVED_PROJECTION_USER: ${userId}`)
    observedUsers.add(userId)
  }
  for (const user of configuredUsers) {
    if (!observedUsers.has(user.id)) throw new Error(`MISSING_OBSERVED_PROJECTION_USER: ${user.id}`)
  }
  const entriesByUser = new Map(configuredUsers.map((user) => [user.id, [] as BgmCollection[]]))
  for (const entry of input.collections) {
    const entries = entriesByUser.get(entry.user_id)
    if (!entries) throw new Error(`UNKNOWN_PROJECTION_USER: ${entry.user_id}`)
    entries.push(entry.collection)
  }
  const collectionSubjects = new Map<number, { payload: SubjectPayload; updatedAt: string }>()
  for (const user of configuredUsers) {
    for (const entry of entriesByUser.get(user.id)!) {
      if (!collectionSubjects.has(entry.subject_id)) collectionSubjects.set(entry.subject_id, { payload: collectionSubject(entry), updatedAt: entry.updated_at })
    }
  }
  const canonicalSubjects = new Map<number, SubjectInput>()
  for (const [id, source] of collectionSubjects) canonicalSubjects.set(id, normalizedSubject(source.payload, source.updatedAt))
  for (const day of input.calendar) {
    for (const subject of day.items) {
      const fallback = collectionSubjects.get(subject.id)
      const payload = calendarSubject(subject, fallback?.payload)
      canonicalSubjects.set(subject.id, normalizedSubject(payload, fallback?.updatedAt ?? null))
    }
  }
  const users = configuredUsers.map((user) => ({
    ...user,
    items: entriesByUser.get(user.id)!.map((entry) => ({
      subject: canonicalSubjects.get(entry.subject_id)!,
      collection: {
        payload: { type: entry.type, collection_type: entry.type, rate: entry.rate, tags: entry.tags, comment: entry.comment, ep_status: entry.ep_status, vol_status: entry.vol_status, private: entry.private },
        contentHash: canonicalProjectionHash({ type: entry.type, rate: entry.rate, tags: entry.tags, comment: entry.comment, ep_status: entry.ep_status, vol_status: entry.vol_status, private: entry.private }),
        upstreamUpdatedAt: entry.updated_at,
      },
    })),
  }))
  const calendarEntries = input.calendar.flatMap((day) => day.items.map((subject) => ({
    weekdayId: day.weekday.id,
    subjectId: subject.id,
    subject: canonicalSubjects.get(subject.id)!,
    payload: { weekday: day.weekday, subject_id: subject.id },
  })))
  return { runId, observedAt: new Date(input.observedAt * 1_000).toISOString(), users, calendarEntries }
}
