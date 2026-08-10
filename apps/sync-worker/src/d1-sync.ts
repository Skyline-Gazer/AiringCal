import {
  normalizeCollection,
  parsePublicSnapshotV1,
  planCollectionDiff,
  buildPublicSnapshot,
  transformCalendar,
  type CollectionDiffPlan,
  type PublicSnapshotInput,
} from '@airing-cal/domain'
import {
  canonicalJson,
  D1StateStore,
  isMediaRefreshJobV4,
  sha256Canonical,
  StaleCollectionDiffError,
  SyncRunCheckpointConflictError,
  type BudgetReservationRequest,
  type BudgetReservationResult,
  type CollectionRow,
  type D1DatabaseLike,
  type MediaRefreshJobV4,
  type PublicCollectionItemV1,
  type PublicImageRefV1,
  type SyncRunCompletion,
  type SyncRunCheckpointGuard,
  type SyncRunFailure,
  type SyncRunRow,
  type SyncRunUpdate,
  type SyncTerminalTransitionResult,
  type SubjectMediaRow,
} from '@airing-cal/storage'
import type { CompleteFullFetch } from './full-fetch-boundary.ts'
import {
  cleanupReplayArtifactIfUnreferenced,
  loadReplayArtifact,
  persistReplayArtifact,
  type LoadedReplayArtifact,
} from './replay-artifact.ts'
import {
  selectRefreshCandidates,
  type ColdRefreshCursor,
  type RefreshCandidate,
  type RefreshPriority,
} from './refresh-planner.ts'

const MEDIA_SOFT_LIMIT = 50
const MEDIA_HARD_LIMIT = 100
const MAX_STALE_REPLANS = 1
const MAX_RESPONSE_LOSS_RECONCILIATIONS = 1

export interface D1IncrementalSyncEnv {
  AIRING_CAL_D1?: D1DatabaseLike
}

export interface D1IncrementalSyncStore {
  listCollectionRows(): Promise<CollectionRow[]>
  listSubjectMediaRows(): Promise<SubjectMediaRow[]>
  getAppState<T>(key: string, decode: (value: unknown) => T): Promise<T | undefined>
  putAppState<T>(key: string, value: T): Promise<void>
  putAppStateIfNewer<T>(key: string, value: T, version: number): Promise<boolean>
  deleteAppStateKeys(keys: string[]): Promise<void>
  getSyncRun(instanceId: string): Promise<SyncRunRow | undefined>
  applyCollectionDiff(
    plan: CollectionDiffPlan,
    checkpoint?: {
      instanceId: string
      update: SyncRunUpdate
      guard?: SyncRunCheckpointGuard
    },
  ): Promise<{ rowsWritten: number }>
  startSyncRun(row: SyncRunRow): Promise<void>
  updateSyncRun(
    instanceId: string,
    update: SyncRunUpdate,
    guard?: SyncRunCheckpointGuard,
  ): Promise<void>
  completeSyncRun(
    instanceId: string,
    completion: SyncRunCompletion,
    guard?: SyncRunCheckpointGuard,
  ): Promise<SyncTerminalTransitionResult>
  failSyncRun(
    instanceId: string,
    failure: SyncRunFailure,
    guard?: SyncRunCheckpointGuard,
  ): Promise<SyncTerminalTransitionResult>
}

export interface D1PublicationInput extends PublicSnapshotInput {
  content_hash: string
}

export interface D1SyncResult {
  rowsWritten: number
  firstMissing: number
  deleted: number
  restored: number
  publicationInput: D1PublicationInput
  media: {
    candidates: number
    granted: number
    confirmed: number
    uncertain: number
    deferred: number
  }
  runId: string
}

export interface D1IncrementalSyncArguments {
  env: D1IncrementalSyncEnv
  instanceId: string
  completeInput: CompleteFullFetch
  now: number
  store?: D1IncrementalSyncStore
  submitMedia?: (request: BudgetReservationRequest<MediaRefreshJobV4>) => Promise<BudgetReservationResult>
}

interface PreparedResultEnvelope {
  schema_version: 1
  input_hash: string
  result: D1SyncResult
  cold_cursor?: ColdRefreshCursor
  cold_cursor_version?: number
}

interface CollectionCheckpoint {
  plan: CollectionDiffPlan
  rowsWritten: number
  firstMissing: number
  deleted: number
  restored: number
  publicationInput: D1PublicationInput
}

interface CollectionCheckpointEnvelope {
  schema_version: 1
  input_hash: string
  checkpoint_hash: string
  collection: CollectionCheckpoint
}

interface MediaPendingCheckpoint {
  collection: CollectionCheckpoint
  request: BudgetReservationRequest<MediaRefreshJobV4>
  candidates: number
  selected_priorities: RefreshPriority[]
  cold_cursor: ColdRefreshCursor
  cold_cursor_version: number
}

interface MediaPendingCheckpointEnvelope {
  schema_version: 1
  input_hash: string
  checkpoint_hash: string
  media_pending: MediaPendingCheckpoint
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid prepared D1 sync result: ${field}`)
  }
  return value
}

function requireCollectionRow(value: unknown, field: string): CollectionRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid D1 sync collection checkpoint: ${field}`)
  }
  const row = value as Partial<CollectionRow>
  const nullableInteger = (candidate: unknown) =>
    candidate === null || (typeof candidate === 'number' && Number.isSafeInteger(candidate))
  if (
    typeof row.user_id !== 'string'
    || typeof row.subject_id !== 'number'
    || !Number.isSafeInteger(row.subject_id)
    || typeof row.collection_type !== 'number'
    || !Number.isSafeInteger(row.collection_type)
    || !nullableInteger(row.rate)
    || typeof row.tags_json !== 'string'
    || typeof row.comment !== 'string'
    || typeof row.ep_status !== 'number'
    || !Number.isSafeInteger(row.ep_status)
    || typeof row.vol_status !== 'number'
    || !Number.isSafeInteger(row.vol_status)
    || (row.upstream_updated_at !== null && typeof row.upstream_updated_at !== 'string')
    || typeof row.subject_json !== 'string'
    || typeof row.content_hash !== 'string'
    || typeof row.state_version !== 'number'
    || !Number.isSafeInteger(row.state_version)
    || row.state_version < 1
    || (row.temperature !== 'hot' && row.temperature !== 'cold')
    || typeof row.first_seen_at !== 'number'
    || !Number.isSafeInteger(row.first_seen_at)
    || typeof row.changed_at !== 'number'
    || !Number.isSafeInteger(row.changed_at)
    || !nullableInteger(row.missing_since)
    || !nullableInteger(row.deleted_at)
  ) {
    throw new Error(`Invalid D1 sync collection checkpoint: ${field}`)
  }
  return row as CollectionRow
}

function requireCollectionPlan(value: unknown): CollectionDiffPlan {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid D1 sync collection checkpoint plan')
  }
  const raw = value as Partial<CollectionDiffPlan>
  const rowFields = ['inserts', 'updates', 'firstMissing', 'confirmedDeleted', 'restored'] as const
  for (const field of rowFields) {
    if (!Array.isArray(raw[field])) {
      throw new Error(`Invalid D1 sync collection checkpoint plan: ${field}`)
    }
  }
  const inserts = raw.inserts as unknown[]
  const updates = raw.updates as unknown[]
  const firstMissing = raw.firstMissing as unknown[]
  const confirmedDeleted = raw.confirmedDeleted as unknown[]
  const restored = raw.restored as unknown[]
  return {
    inserts: inserts.map((row, index) => requireCollectionRow(row, `inserts[${index}]`)),
    updates: updates.map((row, index) => requireCollectionRow(row, `updates[${index}]`)),
    unchanged: requireNonNegativeInteger(raw.unchanged, 'collection.plan.unchanged'),
    firstMissing: firstMissing.map((row, index) => requireCollectionRow(row, `firstMissing[${index}]`)),
    confirmedDeleted: confirmedDeleted.map((row, index) =>
      requireCollectionRow(row, `confirmedDeleted[${index}]`)),
    restored: restored.map((row, index) => requireCollectionRow(row, `restored[${index}]`)),
  }
}

async function decodePublicationInput(value: unknown): Promise<D1PublicationInput> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid prepared D1 sync publication')
  }
  const publication = value as Partial<D1PublicationInput>
  if (
    !Array.isArray(publication.collections)
    || !Array.isArray(publication.calendar)
    || typeof publication.content_hash !== 'string'
    || !Number.isSafeInteger(publication.published_at)
  ) {
    throw new Error('Invalid prepared D1 sync publication')
  }
  const publishedAt = publication.published_at as number
  let rebuilt
  try {
    rebuilt = await buildPublicSnapshot({
      collections: publication.collections,
      calendar: publication.calendar,
      published_at: publishedAt,
    }, 0)
    await parsePublicSnapshotV1(rebuilt)
  } catch {
    throw new Error('Invalid prepared D1 sync publication')
  }
  if (rebuilt.content_hash !== publication.content_hash) {
    throw new Error('Invalid prepared D1 sync publication content_hash')
  }
  return {
    collections: publication.collections,
    calendar: publication.calendar,
    published_at: publishedAt,
    content_hash: rebuilt.content_hash,
  }
}

async function decodeCollectionCheckpoint(
  resultJson: string | null,
  expectedInputHash: string,
): Promise<CollectionCheckpoint | undefined> {
  if (resultJson === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(resultJson)
  } catch {
    throw new Error('Invalid D1 sync checkpoint JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid D1 sync checkpoint')
  }
  if (!Object.hasOwn(parsed, 'collection')) return undefined
  const envelope = parsed as Partial<CollectionCheckpointEnvelope>
  if (envelope.schema_version !== 1 || envelope.input_hash !== expectedInputHash) {
    throw new Error('D1 sync instance input mismatch')
  }
  if (
    typeof envelope.checkpoint_hash !== 'string'
    || !/^[0-9a-f]{64}$/.test(envelope.checkpoint_hash)
    || typeof envelope.collection !== 'object'
    || envelope.collection === null
    || Array.isArray(envelope.collection)
  ) {
    throw new Error('Invalid D1 sync collection checkpoint')
  }
  if (await sha256Canonical(envelope.collection) !== envelope.checkpoint_hash) {
    throw new Error('Invalid D1 sync collection checkpoint hash')
  }
  const raw = envelope.collection
  return {
    plan: requireCollectionPlan(raw.plan),
    rowsWritten: requireNonNegativeInteger(raw.rowsWritten, 'collection.rowsWritten'),
    firstMissing: requireNonNegativeInteger(raw.firstMissing, 'collection.firstMissing'),
    deleted: requireNonNegativeInteger(raw.deleted, 'collection.deleted'),
    restored: requireNonNegativeInteger(raw.restored, 'collection.restored'),
    publicationInput: await decodePublicationInput(raw.publicationInput),
  }
}

function requireMediaRequest(
  value: unknown,
  expectedInstanceId: string,
): BudgetReservationRequest<MediaRefreshJobV4> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid D1 sync media checkpoint request')
  }
  const raw = value as Partial<BudgetReservationRequest<unknown>>
  if (
    typeof raw.date !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)
    || raw.resource !== 'media'
    || raw.reservationId !== `${expectedInstanceId}:media`
    || !Array.isArray(raw.jobs)
    || !raw.jobs.every(isMediaRefreshJobV4)
    || raw.jobs.some((job) => job.generation.run_id !== expectedInstanceId)
    || !Number.isSafeInteger(raw.privilegedCount)
    || (raw.privilegedCount as number) < 0
    || (raw.privilegedCount as number) > raw.jobs.length
    || raw.softLimit !== MEDIA_SOFT_LIMIT
    || raw.hardLimit !== MEDIA_HARD_LIMIT
  ) {
    throw new Error('Invalid D1 sync media checkpoint request')
  }
  return raw as BudgetReservationRequest<MediaRefreshJobV4>
}

async function decodeMediaPendingCheckpoint(
  resultJson: string | null,
  expectedInputHash: string,
  expectedInstanceId: string,
): Promise<MediaPendingCheckpoint | undefined> {
  if (resultJson === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(resultJson)
  } catch {
    throw new Error('Invalid D1 sync media checkpoint JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid D1 sync media checkpoint')
  }
  if (!Object.hasOwn(parsed, 'media_pending')) return undefined
  const envelope = parsed as Partial<MediaPendingCheckpointEnvelope>
  if (envelope.schema_version !== 1 || envelope.input_hash !== expectedInputHash) {
    throw new Error('D1 sync instance input mismatch')
  }
  if (
    typeof envelope.checkpoint_hash !== 'string'
    || !/^[0-9a-f]{64}$/.test(envelope.checkpoint_hash)
    || typeof envelope.media_pending !== 'object'
    || envelope.media_pending === null
    || Array.isArray(envelope.media_pending)
    || await sha256Canonical(envelope.media_pending) !== envelope.checkpoint_hash
  ) {
    throw new Error('Invalid D1 sync media checkpoint')
  }
  const raw = envelope.media_pending
  const request = requireMediaRequest(raw.request, expectedInstanceId)
  const priorities = raw.selected_priorities
  const allowedPriorities = new Set<RefreshPriority>(['new_or_changed', 'hot', 'cold', 'retry'])
  if (
    !Array.isArray(priorities)
    || priorities.length !== request.jobs.length
    || !priorities.every((priority) => allowedPriorities.has(priority))
    || request.privilegedCount !== priorities.filter(
      (priority) => priority === 'new_or_changed',
    ).length
  ) {
    throw new Error('Invalid D1 sync media checkpoint priorities')
  }
  const candidates = requireNonNegativeInteger(raw.candidates, 'media_pending.candidates')
  if (candidates < request.jobs.length) {
    throw new Error('Invalid D1 sync media checkpoint candidates')
  }
  return {
    collection: {
      plan: requireCollectionPlan(raw.collection?.plan),
      rowsWritten: requireNonNegativeInteger(raw.collection?.rowsWritten, 'media_pending.collection.rowsWritten'),
      firstMissing: requireNonNegativeInteger(raw.collection?.firstMissing, 'media_pending.collection.firstMissing'),
      deleted: requireNonNegativeInteger(raw.collection?.deleted, 'media_pending.collection.deleted'),
      restored: requireNonNegativeInteger(raw.collection?.restored, 'media_pending.collection.restored'),
      publicationInput: await decodePublicationInput(raw.collection?.publicationInput),
    },
    request,
    candidates,
    selected_priorities: priorities as RefreshPriority[],
    cold_cursor: decodeColdCursor(raw.cold_cursor),
    cold_cursor_version: requireNonNegativeInteger(
      raw.cold_cursor_version,
      'media_pending.cold_cursor_version',
    ),
  }
}

async function decodePreparedResult(
  resultJson: string | null,
  expectedInputHash: string,
  expectedInstanceId: string,
): Promise<D1SyncResult | undefined> {
  if (resultJson === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(resultJson)
  } catch {
    throw new Error('Invalid prepared D1 sync result JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid prepared D1 sync result')
  }
  const envelope = parsed as Partial<PreparedResultEnvelope>
  if (envelope.schema_version !== 1 || envelope.input_hash !== expectedInputHash) {
    throw new Error('D1 sync instance input mismatch')
  }
  const raw = envelope.result
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Invalid prepared D1 sync result')
  }
  const media = raw.media
  if (
    raw.runId !== expectedInstanceId
    || typeof media !== 'object'
    || media === null
    || Array.isArray(media)
  ) {
    throw new Error('Invalid prepared D1 sync result')
  }
  return {
    rowsWritten: requireNonNegativeInteger(raw.rowsWritten, 'rowsWritten'),
    firstMissing: requireNonNegativeInteger(raw.firstMissing, 'firstMissing'),
    deleted: requireNonNegativeInteger(raw.deleted, 'deleted'),
    restored: requireNonNegativeInteger(raw.restored, 'restored'),
    publicationInput: await decodePublicationInput(raw.publicationInput),
    media: {
      candidates: requireNonNegativeInteger(media.candidates, 'media.candidates'),
      granted: requireNonNegativeInteger(media.granted, 'media.granted'),
      confirmed: requireNonNegativeInteger(media.confirmed, 'media.confirmed'),
      uncertain: requireNonNegativeInteger(media.uncertain, 'media.uncertain'),
      deferred: requireNonNegativeInteger(media.deferred, 'media.deferred'),
    },
    runId: raw.runId,
  }
}

interface PreparedColdCursorTransition {
  cursor: ColdRefreshCursor
  version: number
}

function decodePreparedColdCursor(
  resultJson: string | null,
  expectedInputHash: string,
): PreparedColdCursorTransition | undefined {
  if (resultJson === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(resultJson)
  } catch {
    throw new Error('Invalid prepared D1 sync result JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid prepared D1 sync result')
  }
  const envelope = parsed as Partial<PreparedResultEnvelope>
  if (envelope.schema_version !== 1 || envelope.input_hash !== expectedInputHash) {
    throw new Error('D1 sync instance input mismatch')
  }
  if (envelope.cold_cursor === undefined) {
    if (envelope.cold_cursor_version !== undefined) {
      throw new Error('Invalid prepared D1 sync result: cold_cursor_version')
    }
    return undefined
  }
  return {
    cursor: decodeColdCursor(envelope.cold_cursor),
    version: envelope.cold_cursor_version === undefined
      ? 0
      : requireNonNegativeInteger(envelope.cold_cursor_version, 'cold_cursor_version'),
  }
}

async function hasValidDifferentWinner(
  store: D1IncrementalSyncStore,
  instanceId: string,
  inputHash: string,
  expected: SyncRunCheckpointGuard,
): Promise<boolean> {
  const persisted = await store.getSyncRun(instanceId)
  if (
    persisted === undefined
    || persisted.input_hash !== inputHash
    || persisted.status === 'error'
    || (
      persisted.status === 'running'
      && persisted.stage === expected.stage
      && persisted.result_json === expected.result_json
    )
    || persisted.result_json === null
  ) return false
  let artifact: LoadedReplayArtifact | undefined
  try {
    artifact = await loadReplayArtifact(
      store,
      persisted.result_json,
      inputHash,
      instanceId,
    )
  } catch {
    // A malformed winner artifact cannot prove a different valid checkpoint;
    // preserve the originating completion/failure error instead.
    return false
  }
  if (persisted.status === 'ok') {
    return artifact?.kind === 'prepared'
      && await decodePreparedResult(artifact.artifactJson, inputHash, instanceId) !== undefined
  }
  if (persisted.status !== 'running') return false
  if (persisted.stage === 'collections_pending' && artifact?.kind === 'collection') {
    return await decodeCollectionCheckpoint(artifact.artifactJson, inputHash) !== undefined
  }
  if (persisted.stage === 'media_pending' && artifact?.kind === 'media_pending') {
    return await decodeMediaPendingCheckpoint(
      artifact.artifactJson,
      inputHash,
      instanceId,
    ) !== undefined
  }
  if (persisted.stage === 'media' && artifact?.kind === 'prepared') {
    return await decodePreparedResult(artifact.artifactJson, inputHash, instanceId) !== undefined
  }
  return false
}

function changedRows(plan: CollectionDiffPlan): CollectionRow[] {
  return [...plan.inserts, ...plan.updates, ...plan.restored]
}

function plannedRowsWritten(plan: CollectionDiffPlan): number {
  return plan.inserts.length
    + plan.updates.length
    + plan.restored.length
    + plan.firstMissing.length
    + plan.confirmedDeleted.length
}

function classifyError(error: unknown): string {
  if (error instanceof StaleCollectionDiffError) return error.code
  if (error instanceof SyntaxError) return 'INVALID_JSON'
  return 'SYNC_FAILED'
}

function mediaJobs(instanceId: string, observedAt: number, candidates: RefreshCandidate[]): MediaRefreshJobV4[] {
  return candidates.map((candidate) => {
    return {
      version: 4,
      generation: {
        observed_at: observedAt,
        run_id: instanceId,
      },
      job_id: `${instanceId}:${candidate.subject_id}`,
      subject_id: candidate.subject_id,
      title: candidate.title,
      components: candidate.components,
      images: candidate.images,
    }
  })
}

function decodeColdCursor(value: unknown): ColdRefreshCursor {
  if (
    typeof value !== 'object'
    || value === null
    || !Array.isArray((value as { subject_ids?: unknown }).subject_ids)
    || !(value as { subject_ids: unknown[] }).subject_ids.every((id) => Number.isSafeInteger(id))
  ) throw new Error('Invalid media cold cursor')
  return { subject_ids: [...(value as { subject_ids: number[] }).subject_ids] }
}

function sameCursor(left: ColdRefreshCursor, right: ColdRefreshCursor): boolean {
  return left.subject_ids.length === right.subject_ids.length
    && left.subject_ids.every((subjectId, index) => right.subject_ids[index] === subjectId)
}

async function cleanupReplayArtifactBestEffort(
  store: D1IncrementalSyncStore,
  instanceId: string,
  artifact: LoadedReplayArtifact,
): Promise<void> {
  try {
    await cleanupReplayArtifactIfUnreferenced(store, instanceId, artifact)
  } catch {
    // Preserve the lifecycle failure; unadopted artifact cleanup is best effort.
  }
}

function mergePublicCollections(items: PublicCollectionItemV1[]): PublicCollectionItemV1[] {
  const bySubject = new Map<number, PublicCollectionItemV1>()
  for (const item of items) {
    const previous = bySubject.get(item.subject_id)
    if (!previous || Date.parse(item.updated_at) > Date.parse(previous.updated_at)) {
      bySubject.set(item.subject_id, item)
    }
  }
  return [...bySubject.values()]
}

function activeRowsAfterPlan(current: CollectionRow[], plan: CollectionDiffPlan): CollectionRow[] {
  const rows = new Map(current.map((row) => [`${row.user_id}\0${row.subject_id}`, row]))
  for (const row of [
    ...plan.inserts,
    ...plan.updates,
    ...plan.restored,
    ...plan.firstMissing,
    ...plan.confirmedDeleted,
  ]) {
    rows.set(`${row.user_id}\0${row.subject_id}`, row)
  }
  return [...rows.values()].filter(({ deleted_at }) => deleted_at === null)
}

interface ProjectedMedia {
  detail: {
    id: number
    name?: string
    name_cn?: string
    summary?: string
    date?: string
    eps?: number
    total_episodes?: number
  } | null
  images: {
    common: PublicImageRefV1 | null
    large: PublicImageRefV1 | null
  }
  nsfw: boolean
}

function publicImageRef(key: string | null): PublicImageRefV1 | null {
  if (key === null) return null
  const match = /^images\/([0-9a-f]{64})\/original$/.exec(key)
  if (!match?.[1]) return null
  return {
    hash: match[1],
    uri: `/image/${match[1]}`,
    r2_key: key,
  }
}

function projectedMedia(row: SubjectMediaRow | undefined, subjectId: number): ProjectedMedia | undefined {
  if (!row || row.checked_at === null) return undefined
  let detail: ProjectedMedia['detail'] = null
  if (row.detail_json !== null) {
    try {
      const parsed = JSON.parse(row.detail_json) as Record<string, unknown>
      if (
        typeof parsed === 'object'
        && parsed !== null
        && !Array.isArray(parsed)
        && parsed.id === subjectId
      ) {
        detail = {
          id: subjectId,
          ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
          ...(typeof parsed.name_cn === 'string' ? { name_cn: parsed.name_cn } : {}),
          ...(typeof parsed.summary === 'string' ? { summary: parsed.summary } : {}),
          ...(typeof parsed.date === 'string' ? { date: parsed.date } : {}),
          ...(typeof parsed.eps === 'number'
            && Number.isSafeInteger(parsed.eps)
            && parsed.eps >= 0 ? { eps: parsed.eps } : {}),
          ...(typeof parsed.total_episodes === 'number'
            && Number.isSafeInteger(parsed.total_episodes)
            && parsed.total_episodes >= 0 ? { total_episodes: parsed.total_episodes } : {}),
        }
      }
    } catch {
      // Invalid legacy/imported detail falls back to the complete upstream projection.
    }
  }
  return {
    detail,
    images: {
      common: publicImageRef(row.r2_image_common_key),
      large: publicImageRef(row.r2_image_large_key),
    },
    nsfw: row.nsfw === 1,
  }
}

function nonNegativeInteger(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function publicItemFromRow(
  row: CollectionRow,
  mediaBySubject: Map<number, SubjectMediaRow>,
): PublicCollectionItemV1 {
  const envelope = JSON.parse(row.subject_json) as {
    subject_type: number
    subject: {
      name?: string | null
      name_cn?: string | null
      summary?: string | null
      date?: string | null
      eps?: number | null
      total_episodes?: number | null
      nsfw?: boolean | null
    } | null
  }
  const subject = envelope.subject
  const media = projectedMedia(mediaBySubject.get(row.subject_id), row.subject_id)
  const detail = media?.detail
  const tags = JSON.parse(row.tags_json) as string[]
  return {
    subject_id: row.subject_id,
    name: detail?.name ?? subject?.name ?? '',
    name_cn: detail?.name_cn ?? subject?.name_cn ?? '',
    summary: detail?.summary ?? subject?.summary ?? '',
    images: media?.images ?? { common: null, large: null },
    eps: nonNegativeInteger(detail?.eps, subject?.eps ?? 0),
    total_episodes: nonNegativeInteger(detail?.total_episodes, subject?.total_episodes ?? 0),
    ep_status: row.ep_status,
    vol_status: row.vol_status,
    type: envelope.subject_type,
    collection_type: row.collection_type,
    rate: row.rate ?? 0,
    nsfw: media?.nsfw ?? subject?.nsfw ?? false,
    date: detail?.date ?? subject?.date ?? '',
    tags,
    updated_at: row.upstream_updated_at ?? '',
  }
}

function planMediaCandidates(
  completeInput: CompleteFullFetch,
  mediaRows: SubjectMediaRow[],
  plan: CollectionDiffPlan,
  now: number,
): RefreshCandidate[] {
  const mediaBySubject = new Map(mediaRows.map((row) => [row.subject_id, row]))
  const newlyVisible = new Set([...plan.inserts, ...plan.restored].map(({ subject_id }) => subject_id))
  const bySubject = new Map<number, {
    title: string
    hot: boolean
    images: { common?: string; large?: string }
  }>()
  for (const { collection } of completeInput.collections) {
    const subject = collection.subject
    const current = bySubject.get(collection.subject_id)
    const common = subject?.images?.common
    const large = subject?.images?.large
    bySubject.set(collection.subject_id, {
      title: subject?.name_cn || subject?.name || current?.title || String(collection.subject_id),
      hot: current?.hot === true || collection.type !== 2,
      images: {
        ...(common ? { common } : current?.images.common ? { common: current.images.common } : {}),
        ...(large ? { large } : current?.images.large ? { large: current.images.large } : {}),
      },
    })
  }
  for (const day of completeInput.calendar) {
    for (const subject of day.items) {
      if (bySubject.has(subject.id)) continue
      bySubject.set(subject.id, {
        title: subject.name_cn || subject.name || String(subject.id),
        hot: false,
        images: {
          ...(subject.images?.common ? { common: subject.images.common } : {}),
          ...(subject.images?.large ? { large: subject.images.large } : {}),
        },
      })
    }
  }
  const candidates: RefreshCandidate[] = []
  for (const [subjectId, input] of bySubject) {
    const media = mediaBySubject.get(subjectId)
    const commonChanged = Boolean(input.images.common
      && input.images.common !== (media?.source_image_common_url ?? undefined))
    const largeChanged = Boolean(input.images.large
      && input.images.large !== (media?.source_image_large_url ?? undefined))
    if (!media || newlyVisible.has(subjectId)) {
      candidates.push({ subject_id: subjectId, ...input, components: ['detail', 'meta', 'image_common', 'image_large'], priority: 'new_or_changed' })
    } else if (commonChanged || largeChanged) {
      candidates.push({
        subject_id: subjectId,
        ...input,
        components: [
          ...(commonChanged ? ['image_common' as const] : []),
          ...(largeChanged ? ['image_large' as const] : []),
        ],
        priority: 'new_or_changed',
      })
    } else if (media.retry_count > 0) {
      if (media.retry_after !== null && media.retry_after <= now) {
        candidates.push({
          subject_id: subjectId,
          ...input,
          components: ['detail', 'meta', 'image_common', 'image_large'],
          priority: 'retry',
        })
      }
    } else if (!input.hot) {
      candidates.push({ subject_id: subjectId, ...input, components: ['detail', 'meta', 'image_common', 'image_large'], priority: 'cold' })
    } else if (media.next_refresh_at !== null && media.next_refresh_at <= now) {
      candidates.push({
        subject_id: subjectId,
        ...input,
        components: ['detail', 'meta', 'image_common', 'image_large'],
        priority: 'hot',
      })
    }
  }
  return candidates
}

async function publicationInput(
  collections: PublicCollectionItemV1[],
  completeInput: CompleteFullFetch,
  mediaBySubject: Map<number, SubjectMediaRow>,
): Promise<D1PublicationInput> {
  const calendar = transformCalendar(completeInput.calendar).map((day) => ({
    ...day,
    items: day.items.map((item) => {
      const media = projectedMedia(mediaBySubject.get(item.subject_id), item.subject_id)
      const detail = media?.detail
      if (!media) return item
      return {
        ...item,
        name: detail?.name ?? item.name,
        name_cn: detail?.name_cn ?? item.name_cn,
        summary: detail?.summary ?? item.summary,
        images: media.images,
        nsfw: media.nsfw,
        date: detail?.date ?? item.date,
        eps: nonNegativeInteger(detail?.eps, item.eps),
        total_episodes: nonNegativeInteger(detail?.total_episodes, item.total_episodes),
      }
    }),
  }))
  const input = {
    collections,
    calendar,
    published_at: completeInput.observedAt,
  }
  const snapshot = await buildPublicSnapshot(input, 0)
  return {
    ...input,
    content_hash: snapshot.content_hash,
  }
}

export async function runD1IncrementalSync({
  env,
  instanceId,
  completeInput,
  now,
  store: suppliedStore,
  submitMedia: suppliedSubmitMedia,
}: D1IncrementalSyncArguments): Promise<D1SyncResult> {
  if (completeInput.complete !== true) throw new Error('D1 sync requires a complete full fetch')
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid D1 sync time')
  const database = env.AIRING_CAL_D1
  const store = suppliedStore ?? (database ? new D1StateStore(database, () => now) : undefined)
  if (!store) throw new Error('AIRING_CAL_D1 is unavailable')
  const completeInputHash = await sha256Canonical(completeInput)

  const run: SyncRunRow = {
    instance_id: instanceId,
    status: 'running',
    stage: 'collections',
    generation: null,
    collection_count: completeInput.collections.length,
    changed_count: 0,
    missing_count: 0,
    deleted_count: 0,
    media_selected_count: 0,
    media_granted_count: 0,
    input_hash: completeInputHash,
    public_hash: null,
    result_json: null,
    error_code: null,
    started_at: now,
    heartbeat_at: now,
    completed_at: null,
  }
  const existingRun = await store.getSyncRun(instanceId)
  if (existingRun === undefined) {
    await store.startSyncRun(run)
  } else if (existingRun.status !== 'running' && existingRun.status !== 'ok') {
    throw new Error(`Sync run cannot be resumed from status: ${existingRun.status}`)
  } else if (existingRun.input_hash !== completeInputHash) {
    throw new Error(`D1 sync instance input mismatch: ${instanceId}`)
  }

  let collectionCheckpoint: CollectionCheckpoint | undefined
  let mediaPendingCheckpoint: MediaPendingCheckpoint | undefined
  let preparedResult: D1SyncResult | undefined
  let preparedColdCursor: PreparedColdCursorTransition | undefined
  let preparedResultJson = existingRun?.result_json ?? undefined
  let activeArtifact: LoadedReplayArtifact | undefined
  const supersededArtifacts: LoadedReplayArtifact[] = []
  let adoptedStage = existingRun?.stage ?? run.stage
  let adoptedResultJson = existingRun?.result_json ?? null

  try {
    if (existingRun !== undefined) {
      activeArtifact = await loadReplayArtifact(
        store,
        existingRun.result_json,
        completeInputHash,
        instanceId,
      )
      const artifactJson = activeArtifact?.artifactJson ?? null
      if (activeArtifact?.kind === 'collection') {
        collectionCheckpoint = await decodeCollectionCheckpoint(artifactJson, completeInputHash)
        if (!collectionCheckpoint) throw new Error('Invalid D1 sync collection replay artifact')
      } else if (activeArtifact?.kind === 'media_pending') {
        mediaPendingCheckpoint = await decodeMediaPendingCheckpoint(
          artifactJson,
          completeInputHash,
          instanceId,
        )
        if (!mediaPendingCheckpoint) throw new Error('Invalid D1 sync media replay artifact')
        collectionCheckpoint = mediaPendingCheckpoint.collection
      } else if (activeArtifact?.kind === 'prepared') {
        preparedResult = await decodePreparedResult(artifactJson, completeInputHash, instanceId)
        if (!preparedResult) throw new Error('Invalid prepared D1 sync replay artifact')
      } else {
        collectionCheckpoint = await decodeCollectionCheckpoint(artifactJson, completeInputHash)
        mediaPendingCheckpoint = collectionCheckpoint
          ? undefined
          : await decodeMediaPendingCheckpoint(artifactJson, completeInputHash, instanceId)
        if (mediaPendingCheckpoint) collectionCheckpoint = mediaPendingCheckpoint.collection
        preparedResult = collectionCheckpoint || mediaPendingCheckpoint
          ? undefined
          : await decodePreparedResult(artifactJson, completeInputHash, instanceId)
      }
      preparedColdCursor = preparedResult
        ? decodePreparedColdCursor(artifactJson, completeInputHash)
        : undefined
    }
    if (existingRun?.status === 'ok') {
      if (!preparedResult) throw new Error(`Completed D1 sync result is unavailable: ${instanceId}`)
      return preparedResult
    }

    if (preparedResult && preparedResultJson) {
      if (preparedColdCursor) {
        const currentCursor = await store.getAppState('media:cold-cursor', decodeColdCursor)
          ?? { subject_ids: [] }
        if (!sameCursor(currentCursor, preparedColdCursor.cursor)) {
          await store.putAppStateIfNewer(
            'media:cold-cursor',
            preparedColdCursor.cursor,
            preparedColdCursor.version,
          )
        }
      }
      let transition: SyncTerminalTransitionResult
      const completionGuard = {
        stage: adoptedStage,
        result_json: adoptedResultJson,
      }
      try {
        transition = await store.completeSyncRun(instanceId, {
          heartbeat_at: now,
          completed_at: now,
          input_hash: completeInputHash,
          public_hash: preparedResult.publicationInput.content_hash,
          result_json: preparedResultJson,
        }, completionGuard)
      } catch (error) {
        if (await hasValidDifferentWinner(
          store,
          instanceId,
          completeInputHash,
          completionGuard,
        )) {
          return runD1IncrementalSync({
            env,
            instanceId,
            completeInput,
            now,
            store,
            submitMedia: suppliedSubmitMedia,
          })
        }
        throw error
      }
      if (transition.terminal !== 'ok') throw new Error(`Sync run completion preserved ${transition.terminal}`)
      return preparedResult
    }

    const incoming = await Promise.all(completeInput.collections.map(({ user_id, collection }) =>
      normalizeCollection(user_id, collection)))
    let plan = collectionCheckpoint?.plan
    let publicInput = collectionCheckpoint?.publicationInput
    let rowsWritten = collectionCheckpoint?.rowsWritten ?? 0
    let firstMissing = collectionCheckpoint?.firstMissing ?? 0
    let deleted = collectionCheckpoint?.deleted ?? 0
    let restored = collectionCheckpoint?.restored ?? 0
    let staleReplans = 0
    let responseLossReconciliations = 0
    let collectionApplied = mediaPendingCheckpoint !== undefined
    let mediaRowsForRun: SubjectMediaRow[] | undefined
    let collectionArtifact = collectionCheckpoint ? activeArtifact : undefined
    if (mediaPendingCheckpoint) collectionArtifact = undefined
    let collectionArtifactAdopted = collectionArtifact !== undefined
    while (!collectionApplied) {
      if (!plan || !publicInput) {
        const current = await store.listCollectionRows()
        plan = await planCollectionDiff({
          current,
          incoming,
          complete: completeInput.complete,
          observedAt: completeInput.observedAt,
        })
        mediaRowsForRun = await store.listSubjectMediaRows()
        const mediaBySubject = new Map(mediaRowsForRun.map((row) => [row.subject_id, row]))
        publicInput = await publicationInput(
          mergePublicCollections(activeRowsAfterPlan(current, plan)
            .map((row) => publicItemFromRow(row, mediaBySubject))),
          completeInput,
          mediaBySubject,
        )
        rowsWritten = plannedRowsWritten(plan)
        firstMissing = plan.firstMissing.length
        deleted = plan.confirmedDeleted.length
        restored = plan.restored.length
        collectionCheckpoint = {
          plan,
          rowsWritten,
          firstMissing,
          deleted,
          restored,
          publicationInput: publicInput,
        }
        collectionArtifact = undefined
        collectionArtifactAdopted = false
      }
      if (!collectionCheckpoint) throw new Error('Collection checkpoint preparation failed')
      if (!collectionArtifact) {
        const checkpointArtifactJson = canonicalJson({
          schema_version: 1,
          input_hash: completeInputHash,
          checkpoint_hash: await sha256Canonical(collectionCheckpoint),
          collection: collectionCheckpoint,
        } satisfies CollectionCheckpointEnvelope)
        collectionArtifact = await persistReplayArtifact(
          store,
          instanceId,
          completeInputHash,
          'collection',
          checkpointArtifactJson,
        )
        collectionArtifactAdopted = false
      }
      const checkpointJson = collectionArtifact.manifestJson
      try {
        await store.applyCollectionDiff(plan, {
          instanceId,
          guard: {
            stage: adoptedStage,
            result_json: adoptedResultJson,
          },
          update: {
            stage: 'collections_pending',
            heartbeat_at: now,
            collection_count: completeInput.collections.length,
            changed_count: changedRows(plan).length,
            missing_count: firstMissing,
            deleted_count: deleted,
            input_hash: completeInputHash,
            public_hash: publicInput.content_hash,
            result_json: checkpointJson,
          },
        })
        collectionApplied = true
        collectionArtifactAdopted = true
        adoptedStage = 'collections_pending'
        adoptedResultJson = checkpointJson
      } catch (error) {
        if (error instanceof StaleCollectionDiffError) {
          const persisted = await store.getSyncRun(instanceId)
          const checkpointWasAdopted = persisted?.status === 'running'
            && persisted.input_hash === completeInputHash
            && persisted.result_json === checkpointJson
          if (staleReplans === MAX_STALE_REPLANS) {
            if (!checkpointWasAdopted) {
              await cleanupReplayArtifactBestEffort(store, instanceId, collectionArtifact)
            }
            throw error
          }
          staleReplans++
          responseLossReconciliations = 0
          if (checkpointWasAdopted) {
            adoptedStage = persisted!.stage
            adoptedResultJson = persisted!.result_json
            supersededArtifacts.push(collectionArtifact)
          } else {
            await cleanupReplayArtifactBestEffort(store, instanceId, collectionArtifact)
          }
          plan = undefined
          publicInput = undefined
          mediaRowsForRun = undefined
          collectionCheckpoint = undefined
          collectionArtifact = undefined
          collectionArtifactAdopted = false
          continue
        }
        const persisted = await store.getSyncRun(instanceId)
        const checkpointWasAdopted = persisted?.status === 'running'
          && persisted.input_hash === completeInputHash
          && persisted.result_json === checkpointJson
        if (checkpointWasAdopted) collectionArtifactAdopted = true
        const persistedArtifact = checkpointWasAdopted
          ? await loadReplayArtifact(store, persisted.result_json, completeInputHash, instanceId)
          : undefined
        if (
          persistedArtifact
          && persistedArtifact.kind === 'collection'
          && await decodeCollectionCheckpoint(persistedArtifact.artifactJson, completeInputHash)
          && responseLossReconciliations < MAX_RESPONSE_LOSS_RECONCILIATIONS
        ) {
          adoptedStage = persisted!.stage
          adoptedResultJson = persisted!.result_json
          responseLossReconciliations++
          continue
        }
        const winningArtifact = persisted?.status === 'running'
          && persisted.input_hash === completeInputHash
          && persisted.result_json !== null
          ? await loadReplayArtifact(
            store,
            persisted.result_json,
            completeInputHash,
            instanceId,
          )
          : undefined
        if (
          persisted?.status === 'running'
          && persisted.input_hash === completeInputHash
          && (persisted.stage !== adoptedStage || persisted.result_json !== adoptedResultJson)
          && (
            winningArtifact?.kind === 'collection'
            || winningArtifact?.kind === 'media_pending'
            || winningArtifact?.kind === 'prepared'
          )
        ) {
          await cleanupReplayArtifactBestEffort(store, instanceId, collectionArtifact)
          return runD1IncrementalSync({
            env,
            instanceId,
            completeInput,
            now,
            store,
            submitMedia: suppliedSubmitMedia,
          })
        }
        if (!collectionArtifactAdopted) {
          await cleanupReplayArtifactBestEffort(store, instanceId, collectionArtifact)
        }
        throw error
      }
    }
    if (!collectionApplied || !plan || !publicInput || !collectionCheckpoint) {
      throw new Error('Collection diff reconciliation failed')
    }
    for (const supersededArtifact of supersededArtifacts) {
      await cleanupReplayArtifactIfUnreferenced(store, instanceId, supersededArtifact)
    }
    supersededArtifacts.length = 0
    let mediaPendingArtifact = mediaPendingCheckpoint ? activeArtifact : undefined
    if (!mediaPendingCheckpoint) {
      const mediaRows = mediaRowsForRun ?? await store.listSubjectMediaRows()
      const utcDay = new Date(now * 1000).toISOString().slice(0, 10)
      const previousCursor = await store.getAppState('media:cold-cursor', decodeColdCursor)
        ?? { subject_ids: [] }
      const selection = selectRefreshCandidates(
        planMediaCandidates(completeInput, mediaRows, plan, now),
        utcDay,
        { soft: MEDIA_SOFT_LIMIT, hard: MEDIA_HARD_LIMIT },
        previousCursor,
      )
      const jobs = mediaJobs(instanceId, completeInput.observedAt, selection.selected)
      const request = requireMediaRequest(JSON.parse(canonicalJson({
        date: utcDay,
        resource: 'media',
        reservationId: `${instanceId}:media`,
        jobs,
        privilegedCount: selection.selected
          .filter(({ priority }) => priority === 'new_or_changed').length,
        softLimit: MEDIA_SOFT_LIMIT,
        hardLimit: MEDIA_HARD_LIMIT,
      } satisfies BudgetReservationRequest<MediaRefreshJobV4>)), instanceId)
      const pendingCheckpoint: MediaPendingCheckpoint = {
        collection: collectionCheckpoint,
        request,
        candidates: selection.candidates,
        selected_priorities: selection.selected.map(({ priority }) => priority),
        cold_cursor: selection.cold_cursor,
        cold_cursor_version: now,
      }
      mediaPendingCheckpoint = pendingCheckpoint
      const mediaCheckpointArtifactJson = canonicalJson({
        schema_version: 1,
        input_hash: completeInputHash,
        checkpoint_hash: await sha256Canonical(pendingCheckpoint),
        media_pending: pendingCheckpoint,
      } satisfies MediaPendingCheckpointEnvelope)
      mediaPendingArtifact = await persistReplayArtifact(
        store,
        instanceId,
        completeInputHash,
        'media_pending',
        mediaCheckpointArtifactJson,
      )
      try {
        await store.updateSyncRun(instanceId, {
          stage: 'media_pending',
          heartbeat_at: now,
          collection_count: completeInput.collections.length,
          changed_count: changedRows(plan).length,
          missing_count: plan.firstMissing.length,
          deleted_count: plan.confirmedDeleted.length,
          media_selected_count: request.jobs.length,
          media_granted_count: 0,
          input_hash: completeInputHash,
          public_hash: publicInput.content_hash,
          result_json: mediaPendingArtifact.manifestJson,
        }, {
          stage: adoptedStage,
          result_json: adoptedResultJson,
        })
        adoptedStage = 'media_pending'
        adoptedResultJson = mediaPendingArtifact.manifestJson
      } catch (error) {
        const persisted = await store.getSyncRun(instanceId)
        if (
          persisted?.status === 'running'
          && persisted.input_hash === completeInputHash
          && persisted.stage === 'media_pending'
          && persisted.result_json === mediaPendingArtifact.manifestJson
        ) {
          adoptedStage = persisted.stage
          adoptedResultJson = persisted.result_json
        } else if (
          persisted?.status === 'running'
          && persisted.input_hash === completeInputHash
          && (persisted.stage !== adoptedStage || persisted.result_json !== adoptedResultJson)
        ) {
          await cleanupReplayArtifactBestEffort(store, instanceId, mediaPendingArtifact)
          return runD1IncrementalSync({
            env,
            instanceId,
            completeInput,
            now,
            store,
            submitMedia: suppliedSubmitMedia,
          })
        } else {
          await cleanupReplayArtifactBestEffort(store, instanceId, mediaPendingArtifact)
          throw error
        }
      }
      if (collectionArtifact) {
        await cleanupReplayArtifactIfUnreferenced(store, instanceId, collectionArtifact)
        collectionArtifact = undefined
      }
    }
    if (!mediaPendingCheckpoint || !mediaPendingArtifact) {
      throw new Error('Media checkpoint preparation failed')
    }
    const adoptedPending = await store.getSyncRun(instanceId)
    if (
      adoptedPending?.status !== 'running'
      || adoptedPending.input_hash !== completeInputHash
      || adoptedPending.stage !== 'media_pending'
      || adoptedPending.result_json !== mediaPendingArtifact.manifestJson
    ) {
      return runD1IncrementalSync({
        env,
        instanceId,
        completeInput,
        now,
        store,
        submitMedia: suppliedSubmitMedia,
      })
    }
    adoptedStage = adoptedPending.stage
    adoptedResultJson = adoptedPending.result_json
    const request = mediaPendingCheckpoint.request
    const jobs = request.jobs
    const reservation = jobs.length === 0 || suppliedSubmitMedia === undefined
      ? {
          granted: 0,
          consumed: 0,
          soft_limit: MEDIA_SOFT_LIMIT,
          hard_limit: MEDIA_HARD_LIMIT,
          submission: 'submitted' as const,
        }
      : await suppliedSubmitMedia(request)
    const confirmed = reservation.submission === 'submitted' ? reservation.granted : 0
    const uncertain = reservation.submission === 'uncertain' ? reservation.granted : 0
    const nextColdCursor = {
      subject_ids: [
        ...jobs
          .slice(reservation.granted)
          .filter((_, index) =>
            mediaPendingCheckpoint!.selected_priorities[index + reservation.granted] === 'cold')
          .map(({ subject_id }) => subject_id),
        ...mediaPendingCheckpoint.cold_cursor.subject_ids,
      ],
    }
    const changed = changedRows(plan).length

    preparedResult = {
      rowsWritten,
      firstMissing,
      deleted,
      restored,
      publicationInput: publicInput,
      media: {
        candidates: mediaPendingCheckpoint.candidates,
        granted: reservation.granted,
        confirmed,
        uncertain,
        deferred: Math.max(0, mediaPendingCheckpoint.candidates - reservation.granted),
      },
      runId: instanceId,
    }
    const preparedArtifactJson = canonicalJson({
      schema_version: 1,
      input_hash: completeInputHash,
      result: preparedResult,
      cold_cursor: nextColdCursor,
      cold_cursor_version: mediaPendingCheckpoint.cold_cursor_version,
    } satisfies PreparedResultEnvelope)
    const preparedArtifact = await persistReplayArtifact(
      store,
      instanceId,
      completeInputHash,
      'prepared',
      preparedArtifactJson,
    )
    preparedResultJson = preparedArtifact.manifestJson
    try {
      await store.updateSyncRun(instanceId, {
        stage: 'media',
        heartbeat_at: now,
        collection_count: completeInput.collections.length,
        changed_count: changed,
        missing_count: plan.firstMissing.length,
        deleted_count: plan.confirmedDeleted.length,
        media_selected_count: jobs.length,
        media_granted_count: reservation.granted,
        input_hash: completeInputHash,
        public_hash: publicInput.content_hash,
        result_json: preparedResultJson,
      }, {
        stage: adoptedStage,
        result_json: adoptedResultJson,
      })
      adoptedStage = 'media'
      adoptedResultJson = preparedResultJson
    } catch (error) {
      const persisted = await store.getSyncRun(instanceId)
      if (
        persisted?.status === 'running'
        && persisted.input_hash === completeInputHash
        && persisted.stage === 'media'
        && persisted.result_json === preparedResultJson
      ) {
        adoptedStage = persisted.stage
        adoptedResultJson = persisted.result_json
      } else if (
        persisted?.status === 'running'
        && persisted.input_hash === completeInputHash
        && (persisted.stage !== adoptedStage || persisted.result_json !== adoptedResultJson)
      ) {
        await cleanupReplayArtifactBestEffort(store, instanceId, preparedArtifact)
        return runD1IncrementalSync({
          env,
          instanceId,
          completeInput,
          now,
          store,
          submitMedia: suppliedSubmitMedia,
        })
      } else {
        await cleanupReplayArtifactBestEffort(store, instanceId, preparedArtifact)
        throw error
      }
    }
    if (collectionArtifact && collectionArtifact.chunkKeys.length > 0) {
      await cleanupReplayArtifactIfUnreferenced(store, instanceId, collectionArtifact)
    }
    if (mediaPendingArtifact.chunkKeys.length > 0) {
      await cleanupReplayArtifactIfUnreferenced(store, instanceId, mediaPendingArtifact)
    }
    const currentColdCursor = await store.getAppState('media:cold-cursor', decodeColdCursor)
      ?? { subject_ids: [] }
    if (!sameCursor(currentColdCursor, nextColdCursor)) {
      await store.putAppStateIfNewer(
        'media:cold-cursor',
        nextColdCursor,
        mediaPendingCheckpoint.cold_cursor_version,
      )
    }
    let transition: SyncTerminalTransitionResult
    const completionGuard = {
      stage: adoptedStage,
      result_json: adoptedResultJson,
    }
    try {
      transition = await store.completeSyncRun(instanceId, {
        heartbeat_at: now,
        completed_at: now,
        input_hash: completeInputHash,
        public_hash: publicInput.content_hash,
        result_json: preparedResultJson,
      }, completionGuard)
    } catch (error) {
      if (await hasValidDifferentWinner(
        store,
        instanceId,
        completeInputHash,
        completionGuard,
      )) {
        return runD1IncrementalSync({
          env,
          instanceId,
          completeInput,
          now,
          store,
          submitMedia: suppliedSubmitMedia,
        })
      }
      throw error
    }
    if (transition.terminal !== 'ok') throw new Error(`Sync run completion preserved ${transition.terminal}`)

    return preparedResult
  } catch (error) {
    const failureGuard = {
      stage: adoptedStage,
      result_json: adoptedResultJson,
    }
    try {
      const transition = await store.failSyncRun(instanceId, {
        heartbeat_at: now,
        completed_at: now,
        error_code: classifyError(error),
      }, failureGuard)
      if (transition.terminal === 'ok') {
        const persisted = await store.getSyncRun(instanceId)
        const recoveredArtifact = persisted
          ? await loadReplayArtifact(store, persisted.result_json, completeInputHash, instanceId)
          : undefined
        const recovered = recoveredArtifact
          ? await decodePreparedResult(
              recoveredArtifact.artifactJson,
              completeInputHash,
              instanceId,
            )
          : undefined
        if (recovered) return recovered
        if (preparedResult) return preparedResult
      }
    } catch (failureError) {
      if (await hasValidDifferentWinner(
        store,
        instanceId,
        completeInputHash,
        failureGuard,
      )) {
        return runD1IncrementalSync({
          env,
          instanceId,
          completeInput,
          now,
          store,
          submitMedia: suppliedSubmitMedia,
        })
      }
      // A guard conflict proves this attempt no longer owns the checkpoint.
      // Even when its winner cannot be validated at this instant, leave the
      // running state for a later replay rather than terminalizing a newer
      // checkpoint through an unguarded write.
      // Any other failure-persistence error (for example a lost failure
      // write) likewise preserves the persisted running checkpoint for replay.
    }
    throw error
  }
}
