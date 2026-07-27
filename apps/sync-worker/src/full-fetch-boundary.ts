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

function normalizeCalendarSubject(value: unknown): BgmCalendarItem['items'][number] | null {
  if (!isRecord(value) || !isSafeNonNegativeInteger(value.id) || value.id === 0) return null
  if (![1, 2, 3, 4, 6].includes(value.type as number)) return null
  if (
    typeof value.name !== 'string'
    || typeof value.name_cn !== 'string'
    || typeof value.summary !== 'string'
  ) return null
  if (value.eps !== undefined && !isSafeNonNegativeInteger(value.eps)) return null
  if (value.images !== undefined) {
    if (!isRecord(value.images)) return null
    for (const size of ['large', 'common', 'medium', 'small', 'grid']) {
      if (value.images[size] !== undefined && typeof value.images[size] !== 'string') return null
    }
  }
  if (value.rating !== undefined) {
    if (!isRecord(value.rating)) return null
    if (value.rating.score !== undefined && (typeof value.rating.score !== 'number' || !Number.isFinite(value.rating.score))) {
      return null
    }
    if (value.rating.total !== undefined && !isSafeNonNegativeInteger(value.rating.total)) return null
    if (value.rating.rank !== undefined && !isSafeNonNegativeInteger(value.rating.rank)) return null
  }
  if (value.eps_count !== undefined && !isSafeNonNegativeInteger(value.eps_count)) return null
  if (value.total_episodes !== undefined && !isSafeNonNegativeInteger(value.total_episodes)) return null
  if (value.nsfw !== undefined && typeof value.nsfw !== 'boolean') return null
  if (value.date !== undefined && typeof value.date !== 'string') return null
  if (value.air_date !== undefined && typeof value.air_date !== 'string') return null
  const images = isRecord(value.images) ? value.images : {}
  const rating = isRecord(value.rating) && typeof value.rating.score === 'number'
    ? {
        score: value.rating.score,
        rank: isSafeNonNegativeInteger(value.rating.rank) ? value.rating.rank : 0,
        total: isSafeNonNegativeInteger(value.rating.total) ? value.rating.total : 0,
      }
    : undefined
  return {
    ...value,
    id: value.id,
    type: value.type as number,
    name: value.name,
    name_cn: value.name_cn,
    summary: value.summary,
    nsfw: value.nsfw === true,
    date: typeof value.date === 'string' ? value.date : typeof value.air_date === 'string' ? value.air_date : '',
    eps: isSafeNonNegativeInteger(value.eps) ? value.eps : 0,
    images: {
      large: typeof images.large === 'string' ? images.large : '',
      common: typeof images.common === 'string' ? images.common : '',
      medium: typeof images.medium === 'string' ? images.medium : '',
      small: typeof images.small === 'string' ? images.small : '',
      grid: typeof images.grid === 'string' ? images.grid : '',
    },
    ...(rating ? { rating } : {}),
  } as BgmCalendarItem['items'][number]
}

function normalizeCalendar(value: unknown): BgmCalendarItem[] | null {
  if (!Array.isArray(value)) return null
  const result: BgmCalendarItem[] = []
  for (const day of value) {
    if (!isRecord(day) || !isRecord(day.weekday) || !Array.isArray(day.items)) return null
    const weekday = day.weekday
    if (
      typeof weekday.en !== 'string'
      || typeof weekday.cn !== 'string'
      || typeof weekday.ja !== 'string'
      || !Number.isSafeInteger(weekday.id)
    ) return null
    const items = day.items.map(normalizeCalendarSubject)
    if (items.some((item) => item === null)) return null
    result.push({
      weekday: { en: weekday.en, cn: weekday.cn, ja: weekday.ja, id: weekday.id as number },
      items: items as BgmCalendarItem['items'],
    })
  }
  return result
}

export function assembleFullFetch(
  groups: CollectionFetchGroup[],
  calendar: unknown,
  observedAt: number,
): CompleteFullFetch {
  const normalizedCalendar = normalizeCalendar(calendar)
  if (normalizedCalendar === null) throw new Error('Incomplete calendar fetch')
  if (!isSafeNonNegativeInteger(observedAt)) throw new Error('Invalid full-fetch observation')
  const collections: Array<{ user_id: string; collection: BgmCollection }> = []
  const userIds = new Set<string>()
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
    if (userIds.has(group.user_id)) throw new Error(`Duplicate collection user: ${group.user_id}`)
    userIds.add(group.user_id)
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
  return { collections, calendar: normalizedCalendar, observedAt, complete: true }
}
