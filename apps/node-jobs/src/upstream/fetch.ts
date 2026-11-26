import {
  assembleFullFetch,
  BgmClient,
  type BgmCollection,
  type CollectionFetchGroup,
  type CompleteFullFetch,
  type EpisodeProgressRecord,
  type EpisodeProgressSubject,
} from '@airing-cal/bgm-api'
import { emitProgress, emitStage } from '../sync/sync-progress.ts'
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

/**
 * Real bgm.tv pages encode unset optional fields as `null` while the OpenAPI
 * schema marks them optional strings. Drop those nulls at the boundary so the
 * strict contract and the typed domain keep treating them as absent.
 */
function withAbsentNulls(entry: unknown): unknown {
  if (!isRecord(entry)) return entry
  let next: Record<string, unknown> | null = null
  if (entry.comment === null) {
    next = { ...entry }
    delete next.comment
  }
  const subject = (next ?? entry).subject
  if (isRecord(subject) && subject.date === null) {
    next ??= { ...entry }
    next.subject = { ...subject }
    delete (next.subject as Record<string, unknown>).date
  }
  return next ?? entry
}

function parseCollectionPage(value: unknown, expectedOffset: number, expectedLimit: number, expectedTotal?: number): { total: number; data: BgmCollection[] } {
  if (!isRecord(value)) throw contract('collections')
  const { total, offset, limit, data: rawData } = value
  const data = Array.isArray(rawData) ? rawData.map(withAbsentNulls) : rawData
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

export async function fetchCompleteInput(
  config: CompleteFetchConfig,
  client: BgmClient,
  clock: () => number,
  episodeOpts: {
    /**
     * #195: user_id of the PAT owner. `/v0/users/-/…` answers for the token
     * identity ONLY, so episode progress is fetched exclusively for this
     * user; other configured users are skipped, never guessed.
     */
    tokenUserId?: string
    /** Bearer token for the episode-collection endpoint (same PAT). */
    episodeToken?: string
  } = {},
): Promise<CompleteFullFetch> {
  const pageLimit = config.pageLimit ?? 50
  if (!validConfig(config) || !Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 50 || !Number.isFinite(clock()) || clock() < 0 || (client instanceof BgmClient && client.maxGetRetries !== 0)) throw contract('config')
  const groups: CollectionFetchGroup[] = []
  for (const user of config.users) {
    emitStage('Bangumi collections fetch started', { stage: 'upstream_fetch', step: 'collections', username: user.username })
    const firstRaw = await withRetry(() => client.getCollections(user.username, 0, pageLimit), { ...config.retry, stage: 'collections' })
    let first: { total: number; data: BgmCollection[] }
    try {
      first = parseCollectionPage(firstRaw, 0, pageLimit)
    } catch {
      throw contract('collections')
    }
    const pageCount = Math.max(1, Math.ceil(first.total / pageLimit))
    let pagesDone = 1
    emitProgress('fetch', 'upstream_fetch_progress', pagesDone, pageCount, {
      step: 'collections',
      username: user.username,
      collection_total: first.total,
    })
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
      pagesDone += 1
      emitProgress('fetch', 'upstream_fetch_progress', pagesDone, pageCount, {
        step: 'collections',
        username: user.username,
        collection_total: first.total,
        offset,
      })
    }
    groups.push({ user_id: user.userId, pageLimit, pages })
    emitStage('Bangumi collections fetch complete', {
      stage: 'upstream_fetch',
      step: 'collections',
      username: user.username,
      collection_total: first.total,
      pages: pageCount,
    })
  }
  emitStage('Bangumi calendar fetch started', { stage: 'upstream_fetch', step: 'calendar' })
  const calendar = await withRetry(() => client.getCalendar(), { ...config.retry, stage: 'calendar' })
  const calendarItems = calendar.reduce((count, day) => count + day.items.length, 0)
  emitStage('Bangumi calendar fetch complete', {
    stage: 'upstream_fetch',
    step: 'calendar',
    calendar_days: calendar.length,
    calendar_items: calendarItems,
  })
  // #195: per-episode progress for the token owner's non-`want` collections.
  // Any incomplete episode/catalog fetch throws — the caller then keeps the
  // last valid release instead of publishing fabricated partial progress.
  const episodeProgress: EpisodeProgressSubject[] = []
  if (episodeOpts.tokenUserId) {
    for (const group of groups) {
      if (group.user_id !== episodeOpts.tokenUserId) continue
      const subjects = (group.pages ?? [])
        .flatMap((page) => page.data ?? [])
        .filter((entry) => [2, 3, 4, 5].includes(entry.type))
        .map((entry) => entry.subject_id)
        .sort((left, right) => left - right)
      emitStage('Bangumi episode progress fetch started', {
        stage: 'upstream_fetch',
        step: 'episodes',
        subjects: subjects.length,
      })
      let done = 0
      for (const subjectId of subjects) {
        const [states, catalog] = await Promise.all([
          withRetry(() => client.getSubjectEpisodeCollections(episodeOpts.episodeToken ?? '', subjectId), {
            ...config.retry,
            stage: 'episodes',
          }),
          withRetry(() => client.getSubjectEpisodeCatalog(subjectId), { ...config.retry, stage: 'episodes' }),
        ])
        const stateById = new Map(states.data.map((entry) => [entry.episode.id, entry]))
        const episodes: EpisodeProgressRecord[] = []
        for (const row of catalog) {
          const state = stateById.get(row.id)
          episodes.push({
            episode_id: row.id,
            collection_type: state?.type ?? 0,
            episode_type: row.type,
            ...(row.sort !== undefined ? { sort: row.sort } : {}),
            ...(row.ep !== undefined ? { ep: row.ep } : {}),
            ...(row.airdate !== undefined && row.airdate !== '' ? { airdate: row.airdate } : {}),
            updated_at: state?.updated_at ?? 0,
          })
        }
        // States for episodes the catalog did not list are kept (fail-open on
        // unexpected catalog subsets) — dropping them would fabricate absence.
        const catalogIds = new Set(catalog.map((row) => row.id))
        for (const entry of states.data) {
          if (catalogIds.has(entry.episode.id)) continue
          episodes.push({
            episode_id: entry.episode.id,
            collection_type: entry.type,
            ...(entry.episode.type !== undefined ? { episode_type: entry.episode.type } : {}),
            ...(entry.episode.sort !== undefined ? { sort: entry.episode.sort } : {}),
            ...(entry.episode.ep !== undefined ? { ep: entry.episode.ep } : {}),
            ...(entry.episode.airdate !== undefined && entry.episode.airdate !== '' ? { airdate: entry.episode.airdate } : {}),
            updated_at: entry.updated_at ?? 0,
          })
        }
        episodeProgress.push({
          user_id: group.user_id,
          subject_id: subjectId,
          observed_at: Math.floor(clock() / 1_000),
          episodes,
        })
        done += 1
        emitProgress('fetch', 'upstream_fetch_progress', done, subjects.length, {
          step: 'episodes',
          username: group.user_id,
        })
      }
      emitStage('Bangumi episode progress fetch complete', {
        stage: 'upstream_fetch',
        step: 'episodes',
        subjects: subjects.length,
        episodes: episodeProgress.reduce((count, entry) => count + entry.episodes.length, 0),
      })
    }
  }
  try {
    const assembled = assembleFullFetch(groups, calendar, Math.floor(clock() / 1_000), episodeProgress)
    emitStage('Bangumi full fetch assembled', {
      stage: 'upstream_fetch',
      step: 'complete',
      collections: assembled.collections.length,
      calendar_items: calendarItems,
      episode_subjects: assembled.episodeProgress.length,
    })
    return assembled
  } catch {
    throw contract('complete')
  }
}
