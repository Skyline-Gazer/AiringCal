export const packageBoundary = '@airing-cal/domain'

export type CollectionType = 'want' | 'watched' | 'watching' | 'on_hold' | 'dropped'

export interface ImageRef {
  hash: string
  uri: string
  r2_key: string
}

export interface SubjectImages {
  common: ImageRef | null
  large: ImageRef | null
}

export interface SubjectMeta {
  subject_id: number
  exists: boolean | null
  nsfw: boolean
  checked_at: number
  expires_at?: number | null
  reason: 'subject_detail' | 'not_found' | 'not_found_or_restricted' | 'network_error' | 'upstream_error'
}

export interface BgmCollectionLike {
  subject_id: number
  subject_type: number
  rate: number
  type: number
  comment: string
  tags: string[]
  ep_status: number
  vol_status: number
  updated_at: string
  private: boolean
  subject?: {
    id: number
    name: string
    name_cn: string
    summary: string
    date: string
    eps: number
    total_episodes: number
    images?: { large?: string; common?: string }
    nsfw?: boolean
  }
}

export interface MergedEntry {
  subject_id: number
  name: string
  name_cn: string
  summary: string
  images: SubjectImages
  eps: number
  total_episodes: number
  ep_status: number
  vol_status: number
  type: number
  collection_type: number
  rate: number
  nsfw: boolean
  date: string
  tags: string[]
  updated_at: string
}

export interface MergedCollections {
  want: MergedEntry[]
  watched: MergedEntry[]
  watching: MergedEntry[]
  on_hold: MergedEntry[]
  dropped: MergedEntry[]
  updated_at: string
}

export type SubjectImageMap = Map<number, SubjectImages>
export type SubjectMetaMap = Map<number, Pick<SubjectMeta, 'nsfw'>>
export type SubjectDetailMap = Map<number, SubjectDetailLike>

export type PlatformId = 'bgm'

export enum WatchStatus {
  WATCHING = 'watching',
  COMPLETED = 'completed',
  PLAN_TO_WATCH = 'plan_to_watch',
  ON_HOLD = 'on_hold',
  DROPPED = 'dropped',
}

export interface ComparisonItem {
  externalId: string
  title: string
  status: WatchStatus
  progress: number
  totalEpisodes: number
  score: number
  platform: PlatformId
}

export interface PatchEntryOptions {
  sourceToken?: string
}

export interface PatchEntryResult {
  episodeChanged: number
  episodeProgress?: {
    before: number
    after: number
    total: number
  }
}

export interface AccountInfo {
  username: string
  externalId: string
  platform: PlatformId
}

export interface PlatformClient {
  readonly platform: PlatformId
  getMe(token: string): Promise<AccountInfo>
  fetchCollections(token: string, username: string): Promise<ComparisonItem[]>
  patchEntry(token: string, externalId: string, item: ComparisonItem, options?: PatchEntryOptions): Promise<PatchEntryResult>
}

export interface Difference {
  externalId: string
  title: string
  statusA: string
  statusB: string
  progressA: number
  progressB: number
  scoreA: number
  scoreB: number
  itemA?: ComparisonItem
  itemB?: ComparisonItem
}

export interface SameEntry {
  externalId: string
  title: string
  status: string
  progress: number
  totalEpisodes: number
  score: number
}

export interface CompareResult {
  userA: { name: string; total: number; error?: string }
  userB: { name: string; total: number; error?: string }
  common: number
  differences: Difference[]
  same: SameEntry[]
  onlyA: Difference[]
  onlyB: Difference[]
}

export interface SyncBaseline {
  externalId: string
  status?: string | null
  score?: number | null
  progress?: number | null
  totalEpisodes?: number | null
}

export interface SyncRequest {
  mode: 'full' | 'partial'
  from: string
  to: string
  items?: ComparisonItem[]
  subject_ids?: string[]
  baseline?: SyncBaseline[]
}

export interface FieldChange<T> {
  before: T
  after: T
}

export interface SyncResult {
  externalId: string
  title: string
  status: 'ok' | 'error'
  collectionStatus?: FieldChange<string>
  scoreChange?: FieldChange<number | null>
  episodeChanged?: number
  episodeProgress?: {
    before: number
    after: number
    total: number
  }
  error?: string
  code?: 'EPISODE_PATCH_PARTIAL'
  succeeded?: number
  failedBatch?: {
    index: number
    episodeIds: number[]
  }
}

export class SyncValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncValidationError'
  }
}

export interface BgmCalendarSubjectLike {
  id: number
  type: number
  name: string
  name_cn: string
  summary: string
  nsfw?: boolean
  date: string
  eps?: number
  eps_count?: number
  total_episodes?: number
  images?: { large?: string; common?: string; medium?: string; small?: string; grid?: string }
  rating?: { score: number; rank: number; total: number }
}

export interface SubjectDetailLike {
  id?: number
  type?: number
  name?: string
  name_cn?: string
  summary?: string
  nsfw?: boolean
  date?: string
  eps?: number
  eps_count?: number
  total_episodes?: number
  images?: { large?: string; common?: string; medium?: string; small?: string; grid?: string }
  rating?: { score: number; rank: number; total: number }
}

export interface BgmCalendarDayLike {
  weekday: { en: string; cn: string; ja: string; id: number }
  items: BgmCalendarSubjectLike[]
}

export interface CalendarSubjectSnapshot {
  subject_id: number
  id: number
  type: number
  name: string
  name_cn: string
  summary: string
  images: SubjectImages
  nsfw: boolean
  date: string
  eps: number
  total_episodes: number
  rating?: { score: number; rank: number; total: number }
}

export interface CalendarDaySnapshot {
  weekday: BgmCalendarDayLike['weekday']
  items: CalendarSubjectSnapshot[]
}

interface CachedImageStatusLike {
  status?: string
  hash?: string | null
  uri?: string | null
  r2_key?: string | null
}

interface ImageStatusLike {
  common?: CachedImageStatusLike | null
  large?: CachedImageStatusLike | null
}

const TYPE_MAP: Record<number, CollectionType> = {
  1: 'want',
  2: 'watched',
  3: 'watching',
  4: 'on_hold',
  5: 'dropped',
}

export function imageRef(hash: string): ImageRef {
  return {
    hash,
    uri: `/image/${hash}`,
    r2_key: `images/${hash}/original`,
  }
}

export function subjectMetaFromNotFound(subjectId: number, checkedAt: number): SubjectMeta {
  return {
    subject_id: subjectId,
    exists: false,
    nsfw: true,
    checked_at: checkedAt,
    expires_at: checkedAt + 86400,
    reason: 'not_found',
  }
}

export function isActiveNotFoundSubjectMeta(meta: SubjectMeta | null | undefined, now: number): meta is SubjectMeta & { exists: false; reason: 'not_found'; expires_at: number } {
  return meta?.exists === false
    && meta.reason === 'not_found'
    && typeof meta.expires_at === 'number'
    && now < meta.expires_at
}

export function isConfirmedNotFoundSubjectMeta(meta: SubjectMeta | null | undefined): meta is SubjectMeta & { exists: false; reason: 'not_found' | 'not_found_or_restricted' } {
  return meta?.exists === false && (meta.reason === 'not_found' || meta.reason === 'not_found_or_restricted')
}

export function subjectMetaFromDetail(subjectId: number, subject: SubjectDetailLike, checkedAt: number): SubjectMeta {
  return {
    subject_id: subjectId,
    exists: true,
    nsfw: subject.nsfw === true,
    checked_at: checkedAt,
    expires_at: null,
    reason: 'subject_detail',
  }
}

export function subjectDetailImages(subject: SubjectDetailLike | null | undefined): { common?: string; large?: string } {
  const images = subject?.images && typeof subject.images === 'object' ? subject.images : {}
  return {
    common: images.common,
    large: images.large,
  }
}

export function imageRefsFromStatus(status: ImageStatusLike | null | undefined): SubjectImages {
  return {
    common: cachedImageRef(status?.common),
    large: cachedImageRef(status?.large),
  }
}

function cachedImageRef(status: CachedImageStatusLike | null | undefined): ImageRef | null {
  if (status?.status !== 'cached' || !status.hash || !status.uri || !status.r2_key) return null
  return { hash: status.hash, uri: status.uri, r2_key: status.r2_key }
}

function toTimestamp(value: string | undefined): number {
  if (!value) return 0
  const timestamp = new Date(value).getTime()
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function calendarEpisodeCount(subject: BgmCalendarSubjectLike): number {
  for (const value of [subject.eps, subject.eps_count, subject.total_episodes]) {
    if (typeof value === 'number' && value > 0) return value
  }
  return 0
}

function positiveEpisodeCount(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && value > 0) return value
  }
}

export function withSubjectDetail<T extends BgmCalendarSubjectLike>(subject: T, detail: SubjectDetailLike | null | undefined): T {
  if (!detail || typeof detail !== 'object') return subject
  const eps = positiveEpisodeCount(
    detail.eps,
    detail.eps_count,
    detail.total_episodes,
    subject.eps,
    subject.eps_count,
    subject.total_episodes,
  )
  const totalEpisodes = positiveEpisodeCount(
    detail.total_episodes,
    detail.eps,
    detail.eps_count,
    subject.total_episodes,
    subject.eps,
    subject.eps_count,
  )
  return {
    ...subject,
    type: detail.type ?? subject.type,
    name: detail.name ?? subject.name,
    name_cn: detail.name_cn ?? subject.name_cn,
    summary: detail.summary ?? subject.summary,
    nsfw: detail.nsfw ?? subject.nsfw,
    date: detail.date ?? subject.date,
    eps: eps ?? subject.eps,
    eps_count: eps ?? subject.eps_count,
    total_episodes: totalEpisodes ?? subject.total_episodes,
    images: detail.images ?? subject.images,
    rating: detail.rating ?? subject.rating,
  }
}

function toMergedEntry(collection: BgmCollectionLike, imageMap?: SubjectImageMap, subjectMetaMap?: SubjectMetaMap, subjectDetailMap?: SubjectDetailMap): MergedEntry {
  const subject = collection.subject
  const detail = subjectDetailMap?.get(collection.subject_id)
  const eps = positiveEpisodeCount(detail?.eps, detail?.eps_count, detail?.total_episodes, subject?.eps)
  const totalEpisodes = positiveEpisodeCount(detail?.total_episodes, detail?.eps, detail?.eps_count, subject?.total_episodes, subject?.eps)
  return {
    subject_id: collection.subject_id,
    name: detail?.name ?? subject?.name ?? '',
    name_cn: detail?.name_cn ?? subject?.name_cn ?? '',
    summary: detail?.summary ?? subject?.summary ?? '',
    images: imageMap?.get(collection.subject_id) ?? { common: null, large: null },
    eps: eps ?? 0,
    total_episodes: totalEpisodes ?? 0,
    ep_status: collection.ep_status,
    vol_status: collection.vol_status,
    type: collection.subject_type,
    collection_type: collection.type,
    rate: collection.rate,
    nsfw: subjectMetaMap?.get(collection.subject_id)?.nsfw ?? detail?.nsfw ?? subject?.nsfw ?? false,
    date: detail?.date ?? subject?.date ?? '',
    tags: collection.tags ?? [],
    updated_at: collection.updated_at,
  }
}

export function mergeCollections(collections: BgmCollectionLike[], imageMap?: SubjectImageMap, subjectMetaMap?: SubjectMetaMap, subjectDetailMap?: SubjectDetailMap): MergedCollections {
  const latestBySubject = new Map<number, MergedEntry>()

  for (const collection of collections) {
    const entry = toMergedEntry(collection, imageMap, subjectMetaMap, subjectDetailMap)
    const existing = latestBySubject.get(collection.subject_id)
    if (!existing || toTimestamp(collection.updated_at) > toTimestamp(existing.updated_at)) {
      latestBySubject.set(collection.subject_id, entry)
    }
  }

  const merged: MergedCollections = {
    want: [],
    watched: [],
    watching: [],
    on_hold: [],
    dropped: [],
    updated_at: new Date().toISOString(),
  }
  for (const entry of latestBySubject.values()) {
    merged[TYPE_MAP[entry.collection_type] ?? 'want'].push(entry)
  }
  return merged
}

export function transformCalendar(calendar: BgmCalendarDayLike[], imageMap?: SubjectImageMap, subjectMetaMap?: SubjectMetaMap): CalendarDaySnapshot[] {
  return calendar.map((day) => ({
    weekday: day.weekday,
    items: day.items.map((subject) => {
      const episodeCount = calendarEpisodeCount(subject)
      return {
        subject_id: subject.id,
        id: subject.id,
        type: subject.type,
        name: subject.name,
        name_cn: subject.name_cn,
        summary: subject.summary,
        images: imageMap?.get(subject.id) ?? { common: null, large: null },
        nsfw: subjectMetaMap?.get(subject.id)?.nsfw ?? subject.nsfw === true,
        date: subject.date,
        eps: episodeCount,
        total_episodes: typeof subject.total_episodes === 'number' && subject.total_episodes > 0 ? subject.total_episodes : episodeCount,
        ...(subject.rating ? { rating: subject.rating } : {}),
      }
    }),
  }))
}

function statusLabel(status: string | null | undefined): string {
  if (!status || status === '—') return '未收藏'
  return ({
    [WatchStatus.WATCHING]: '在看',
    [WatchStatus.COMPLETED]: '看过',
    [WatchStatus.PLAN_TO_WATCH]: '想看',
    [WatchStatus.ON_HOLD]: '搁置',
    [WatchStatus.DROPPED]: '抛弃',
  } as Record<string, string>)[status] || status
}

export async function compareAccounts(
  clientA: PlatformClient,
  tokenA: string,
  clientB: PlatformClient,
  tokenB: string,
): Promise<CompareResult> {
  const [meA, meB] = await Promise.all([
    clientA.getMe(tokenA),
    clientB.getMe(tokenB),
  ])
  const nameA = meA.username
  const nameB = meB.username

  const [settledA, settledB] = await Promise.allSettled([
    clientA.fetchCollections(tokenA, nameA),
    clientB.fetchCollections(tokenB, nameB),
  ])

  for (const settled of [settledA, settledB]) {
    if (settled.status !== 'rejected') continue
    const authenticationError = findAuthenticationError(settled.reason)
    if (authenticationError) throw authenticationError
  }

  const colA = unwrapCollections(settledA, nameA)
  const colB = unwrapCollections(settledB, nameB)

  if (colA.error && colB.error) {
    return { userA: colA, userB: colB, common: 0, same: [], onlyA: [], onlyB: [], differences: [] }
  }

  const mapA = new Map(colA.items.map((item) => [item.externalId, item]))
  const mapB = new Map(colB.items.map((item) => [item.externalId, item]))
  const differences: Difference[] = []
  const same: SameEntry[] = []
  const onlyA: Difference[] = []
  const onlyB: Difference[] = []
  const allIds = new Set([...mapA.keys(), ...mapB.keys()])

  for (const id of allIds) {
    const a = mapA.get(id)
    const b = mapB.get(id)
    if (a && b) {
      if (a.status === b.status && a.progress === b.progress && a.score === b.score) {
        same.push({
          externalId: id,
          title: a.title,
          status: statusLabel(a.status),
          progress: a.progress,
          totalEpisodes: a.totalEpisodes,
          score: a.score,
        })
      } else {
        differences.push({
          externalId: id,
          title: a.title || b.title,
          statusA: statusLabel(a.status),
          statusB: statusLabel(b.status),
          progressA: a.progress,
          progressB: b.progress,
          scoreA: a.score,
          scoreB: b.score,
          itemA: a,
          itemB: b,
        })
      }
    } else if (a) {
      onlyA.push({ externalId: id, title: a.title, statusA: statusLabel(a.status), statusB: '—', progressA: a.progress, progressB: 0, scoreA: a.score, scoreB: 0, itemA: a })
    } else if (b) {
      onlyB.push({ externalId: id, title: b.title, statusA: '—', statusB: statusLabel(b.status), progressA: 0, progressB: b.progress, scoreA: 0, scoreB: b.score, itemB: b })
    }
  }

  return {
    userA: colA,
    userB: colB,
    common: [...allIds].filter((id) => mapA.has(id) && mapB.has(id)).length,
    same,
    onlyA,
    onlyB,
    differences,
  }
}

function findAuthenticationError(error: unknown): Error & { status: 401 | 403 } | null {
  if (!(error instanceof Error)) return null
  if ('status' in error && (error.status === 401 || error.status === 403)) return error as Error & { status: 401 | 403 }
  return findAuthenticationError(error.cause)
}

function unwrapCollections(settled: PromiseSettledResult<ComparisonItem[]>, name: string) {
  if (settled.status === 'fulfilled') return { name, items: settled.value, total: settled.value.length }
  const reason = settled.reason instanceof Error ? settled.reason.message : String(settled.reason)
  return { name, items: [] as ComparisonItem[], total: 0, error: reason }
}

export async function executeSync(
  clientA: PlatformClient,
  fromToken: string,
  clientB: PlatformClient,
  toToken: string,
  request: SyncRequest,
): Promise<SyncResult[]> {
  validateSyncRequest(request)
  let targets: ComparisonItem[]
  if (request.items) {
    targets = request.items
  } else {
    const sourceAccount = await clientA.getMe(fromToken)
    const sourceCollections = await clientA.fetchCollections(fromToken, sourceAccount.username)
    targets = request.mode === 'full'
      ? sourceCollections
      : sourceCollections.filter((item) => new Set(request.subject_ids ?? []).has(item.externalId))
  }
  const baselineMap = new Map((request.baseline ?? []).map((entry) => [entry.externalId, entry]))
  const results: SyncResult[] = []

  for (const entry of targets) {
    try {
      const patchResult = await clientB.patchEntry(toToken, entry.externalId, entry, { sourceToken: fromToken })
      const baseline = baselineMap.get(entry.externalId)
      results.push({
        externalId: entry.externalId,
        title: entry.title,
        status: 'ok',
        collectionStatus: { before: statusLabel(baseline?.status), after: statusLabel(entry.status) },
        scoreChange: { before: typeof baseline?.score === 'number' ? baseline.score : null, after: entry.score || null },
        episodeChanged: patchResult.episodeChanged,
        episodeProgress: patchResult.episodeProgress,
      })
    } catch (error) {
      const result: SyncResult = {
        externalId: entry.externalId,
        title: entry.title,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      }
      if (isEpisodePatchPartialError(error)) {
        result.code = error.code
        result.succeeded = error.succeeded
        result.failedBatch = error.failedBatch
      }
      results.push(result)
    }
  }

  return results
}

function isEpisodePatchPartialError(error: unknown): error is {
  code: 'EPISODE_PATCH_PARTIAL'
  succeeded: number
  failedBatch: { index: number; episodeIds: number[] }
} {
  if (!(error instanceof Error)) return false
  const candidate = error as unknown as Record<string, unknown>
  const failedBatch = candidate.failedBatch
  return candidate.code === 'EPISODE_PATCH_PARTIAL'
    && Number.isSafeInteger(candidate.succeeded)
    && (candidate.succeeded as number) >= 0
    && !!failedBatch
    && typeof failedBatch === 'object'
    && Number.isSafeInteger((failedBatch as Record<string, unknown>).index)
    && ((failedBatch as Record<string, unknown>).index as number) >= 0
    && Array.isArray((failedBatch as Record<string, unknown>).episodeIds)
    && ((failedBatch as Record<string, unknown>).episodeIds as unknown[])
      .every((id) => Number.isSafeInteger(id) && (id as number) > 0)
}

function validateSyncRequest(request: SyncRequest): void {
  if (request.mode !== 'full' && request.mode !== 'partial') throw new SyncValidationError('Invalid sync mode')
  if (!request.from?.trim() || !request.to?.trim()) throw new SyncValidationError('Missing source/target user')
  if (request.items !== undefined) {
    if (!Array.isArray(request.items) || request.items.length === 0) throw new SyncValidationError('Sync requires at least one item')
    if (request.items.length > 5) throw new SyncValidationError('Sync accepts at most 5 items')
    if (!request.items.every(isComparisonItem)) throw new SyncValidationError('Invalid sync item')
  }
  if (request.subject_ids !== undefined) {
    if (!Array.isArray(request.subject_ids) || request.subject_ids.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new SyncValidationError('Invalid subject_ids')
    }
    if (request.subject_ids.length > 5) throw new SyncValidationError('Sync accepts at most 5 subject_ids')
  }
  if (request.mode === 'partial' && !request.items?.length && !request.subject_ids?.length) {
    throw new SyncValidationError('Partial sync requires items or subject_ids')
  }
}

function isComparisonItem(value: unknown): value is ComparisonItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.externalId === 'string'
    && item.externalId.trim().length > 0
    && typeof item.title === 'string'
    && Object.values(WatchStatus).includes(item.status as WatchStatus)
    && typeof item.progress === 'number'
    && Number.isFinite(item.progress)
    && item.progress >= 0
    && typeof item.totalEpisodes === 'number'
    && Number.isFinite(item.totalEpisodes)
    && item.totalEpisodes >= 0
    && typeof item.score === 'number'
    && Number.isFinite(item.score)
    && item.score >= 0
    && item.score <= 10
    && item.platform === 'bgm'
}
