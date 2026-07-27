import type { BgmCalendarItem, BgmCollection } from '@airing-cal/bgm-api'

export interface CollectionFetchPage {
  offset: number
  total: number
  data: BgmCollection[] | null
}

export interface CollectionFetchGroup {
  pages: CollectionFetchPage[]
  pageLimit: number
}

export interface CompleteFullFetch {
  collections: BgmCollection[]
  calendar: BgmCalendarItem[]
  complete: true
}

export function assembleFullFetch(
  groups: CollectionFetchGroup[],
  calendar: unknown,
): CompleteFullFetch {
  if (!Array.isArray(calendar)) throw new Error('Incomplete calendar fetch')
  const collections: BgmCollection[] = []
  for (const group of groups) {
    if (!Number.isSafeInteger(group.pageLimit) || group.pageLimit <= 0 || group.pages.length === 0) {
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
        collections.push(entry)
      }
    }
    if (subjectIds.size !== declaredTotal) throw new Error('Incomplete collection fetch')
  }
  return { collections, calendar: calendar as BgmCalendarItem[], complete: true }
}
