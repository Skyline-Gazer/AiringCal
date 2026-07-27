import type { BgmCalendarItem, BgmCollection } from '@airing-cal/bgm-api'

export interface CollectionFetchGroup {
  data: BgmCollection[] | null
  expectedTotal: number
}

export interface CompleteFullFetch {
  collections: BgmCollection[]
  calendar: BgmCalendarItem[]
  complete: true
}

export function assembleFullFetch(
  groups: CollectionFetchGroup[],
  calendar: BgmCalendarItem[] | null,
): CompleteFullFetch {
  if (calendar === null) throw new Error('Incomplete calendar fetch')
  const collections: BgmCollection[] = []
  for (const group of groups) {
    if (group.data === null || group.data.length !== group.expectedTotal) {
      throw new Error('Incomplete collection fetch')
    }
    collections.push(...group.data)
  }
  return { collections, calendar, complete: true }
}
