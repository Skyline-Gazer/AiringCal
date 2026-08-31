import {
  assembleFullFetch,
  BgmClient,
  type BgmCollection,
  type CollectionFetchGroup,
  type CompleteFullFetch,
} from '@airing-cal/bgm-api'
import { UpstreamFetchError, withRetry, type RetryPolicy, type UpstreamStage } from './retry.ts'

export { UpstreamFetchError } from './retry.ts'

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

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value)
}

function isSubjectType(value: unknown): value is number {
  return isSafeInteger(value) && [1, 2, 3, 4, 6].includes(value)
}

function isSlimSubject(value: unknown): boolean {
  if (!isRecord(value)) return false
  const { id, type, name, name_cn: nameCn, short_summary: shortSummary, date, tags, score, eps, volumes, collection_total: collectionTotal, rank, images } = value
  if (!isSafeInteger(id) || id < 1 || !isSubjectType(type) || typeof name !== 'string' || typeof nameCn !== 'string' || typeof shortSummary !== 'string' || (date !== undefined && typeof date !== 'string') || !Array.isArray(tags) || !tags.every((tag) => isRecord(tag) && typeof tag.name === 'string' && isSafeInteger(tag.count)) || typeof score !== 'number' || !Number.isFinite(score) || !isSafeInteger(eps) || !isSafeInteger(volumes) || !isSafeInteger(collectionTotal) || !isSafeInteger(rank) || !isRecord(images)) return false
  return ['large', 'common', 'medium', 'small', 'grid'].every((size) => typeof images[size] === 'string')
}

function isCollection(value: unknown): value is BgmCollection {
  if (!isRecord(value)) return false
  const { subject_id: subjectId, subject_type: subjectType, rate, type, comment, tags, ep_status: epStatus, vol_status: volStatus, updated_at: updatedAt, private: isPrivate, subject } = value
  return isSafeInteger(subjectId) && subjectId > 0
    && isSubjectType(subjectType)
    && isSafeInteger(rate) && isSafeInteger(type) && [1, 2, 3, 4, 5].includes(type)
    && (comment === undefined || typeof comment === 'string')
    && Array.isArray(tags) && tags.every((tag) => typeof tag === 'string')
    && isSafeInteger(epStatus) && isSafeInteger(volStatus)
    && typeof updatedAt === 'string' && Number.isFinite(Date.parse(updatedAt)) && typeof isPrivate === 'boolean'
    && (subject === undefined || isSlimSubject(subject))
}

function parseCollectionPage(value: unknown, expectedOffset: number, expectedLimit: number, expectedTotal?: number): { total: number; data: BgmCollection[] } {
  if (!isRecord(value)) throw contract('collections')
  const { total, offset, limit, data } = value
  if (!isSafeInteger(total) || total < 0 || offset !== expectedOffset || limit !== expectedLimit || !Array.isArray(data) || !data.every(isCollection)) {
    throw contract('collections')
  }
  if (expectedTotal !== undefined && total !== expectedTotal) throw contract('collections')
  const expectedLength = Math.min(expectedLimit, Math.max(0, total - expectedOffset))
  if (data.length !== expectedLength) throw contract('collections')
  return { total, data }
}

function validConfig(config: CompleteFetchConfig): boolean {
  const userIds = new Set<string>()
  return Array.isArray(config.users)
    && config.users.length > 0
    && typeof config.primaryUserId === 'string'
    && config.users.every((user) => typeof user.userId === 'string' && user.userId.length > 0 && typeof user.username === 'string' && user.username.length > 0 && !userIds.has(user.userId) && (userIds.add(user.userId), true))
    && userIds.has(config.primaryUserId)
}

export function createUpstreamBgmClient(token?: string): BgmClient {
  return new BgmClient(token, { maxGetRetries: 0 })
}

export async function fetchCompleteInput(config: CompleteFetchConfig, client: BgmClient, clock: () => number): Promise<CompleteFullFetch> {
  const pageLimit = config.pageLimit ?? 50
  if (!validConfig(config) || !Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 50 || !Number.isFinite(clock()) || clock() < 0 || (client instanceof BgmClient && client.maxGetRetries !== 0)) throw contract('config')
  const groups: CollectionFetchGroup[] = []
  for (const user of config.users) {
    const firstRaw = await withRetry(() => client.getCollections(user.username, 0, pageLimit), { ...config.retry, stage: 'collections' })
    let first: { total: number; data: BgmCollection[] }
    try {
      first = parseCollectionPage(firstRaw, 0, pageLimit)
    } catch {
      throw contract('collections')
    }
    const pages = [{ offset: 0, total: first.total, data: first.data }]
    const subjectIds = new Set(first.data.map((entry) => entry.subject_id))
    if (subjectIds.size !== first.data.length) throw contract('collections')
    for (let offset = pageLimit; offset < first.total; offset += pageLimit) {
      const pageRaw = await withRetry(() => client.getCollections(user.username, offset, pageLimit), { ...config.retry, stage: 'collections' })
      let page: { total: number; data: BgmCollection[] }
      try {
        page = parseCollectionPage(pageRaw, offset, pageLimit, first.total)
      } catch {
        throw contract('collections')
      }
      if (page.data.some((entry) => subjectIds.has(entry.subject_id))) throw contract('collections')
      for (const entry of page.data) subjectIds.add(entry.subject_id)
      pages.push({ offset, total: page.total, data: page.data })
    }
    groups.push({ user_id: user.userId, pageLimit, pages })
  }
  const calendar = await withRetry(() => client.getCalendar(), { ...config.retry, stage: 'calendar' })
  try {
    return assembleFullFetch(groups, calendar, Math.floor(clock() / 1_000))
  } catch {
    throw contract('complete')
  }
}
