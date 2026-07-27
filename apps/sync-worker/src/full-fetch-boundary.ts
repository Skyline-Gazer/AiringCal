import type { BgmCalendarItem, BgmCollection } from '@airing-cal/bgm-api'

export interface CollectionFetchPage {
  offset: number
  total: number
  data: BgmCollection[] | null
}

export interface CollectionFetchGroup {
  user_id: string
  pages: CollectionFetchPage[]
  pageLimit: number
}

export interface CompleteFullFetch {
  collections: Array<{ user_id: string; collection: BgmCollection }>
  calendar: BgmCalendarItem[]
  observedAt: number
  complete: true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isCalendarSubject(value: unknown): boolean {
  if (!isRecord(value) || !isSafeNonNegativeInteger(value.id) || value.id === 0) return false
  if (![1, 2, 3, 4, 6].includes(value.type as number)) return false
  if (
    typeof value.name !== 'string'
    || typeof value.name_cn !== 'string'
    || typeof value.summary !== 'string'
    || !isSafeNonNegativeInteger(value.eps)
    || !isRecord(value.images)
  ) return false
  for (const size of ['large', 'common', 'medium', 'small', 'grid']) {
    if (typeof value.images[size] !== 'string') return false
  }
  if (!isRecord(value.rating) || typeof value.rating.score !== 'number' || !Number.isFinite(value.rating.score)) {
    return false
  }
  if (!isSafeNonNegativeInteger(value.rating.total)) return false
  if (value.rating.rank !== undefined && !isSafeNonNegativeInteger(value.rating.rank)) return false
  if (value.eps_count !== undefined && !isSafeNonNegativeInteger(value.eps_count)) return false
  if (value.total_episodes !== undefined && !isSafeNonNegativeInteger(value.total_episodes)) return false
  if (value.nsfw !== undefined && typeof value.nsfw !== 'boolean') return false
  if (value.date !== undefined && typeof value.date !== 'string') return false
  return true
}

function isCalendar(value: unknown): value is BgmCalendarItem[] {
  return Array.isArray(value) && value.every((day) => {
    if (!isRecord(day) || !isRecord(day.weekday) || !Array.isArray(day.items)) return false
    const weekday = day.weekday
    return typeof weekday.en === 'string'
      && typeof weekday.cn === 'string'
      && typeof weekday.ja === 'string'
      && Number.isSafeInteger(weekday.id)
      && day.items.every(isCalendarSubject)
  })
}

export function assembleFullFetch(
  groups: CollectionFetchGroup[],
  calendar: unknown,
  observedAt: number,
): CompleteFullFetch {
  if (!isCalendar(calendar)) throw new Error('Incomplete calendar fetch')
  if (!isSafeNonNegativeInteger(observedAt)) throw new Error('Invalid full-fetch observation')
  const collections: Array<{ user_id: string; collection: BgmCollection }> = []
  for (const group of groups) {
    if (
      typeof group.user_id !== 'string'
      || group.user_id.length === 0
      || !Number.isSafeInteger(group.pageLimit)
      || group.pageLimit <= 0
      || group.pages.length === 0
    ) {
      throw new Error('Incomplete collection fetch')
    }
    const declaredTotal = group.pages[0]?.total
    if (!Number.isSafeInteger(declaredTotal) || (declaredTotal as number) < 0) {
      throw new Error('Incomplete collection fetch')
    }
    const expectedPages = Math.max(1, Math.ceil((declaredTotal as number) / group.pageLimit))
    if (group.pages.length !== expectedPages) throw new Error('Incomplete collection fetch')
    const subjectIds = new Set<number>()
    for (let index = 0; index < group.pages.length; index++) {
      const page = group.pages[index]
      const expectedOffset = index * group.pageLimit
      const expectedLength = Math.min(group.pageLimit, Math.max(0, (declaredTotal as number) - expectedOffset))
      if (
        page === undefined
        || page.data === null
        || page.total !== declaredTotal
        || page.offset !== expectedOffset
        || page.data.length !== expectedLength
      ) {
        throw new Error('Incomplete collection fetch')
      }
      for (const entry of page.data) {
        if (!Number.isSafeInteger(entry?.subject_id) || entry.subject_id <= 0 || subjectIds.has(entry.subject_id)) {
          throw new Error('Incomplete collection fetch')
        }
        subjectIds.add(entry.subject_id)
        collections.push({ user_id: group.user_id, collection: entry })
      }
    }
    if (subjectIds.size !== declaredTotal) throw new Error('Incomplete collection fetch')
  }
  return { collections, calendar, observedAt, complete: true }
}
