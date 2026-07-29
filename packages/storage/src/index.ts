export const packageBoundary = '@airing-cal/storage'

export {
  canonicalJson,
  canonicalize,
  collectionContentHash,
  persistedCollectionSubject,
  sha256Canonical,
} from './canonical-json.ts'
export { D1StateStore, StaleCollectionDiffError } from './d1-state-store.ts'
export {
  claimDailyBudgetReservation,
  markBudgetSubmission,
  reserveDailyBudget,
  transitionBudgetSubmission,
} from './d1-budget.ts'
export type {
  BudgetReservationClaim,
  BudgetReservationRequest,
  BudgetReservationResult,
  BudgetSubmissionTransition,
} from './d1-budget.ts'
export type {
  CollectionContentInput,
  PersistedCollectionSubject,
  SubjectBusinessProjection,
} from './canonical-json.ts'

export type {
  AppStateRow,
  BudgetSubmissionStatus,
  CollectionDiffPlanLike,
  CollectionRow,
  D1DatabaseLike,
  D1MetaLike,
  D1PreparedStatementLike,
  D1ResultLike,
  PublicCalendarDayV1,
  PublicCalendarSubjectV1,
  PublicCollectionItemV1,
  PublicImageRefV1,
  PublicationPendingCleanupResult,
  PublicationSourceWatermarkV1,
  PublicSnapshotPointerV1,
  PublicationWriteOwner,
  PublicSnapshotSummaryV1,
  PublicSnapshotV1,
  PublicSubjectImagesV1,
  SubjectMediaRow,
  SyncBudgetReservationRow,
  SyncBudgetResource,
  SyncBudgetRow,
  SyncRunRow,
  SyncRunCompletion,
  SyncRunFailure,
  SyncTerminalTransitionResult,
  SyncRunUpdate,
  Temperature,
} from './d1-types.ts'

export type CollectionType = 'want' | 'watched' | 'watching' | 'on_hold' | 'dropped'
export type ImageSourceSize = 'common' | 'large'
export const SUBJECT_DETAIL_TTL_SECONDS = 60 * 60 * 24 * 7
export const SYNC_RUN_TTL_SECONDS = 60 * 60 * 24 * 3
export const SYNC_STAGING_TTL_SECONDS = 60 * 60 * 24

export interface SyncWorkflowParams {
  mode?: 'shadow' | 'live'
  source?: 'manual' | 'schedule'
}

export interface SyncRun {
  instance_id: string
  generation?: number
  mode: 'shadow' | 'live'
  source: 'schedule' | 'manual'
  status: 'queued' | 'running' | 'retrying' | 'ok' | 'error'
  stage: 'initialize' | 'collections' | 'calendar' | 'snapshots' | 'refresh_plan' | 'enqueue' | 'complete'
  started_at: number
  heartbeat_at: number
  completed_at: number | null
  collection_pages: number
  subject_count: number
  refresh_jobs: number
  refresh_candidates: number
  refresh_candidates_by_priority: {
    new_or_changed: number
    hot: number
    cold: number
    retry: number
  }
  refresh_selected: number
  refresh_granted: number
  refresh_deferred: number
  refresh_confirmed: number
  refresh_uncertain: number
  refresh_skipped: number
  error: string | null
}

export interface SnapshotManifest {
  instance_id: string
  generation: number
  mode: 'live'
  published_at: number
  subject_count: number
  required_keys: string[]
  digests: Record<string, string>
}

export type SubjectRefreshStatus = 'queued' | 'running' | 'ok' | 'partial' | 'failed'

export interface SubjectRefreshState {
  subject_id: number
  job_id: string
  generation?: number
  status: SubjectRefreshStatus
  queued_at: number
  updated_at: number
  completed_at: number | null
  error: string | null
}

export type MediaRefreshComponent = 'detail' | 'meta' | 'image_common' | 'image_large'

export interface MediaRefreshJobV2 {
  version: 2
  job_id: string
  subject_id: number
  title: string
  components: MediaRefreshComponent[]
  images?: {
    common?: string
    large?: string
  }
}

export interface MediaRefreshJobV3 extends Omit<MediaRefreshJobV2, 'version'> {
  version: 3
  generation: number
}

export interface MediaRefreshJobV4 extends Omit<MediaRefreshJobV3, 'version'> {
  version: 4
}

const MEDIA_REFRESH_COMPONENTS = new Set<MediaRefreshComponent>([
  'detail',
  'meta',
  'image_common',
  'image_large',
])

function isMediaRefreshJobBase(value: unknown): value is Omit<MediaRefreshJobV2, 'version'> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const job = value as Record<string, unknown>
  if (
    typeof job.job_id !== 'string'
    || job.job_id.length === 0
    || typeof job.subject_id !== 'number'
    || !Number.isSafeInteger(job.subject_id)
    || job.subject_id <= 0
    || typeof job.title !== 'string'
    || !Array.isArray(job.components)
    || !job.components.every((component) => MEDIA_REFRESH_COMPONENTS.has(component as MediaRefreshComponent))
  ) return false
  if (job.images === undefined) return true
  if (typeof job.images !== 'object' || job.images === null || Array.isArray(job.images)) return false
  const images = job.images as Record<string, unknown>
  return (images.common === undefined || typeof images.common === 'string')
    && (images.large === undefined || typeof images.large === 'string')
}

function hasValidMediaGeneration(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const generation = (value as { generation?: unknown }).generation
  return typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0
}

export function isMediaRefreshJobV2(value: unknown): value is MediaRefreshJobV2 {
  return isMediaRefreshJobBase(value)
    && (value as { version?: unknown }).version === 2
}

export function isMediaRefreshJobV3(value: unknown): value is MediaRefreshJobV3 {
  return isMediaRefreshJobBase(value)
    && (value as { version?: unknown }).version === 3
    && hasValidMediaGeneration(value)
}

export function isMediaRefreshJobV4(value: unknown): value is MediaRefreshJobV4 {
  return isMediaRefreshJobBase(value)
    && (value as { version?: unknown }).version === 4
    && hasValidMediaGeneration(value)
}

export function hasUnsupportedMediaJobVersion(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && 'version' in value
    && !isMediaRefreshJobV2(value)
    && !isMediaRefreshJobV3(value)
    && !isMediaRefreshJobV4(value)
}

export interface StorageAdapter {
  get<T>(key: string, validate?: (value: unknown) => value is T): Promise<T | null>
  put<T>(key: string, value: T, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

export interface SubjectDetailCacheEntry<T = any> {
  cached_at: number
  subject: T
}

export interface SubjectDetailClient<T = any> {
  getSubject(subjectId: number): Promise<T | null>
}

export interface StoredImage {
  data: ArrayBuffer
  contentType: string
  bytes?: number
  sourceUrl?: string
  subjectId?: number
  sourceSize?: ImageSourceSize
  cachedAt?: number
}

export interface PutOriginalImageMetadata {
  sourceUrl: string
  subjectId: number
  sourceSize: ImageSourceSize
  cachedAt: number
}

interface R2ObjectBodyLike {
  arrayBuffer(): Promise<ArrayBuffer>
  httpMetadata?: { contentType?: string }
  customMetadata?: Record<string, string>
}

interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>
  put(
    key: string,
    value: ArrayBuffer,
    options: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>
}

export function snapshotCollectionsKey(type: CollectionType): string {
  return `snapshot:collections:${type}`
}

export function snapshotCalendarKey(): string {
  return 'snapshot:calendar'
}

export function snapshotSummaryKey(): string {
  return 'snapshot:summary'
}

export function snapshotActiveKey(): string {
  return 'snapshot:active'
}

export function snapshotVersionKey(instanceId: string, suffix: string): string {
  return `snapshot:version:${instanceId}:${suffix}`
}

export function syncMetaKey(): string {
  return 'sync:meta'
}

export function syncCurrentKey(): string {
  return 'sync:current'
}

export function subjectMetaKey(subjectId: number): string {
  return `subject:meta:${subjectId}`
}

export function subjectDetailKey(subjectId: number): string {
  return `subject:detail:${subjectId}`
}

export function imageStatusKey(subjectId: number): string {
  return `image:status:${subjectId}`
}

export function subjectRefreshKey(subjectId: number): string {
  return `subject:refresh:${subjectId}`
}

export function syncRunKey(instanceId: string): string {
  return `sync:run:${instanceId}`
}

export function syncStagingKey(instanceId: string, suffix: string): string {
  return `sync:staging:${instanceId}:${suffix}`
}

export function syncShadowKey(instanceId: string, suffix: string): string {
  return `snapshot:shadow:${instanceId}:${suffix}`
}

export function imageIndexKey(hash: string): string {
  return `image:index:${hash}`
}

export function imageOriginalKey(hash: string): string {
  return `images/${hash}/original`
}

export class KVStorage implements StorageAdapter {
  constructor(private kv: { get(key: string, type: 'json'): Promise<unknown>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>; delete(key: string): Promise<void> }) {}

  async get<T>(key: string, validate?: (value: unknown) => value is T): Promise<T | null> {
    const raw = await this.kv.get(key, 'json')
    if (raw === null || raw === undefined) return null
    if (validate) return validate(raw) ? raw : null
    return raw as T
  }

  async put<T>(key: string, value: T, options?: { expirationTtl?: number }): Promise<void> {
    await this.kv.put(key, JSON.stringify(value), options)
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key)
  }
}

function stableJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate
    return Object.fromEntries(Object.keys(candidate).sort().map((key) => [key, candidate[key]]))
  })
}

export async function putJsonIfChanged<T>(
  storage: StorageAdapter,
  key: string,
  next: T,
  normalize: (value: T) => unknown,
): Promise<boolean> {
  const previous = await storage.get<T>(key)
  if (previous !== null && stableJson(normalize(previous)) === stableJson(normalize(next))) return false
  await storage.put(key, next)
  return true
}

export function nextSubjectRefreshAt(subjectId: number, cachedAt: number): number {
  const sixDays = 6 * 24 * 60 * 60
  const twoDays = 2 * 24 * 60 * 60
  const spread = Math.abs(Math.trunc(subjectId) * 997) % (twoDays + 1)
  return cachedAt + sixDays + spread
}

function freshSubjectDetail<T>(entry: SubjectDetailCacheEntry<T> | null, now: number, ttlSeconds: number): T | null {
  if (!entry || !entry.subject || typeof entry.cached_at !== 'number') return null
  return now - entry.cached_at <= ttlSeconds ? entry.subject : null
}

export async function getCachedSubjectDetail<T = any>(
  storage: StorageAdapter,
  client: SubjectDetailClient<T>,
  subjectId: number,
  now: number,
  ttlSeconds = SUBJECT_DETAIL_TTL_SECONDS,
): Promise<T | null> {
  const cached = await storage.get<SubjectDetailCacheEntry<T>>(subjectDetailKey(subjectId))
  const fresh = freshSubjectDetail(cached, now, ttlSeconds)
  if (fresh) return fresh

  try {
    const subject = await client.getSubject(subjectId)
    if (!subject) return null
    await putJsonIfChanged(storage, subjectDetailKey(subjectId), { cached_at: now, subject }, (value) => value.subject)
    return subject
  } catch (error) {
    if (cached?.subject) return cached.subject
    throw error
  }
}

export class R2ImageStore {
  constructor(private r2: R2BucketLike) {}

  async getOriginal(hash: string): Promise<StoredImage | null> {
    const object = await this.r2.get(imageOriginalKey(hash))
    if (!object) return null
    const metadata = object.customMetadata ?? {}
    return {
      data: await object.arrayBuffer(),
      contentType: object.httpMetadata?.contentType || 'image/jpeg',
      bytes: metadata.bytes ? Number(metadata.bytes) : undefined,
      sourceUrl: metadata.source_url,
      subjectId: metadata.subject_id ? Number(metadata.subject_id) : undefined,
      sourceSize: metadata.source_size === 'common' || metadata.source_size === 'large' ? metadata.source_size : undefined,
      cachedAt: metadata.cached_at ? Number(metadata.cached_at) : undefined,
    }
  }

  async putOriginal(hash: string, data: ArrayBuffer, contentType: string, metadata: PutOriginalImageMetadata): Promise<void> {
    await this.r2.put(imageOriginalKey(hash), data, {
      httpMetadata: { contentType },
      customMetadata: {
        bytes: String(data.byteLength),
        source_url: metadata.sourceUrl,
        subject_id: String(metadata.subjectId),
        source_size: metadata.sourceSize,
        cached_at: String(metadata.cachedAt),
      },
    })
  }
}
