import {
  BgmClient,
  assembleFullFetch,
  type BgmCollection,
  type BgmSlimSubject,
  type CollectionFetchGroup,
  type CollectionFetchPage,
  type CompleteFullFetch,
} from '@airing-cal/bgm-api'
import {
  UpstreamFetchError,
  withRetry,
  type RetryPolicy,
  type UpstreamStage,
} from './retry.js'

export { UpstreamFetchError } from './retry.js'
export type { CollectionFetchGroup, CollectionFetchPage, CompleteFullFetch } from '@airing-cal/bgm-api'

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

function normalizeSlimSubject(value: unknown): BgmSlimSubject | null {
  if (!isRecord(value)) return null
  const isTransport = 'short_summary' in value || 'collection_total' in value || 'volumes' in value || 'tags' in value
  const {
    id,
    type,
    name,
    name_cn: nameCn,
    summary,
    short_summary: shortSummary,
    date,
    tags,
    score,
    eps,
    volumes,
    collection_total: collectionTotal,
    rank,
    total_episodes: totalEpisodes,
    nsfw,
    images,
    rating,
  } = value
  if (
    !isSafeNonNegativeInteger(id)
    || id === 0
    || !isSubjectType(type)
    || typeof name !== 'string'
    || typeof nameCn !== 'string'
    || (summary !== undefined && typeof summary !== 'string')
    || (shortSummary !== undefined && typeof shortSummary !== 'string')
    || (date !== undefined && typeof date !== 'string')
    || !isSafeNonNegativeInteger(eps)
    || (totalEpisodes !== undefined && !isSafeNonNegativeInteger(totalEpisodes))
    || (nsfw !== undefined && typeof nsfw !== 'boolean')
    || !isRecord(images)
    || !['large', 'common', 'medium', 'small', 'grid'].every((size) => typeof images[size] === 'string')
  ) return null

  if (!isTransport && typeof summary !== 'string') return null

  if (isTransport && (
    typeof shortSummary !== 'string'
    || !Array.isArray(tags)
    || !tags.every((tag) => isRecord(tag) && typeof tag.name === 'string' && isSafeNonNegativeInteger(tag.count))
    || !isSafeNonNegativeInteger(volumes)
    || typeof score !== 'number'
    || !Number.isFinite(score)
    || !isSafeNonNegativeInteger(collectionTotal)
    || !isSafeNonNegativeInteger(rank)
  )) return null
  if (score !== undefined && (typeof score !== 'number' || !Number.isFinite(score))) return null
  if (collectionTotal !== undefined && !isSafeNonNegativeInteger(collectionTotal)) return null
  if (rank !== undefined && !isSafeNonNegativeInteger(rank)) return null

  const canonicalRating = isRecord(rating)
    && typeof rating.score === 'number'
    && Number.isFinite(rating.score)
    && isSafeNonNegativeInteger(rating.rank)
    && isSafeNonNegativeInteger(rating.total)
    ? { score: rating.score, rank: rating.rank, total: rating.total }
    : null
  const transportRating = typeof score === 'number'
    && Number.isFinite(score)
    && isSafeNonNegativeInteger(rank)
    && isSafeNonNegativeInteger(collectionTotal)
    ? { score, rank, total: collectionTotal }
    : null
  const normalizedRating = canonicalRating ?? transportRating
  if (normalizedRating === null) return null

  return {
    id,
    type,
    name,
    name_cn: nameCn,
    summary: typeof summary === 'string' ? summary : shortSummary as string,
    nsfw: nsfw === true,
    date: typeof date === 'string' ? date : '',
    eps,
    total_episodes: isSafeNonNegativeInteger(totalEpisodes) ? totalEpisodes : eps,
    images: {
      large: images.large as string,
      common: images.common as string,
      medium: images.medium as string,
      small: images.small as string,
      grid: images.grid as string,
    },
    rating: normalizedRating,
  }
}

function normalizeCollection(value: unknown): BgmCollection | null {
  if (!isRecord(value)) return null
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
  if (!isSafeNonNegativeInteger(subjectId)
    || subjectId === 0
    || !isSubjectType(subjectType)
    || !isSafeNonNegativeInteger(rate)
    || !isSafeNonNegativeInteger(type)
    || ![1, 2, 3, 4, 5].includes(type)
    || (comment !== undefined && typeof comment !== 'string')
    || !Array.isArray(tags)
    || !tags.every((tag) => typeof tag === 'string')
    || !isSafeNonNegativeInteger(epStatus)
    || !isSafeNonNegativeInteger(volStatus)
    || typeof updatedAt !== 'string'
    || !Number.isFinite(Date.parse(updatedAt))
    || typeof isPrivate !== 'boolean'
  ) return null
  const normalizedSubject = subject === undefined ? undefined : normalizeSlimSubject(subject)
  if (subject !== undefined && normalizedSubject === null) return null
  return {
    ...value,
    ...(normalizedSubject === undefined ? {} : { subject: normalizedSubject }),
  } as BgmCollection
}

function parseCollectionPage(
  value: unknown,
  expectedOffset: number,
  expectedLimit: number,
  expectedTotal?: number,
): { total: number; data: BgmCollection[] } {
  if (!isRecord(value)) throw contract('collections')
  const { total, offset, limit, data } = value
  const normalizedData = Array.isArray(data) ? data.map(normalizeCollection) : null
  if (
    !isSafeNonNegativeInteger(total)
    || (offset !== undefined && offset !== expectedOffset)
    || (limit !== undefined && limit !== expectedLimit)
    || normalizedData === null
    || normalizedData.some((entry) => entry === null)
  ) throw contract('collections')
  if (expectedTotal !== undefined && total !== expectedTotal) throw contract('collections')
  const expectedLength = Math.min(expectedLimit, Math.max(0, total - expectedOffset))
  if (normalizedData.length !== expectedLength) throw contract('collections')
  return { total, data: normalizedData as BgmCollection[] }
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
