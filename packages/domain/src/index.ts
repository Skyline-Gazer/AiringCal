export const packageBoundary = '@airing-cal/domain'

export {
  buildPublicSnapshot,
  canonicalSnapshotBytes,
  parsePublicSnapshotV1,
  snapshotObjectKey,
} from './public-snapshot.ts'
export type { PublicSnapshotInput } from './public-snapshot.ts'
export {
  buildManifest,
  parsePublicSnapshotManifestV1,
  snapshotKey,
} from './public-manifest.ts'
export type {
  PublicSnapshotManifestMetadata,
  PublicSnapshotManifestV1,
} from './public-manifest.ts'
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
    const selected = new Set(request.subject_ids)
    targets = sourceCollections.filter((item) => selected.has(item.externalId))
  }
  if (targets.length > 5 || new Set(targets.map((item) => item.externalId)).size !== targets.length) throw new SyncValidationError('Invalid sync batch')
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

export function validateSyncRequest(request: SyncRequest): void {
  if (request.mode !== 'full' && request.mode !== 'partial') throw new SyncValidationError('Invalid sync mode')
  if (typeof request.from !== 'string' || !request.from.trim() || typeof request.to !== 'string' || !request.to.trim()) throw new SyncValidationError('Missing source/target user')
  if (request.items !== undefined) {
    if (!Array.isArray(request.items) || request.items.length === 0) throw new SyncValidationError('Sync requires at least one item')
    if (request.items.length > 5) throw new SyncValidationError('Sync accepts at most 5 items')
    if (new Set(request.items.map((item) => item?.externalId)).size !== request.items.length) throw new SyncValidationError('Duplicate sync item')
    if (!request.items.every(isComparisonItem)) throw new SyncValidationError('Invalid sync item')
  }
  if (request.subject_ids !== undefined) {
    if (!Array.isArray(request.subject_ids) || request.subject_ids.some((id) => typeof id !== 'string' || !/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
      throw new SyncValidationError('Invalid subject_ids')
    }
    if (new Set(request.subject_ids).size !== request.subject_ids.length) throw new SyncValidationError('Duplicate subject_ids')
    if (request.subject_ids.length > 5) throw new SyncValidationError('Sync accepts at most 5 subject_ids')
  }
  if (request.baseline !== undefined && (!Array.isArray(request.baseline) || request.baseline.length > 5
    || request.baseline.some(entry => !entry || typeof entry !== 'object' || typeof entry.externalId !== 'string'
      || !/^[1-9][0-9]*$/.test(entry.externalId) || (entry.status != null && (typeof entry.status !== 'string' || entry.status.length > 80))
      || (['progress', 'totalEpisodes', 'score'] as const).some(key => entry[key] != null
        && (typeof entry[key] !== 'number' || !Number.isFinite(entry[key]) || entry[key]! < 0 || (key === 'score' && entry[key]! > 10)))))) throw new SyncValidationError('Invalid baseline')
  if (!request.items?.length && !request.subject_ids?.length) {
    throw new SyncValidationError('Sync requires items or subject_ids')
  }
}

function isComparisonItem(value: unknown): value is ComparisonItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.externalId === 'string'
    && /^[1-9][0-9]*$/.test(item.externalId)
    && Number.isSafeInteger(Number(item.externalId))
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
