import {
  BgmClient,
  type BgmCalendarItem,
  type BgmCollection,
} from '@airing-cal/bgm-api'
import {
  UpstreamFetchError,
  withRetry,
  type RetryPolicy,
  type UpstreamStage,
} from './retry.js'

export { UpstreamFetchError } from './retry.js'

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

export interface CompleteFetchUser {
  userId: string
  username: string
}

export interface CompleteFetchConfig {
  users: readonly CompleteFetchUser[]
  primaryUserId: string
  pageLimit?: number
  retry?: Omit<RetryPolicy, 'stage'>
}

function contract(stage: UpstreamStage): UpstreamFetchError {
  return new UpstreamFetchError('contract', 'UPSTREAM_CONTRACT', stage, 1)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isSubjectType(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && [1, 2, 3, 4, 6].includes(value)
}

function isSlimSubject(value: unknown): boolean {
  if (!isRecord(value)) return false
  const {
    id,
    type,
    name,
    name_cn: nameCn,
    short_summary: shortSummary,
    date,
    tags,
    score,
    eps,
    volumes,
    collection_total: collectionTotal,
    rank,
    images,
  } = value
  if (
    !isSafeNonNegativeInteger(id)
    || id === 0
    || !isSubjectType(type)
    || typeof name !== 'string'
    || typeof nameCn !== 'string'
    || typeof shortSummary !== 'string'
    || (date !== undefined && typeof date !== 'string')
    || !Array.isArray(tags)
    || !tags.every((tag) => isRecord(tag) && typeof tag.name === 'string' && isSafeNonNegativeInteger(tag.count))
    || typeof score !== 'number'
    || !Number.isFinite(score)
    || !isSafeNonNegativeInteger(eps)
    || !isSafeNonNegativeInteger(volumes)
    || !isSafeNonNegativeInteger(collectionTotal)
    || !isSafeNonNegativeInteger(rank)
    || !isRecord(images)
  ) return false
  return ['large', 'common', 'medium', 'small', 'grid'].every((size) => typeof images[size] === 'string')
}

function isCollection(value: unknown): value is BgmCollection {
  if (!isRecord(value)) return false
  const {
    subject_id: subjectId,
    subject_type: subjectType,
    rate,
    type,
    comment,
    tags,
    ep_status: epStatus,
    vol_status: volStatus,
    updated_at: updatedAt,
    private: isPrivate,
    subject,
  } = value
  return isSafeNonNegativeInteger(subjectId)
    && subjectId > 0
    && isSubjectType(subjectType)
    && isSafeNonNegativeInteger(rate)
    && isSafeNonNegativeInteger(type)
    && [1, 2, 3, 4, 5].includes(type)
    && (comment === undefined || typeof comment === 'string')
    && Array.isArray(tags)
    && tags.every((tag) => typeof tag === 'string')
    && isSafeNonNegativeInteger(epStatus)
    && isSafeNonNegativeInteger(volStatus)
    && typeof updatedAt === 'string'
    && Number.isFinite(Date.parse(updatedAt))
    && typeof isPrivate === 'boolean'
    && (subject === undefined || isSlimSubject(subject))
}

function parseCollectionPage(
  value: unknown,
  expectedOffset: number,
  expectedLimit: number,
  expectedTotal?: number,
): { total: number; data: BgmCollection[] } {
  if (!isRecord(value)) throw contract('collections')
  const { total, offset, limit, data } = value
  if (
    !isSafeNonNegativeInteger(total)
    || (offset !== undefined && offset !== expectedOffset)
    || (limit !== undefined && limit !== expectedLimit)
    || !Array.isArray(data)
    || !data.every(isCollection)
  ) throw contract('collections')
  if (expectedTotal !== undefined && total !== expectedTotal) throw contract('collections')
  const expectedLength = Math.min(expectedLimit, Math.max(0, total - expectedOffset))
  if (data.length !== expectedLength) throw contract('collections')
  return { total, data }
}

function normalizeCalendarSubject(value: unknown): BgmCalendarItem['items'][number] | null {
  if (!isRecord(value) || !isSafeNonNegativeInteger(value.id) || value.id === 0 || !isSubjectType(value.type)) return null
  for (const field of ['name', 'name_cn', 'summary']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return null
  }
  for (const field of ['eps', 'eps_count', 'total_episodes', 'rank']) {
    if (value[field] !== undefined && !isSafeNonNegativeInteger(value[field])) return null
  }
  if (value.nsfw !== undefined && typeof value.nsfw !== 'boolean') return null
  if (value.date !== undefined && typeof value.date !== 'string') return null
  if (value.air_date !== undefined && typeof value.air_date !== 'string') return null
  if (value.images !== undefined) {
    if (!isRecord(value.images)) return null
    for (const size of ['large', 'common', 'medium', 'small', 'grid']) {
      if (value.images[size] !== undefined && typeof value.images[size] !== 'string') return null
    }
  }
  if (value.rating !== undefined) {
    if (!isRecord(value.rating)) return null
    if (value.rating.score !== undefined && (typeof value.rating.score !== 'number' || !Number.isFinite(value.rating.score))) return null
    if (value.rating.total !== undefined && !isSafeNonNegativeInteger(value.rating.total)) return null
    if (value.rating.rank !== undefined && !isSafeNonNegativeInteger(value.rating.rank)) return null
  }
  const images = isRecord(value.images) ? value.images : {}
  const rating = isRecord(value.rating) && typeof value.rating.score === 'number'
    ? {
        score: value.rating.score,
        rank: isSafeNonNegativeInteger(value.rank)
          ? value.rank
          : isRecord(value.rating) && isSafeNonNegativeInteger(value.rating.rank) ? value.rating.rank : 0,
        total: isRecord(value.rating) && isSafeNonNegativeInteger(value.rating.total) ? value.rating.total : 0,
      }
    : undefined
  return {
    id: value.id,
    type: value.type,
    name: typeof value.name === 'string' ? value.name : '',
    name_cn: typeof value.name_cn === 'string' ? value.name_cn : '',
    summary: typeof value.summary === 'string' ? value.summary : '',
    nsfw: value.nsfw === true,
    date: typeof value.date === 'string' ? value.date : typeof value.air_date === 'string' ? value.air_date : '',
    eps: isSafeNonNegativeInteger(value.eps) ? value.eps : 0,
    ...(isSafeNonNegativeInteger(value.eps_count) ? { eps_count: value.eps_count } : {}),
    ...(isSafeNonNegativeInteger(value.total_episodes) ? { total_episodes: value.total_episodes } : {}),
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

function assembleFullFetch(groups: CollectionFetchGroup[], calendar: unknown, observedAt: number): CompleteFullFetch {
  if (!Array.isArray(calendar)) throw new Error('Incomplete calendar fetch')
  const normalizedCalendar: BgmCalendarItem[] = []
  for (const day of calendar) {
    if (!isRecord(day) || !isRecord(day.weekday) || !Array.isArray(day.items)) throw new Error('Incomplete calendar fetch')
    const weekday = day.weekday
    if (
      typeof weekday.en !== 'string'
      || typeof weekday.cn !== 'string'
      || typeof weekday.ja !== 'string'
      || !isSafeNonNegativeInteger(weekday.id)
    ) throw new Error('Incomplete calendar fetch')
    const items = day.items.map(normalizeCalendarSubject)
    if (items.some((item) => item === null)) throw new Error('Incomplete calendar fetch')
    normalizedCalendar.push({
      weekday: { en: weekday.en, cn: weekday.cn, ja: weekday.ja, id: weekday.id },
      items: items as BgmCalendarItem['items'],
    })
  }
  if (!isSafeNonNegativeInteger(observedAt)) throw new Error('Invalid full-fetch observation')
  const collections: Array<{ user_id: string; collection: BgmCollection }> = []
  const userIds = new Set<string>()
  for (const group of groups) {
    if (
      typeof group.user_id !== 'string'
      || group.user_id.length === 0
      || !Number.isSafeInteger(group.pageLimit)
      || group.pageLimit <= 0
      || !Array.isArray(group.pages)
      || group.pages.length === 0
    ) throw new Error('Incomplete collection fetch')
    if (userIds.has(group.user_id)) throw new Error(`Duplicate collection user: ${group.user_id}`)
    userIds.add(group.user_id)
    const declaredTotal = group.pages[0]?.total
    if (!isSafeNonNegativeInteger(declaredTotal)) throw new Error('Incomplete collection fetch')
    const expectedPages = Math.max(1, Math.ceil(declaredTotal / group.pageLimit))
    if (group.pages.length !== expectedPages) throw new Error('Incomplete collection fetch')
    const subjectIds = new Set<number>()
    for (let index = 0; index < group.pages.length; index++) {
      const page = group.pages[index]
      const expectedOffset = index * group.pageLimit
      const expectedLength = Math.min(group.pageLimit, Math.max(0, declaredTotal - expectedOffset))
      if (
        page === undefined
        || page.data === null
        || page.total !== declaredTotal
        || page.offset !== expectedOffset
        || page.data.length !== expectedLength
      ) throw new Error('Incomplete collection fetch')
      for (const entry of page.data) {
        if (!isSafeNonNegativeInteger(entry.subject_id) || entry.subject_id === 0 || subjectIds.has(entry.subject_id)) {
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

function validConfig(config: CompleteFetchConfig): boolean {
  if (!isRecord(config) || !Array.isArray(config.users) || config.users.length === 0 || typeof config.primaryUserId !== 'string') return false
  const userIds = new Set<string>()
  const usernames = new Set<string>()
  for (const user of config.users) {
    if (!isRecord(user) || typeof user.userId !== 'string' || user.userId.length === 0 || userIds.has(user.userId)) return false
    if (typeof user.username !== 'string' || user.username.length === 0 || usernames.has(user.username)) return false
    userIds.add(user.userId)
    usernames.add(user.username)
  }
  return userIds.has(config.primaryUserId)
}

function hasImplicitRetries(client: BgmClient): boolean {
  if (!(client instanceof BgmClient)) return false
  return (client as unknown as { maxGetRetries?: unknown }).maxGetRetries !== 0
}

export function createUpstreamBgmClient(token?: string): BgmClient {
  return new BgmClient(token, { maxGetRetries: 0 })
}

export async function fetchCompleteInput(
  config: CompleteFetchConfig,
  client: BgmClient,
  clock: () => number,
): Promise<CompleteFullFetch> {
  const pageLimit = config?.pageLimit ?? 50
  let clockNow: number
  try {
    clockNow = clock()
  } catch {
    throw contract('config')
  }
  if (
    !validConfig(config)
    || !Number.isSafeInteger(pageLimit)
    || pageLimit < 1
    || pageLimit > 50
    || !Number.isFinite(clockNow)
    || clockNow < 0
    || hasImplicitRetries(client)
  ) throw contract('config')

  const groups: CollectionFetchGroup[] = []
  for (const user of config.users) {
    const firstRaw = await withRetry(
      () => client.getCollections(user.username, 0, pageLimit),
      { ...config.retry, stage: 'collections' },
    )
    const first = parseCollectionPage(firstRaw, 0, pageLimit)
    const pages: CollectionFetchPage[] = [{ offset: 0, total: first.total, data: first.data }]
    const subjectIds = new Set(first.data.map((entry) => entry.subject_id))
    if (subjectIds.size !== first.data.length) throw contract('collections')
    for (let offset = pageLimit; offset < first.total; offset += pageLimit) {
      const pageRaw = await withRetry(
        () => client.getCollections(user.username, offset, pageLimit),
        { ...config.retry, stage: 'collections' },
      )
      const page = parseCollectionPage(pageRaw, offset, pageLimit, first.total)
      if (page.data.some((entry) => subjectIds.has(entry.subject_id))) throw contract('collections')
      for (const entry of page.data) subjectIds.add(entry.subject_id)
      pages.push({ offset, total: page.total, data: page.data })
    }
    groups.push({ user_id: user.userId, pageLimit, pages })
  }

  const calendar = await withRetry(
    () => client.getCalendar(),
    { ...config.retry, stage: 'calendar' },
  )
  try {
    return assembleFullFetch(groups, calendar, Math.floor(clockNow / 1_000))
  } catch {
    throw contract('complete')
  }
}
