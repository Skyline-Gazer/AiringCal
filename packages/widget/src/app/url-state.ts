import { COLLECTION_TYPES, type CollectionType } from './types.ts'

export type ViewKey = 'collection' | 'calendar'

export interface BrowseState {
  view: ViewKey
  type: CollectionType
  page: number
  day: number | null
}

export const DEFAULT_BROWSE: BrowseState = { view: 'collection', type: 'watching', page: 1, day: null }

const TYPES = new Set<string>(COLLECTION_TYPES.map((entry) => entry.key))

export function parseBrowseState(search: string): BrowseState {
  const params = new URLSearchParams(search)
  const view = params.get('view')
  const type = params.get('type')
  const page = Number(params.get('page'))
  const day = Number(params.get('day'))
  return {
    view: view === 'calendar' ? 'calendar' : 'collection',
    type: type && TYPES.has(type) ? (type as CollectionType) : DEFAULT_BROWSE.type,
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    day: Number.isSafeInteger(day) && day >= 1 && day <= 7 ? day : null,
  }
}

/** Only the keys this app owns are written; host parameters are preserved. */
export function writeBrowseState(search: string, state: BrowseState): string {
  const params = new URLSearchParams(search)
  params.set('view', state.view)
  params.set('type', state.type)
  if (state.page > 1) params.set('page', String(state.page))
  else params.delete('page')
  if (state.view === 'calendar' && state.day !== null) params.set('day', String(state.day))
  else params.delete('day')
  return params.toString()
}

/**
 * Only the shell rendered by `renderIndexPage` marks its container as
 * standalone. A host page with one container directly under body is still an
 * embed and must never have its URL rewritten.
 */
export function isStandalonePage(): boolean {
  return document.querySelectorAll('.bgm-container[data-bgm-standalone="1"]').length === 1
}
