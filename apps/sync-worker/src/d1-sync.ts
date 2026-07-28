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
  sha256Canonical,
  StaleCollectionDiffError,
  type BudgetReservationRequest,
  type BudgetReservationResult,
  type CollectionRow,
  type D1DatabaseLike,
  type MediaRefreshJobV3,
  type PublicCollectionItemV1,
  type SyncRunCompletion,
  type SyncRunFailure,
  type SyncRunRow,
  type SyncRunUpdate,
  type SyncTerminalTransitionResult,
  type SubjectMediaRow,
} from '@airing-cal/storage'
import type { CompleteFullFetch } from './full-fetch-boundary.ts'
import {
  loadReplayArtifact,
  persistReplayArtifact,
  type LoadedReplayArtifact,
} from './replay-artifact.ts'
import {
  selectRefreshCandidates,
  type ColdRefreshCursor,
  type RefreshCandidate,
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
    checkpoint?: { instanceId: string; update: SyncRunUpdate },
  ): Promise<{ rowsWritten: number }>
  startSyncRun(row: SyncRunRow): Promise<void>
  updateSyncRun(instanceId: string, update: SyncRunUpdate): Promise<void>
  completeSyncRun(instanceId: string, completion: SyncRunCompletion): Promise<SyncTerminalTransitionResult>
  failSyncRun(instanceId: string, failure: SyncRunFailure): Promise<SyncTerminalTransitionResult>
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

interface RunArguments {
  env: D1IncrementalSyncEnv
  instanceId: string
  completeInput: CompleteFullFetch
  now: number
  store?: D1IncrementalSyncStore
  submitMedia?: (request: BudgetReservationRequest<MediaRefreshJobV3>) => Promise<BudgetReservationResult>
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

function mediaJobs(instanceId: string, candidates: RefreshCandidate[]): MediaRefreshJobV3[] {
  return candidates.map((candidate) => {
    return {
      version: 3,
      generation: 0,
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

function publicItemFromRow(row: CollectionRow): PublicCollectionItemV1 {
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
  const tags = JSON.parse(row.tags_json) as string[]
  return {
    subject_id: row.subject_id,
    name: subject?.name ?? '',
    name_cn: subject?.name_cn ?? '',
    summary: subject?.summary ?? '',
    images: { common: null, large: null },
    eps: subject?.eps ?? 0,
    total_episodes: subject?.total_episodes ?? 0,
    ep_status: row.ep_status,
    vol_status: row.vol_status,
    type: envelope.subject_type,
    collection_type: row.collection_type,
    rate: row.rate ?? 0,
    nsfw: subject?.nsfw ?? false,
    date: subject?.date ?? '',
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
): Promise<D1PublicationInput> {
  const input = {
    collections,
    calendar: transformCalendar(completeInput.calendar),
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
}: RunArguments): Promise<D1SyncResult> {
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
  let preparedResult: D1SyncResult | undefined
  let preparedColdCursor: PreparedColdCursorTransition | undefined
  let preparedResultJson = existingRun?.result_json ?? undefined
  let activeArtifact: LoadedReplayArtifact | undefined
  const supersededArtifactKeys: string[] = []

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
      } else if (activeArtifact?.kind === 'prepared') {
        preparedResult = await decodePreparedResult(artifactJson, completeInputHash, instanceId)
        if (!preparedResult) throw new Error('Invalid prepared D1 sync replay artifact')
      } else {
        collectionCheckpoint = await decodeCollectionCheckpoint(artifactJson, completeInputHash)
        preparedResult = collectionCheckpoint
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
      const transition = await store.completeSyncRun(instanceId, {
        heartbeat_at: now,
        completed_at: now,
        input_hash: completeInputHash,
        public_hash: preparedResult.publicationInput.content_hash,
        result_json: preparedResultJson,
      })
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
    let collectionApplied = false
    let collectionArtifact = collectionCheckpoint ? activeArtifact : undefined
    while (!collectionApplied) {
      if (!plan || !publicInput) {
        const current = await store.listCollectionRows()
        plan = await planCollectionDiff({
          current,
          incoming,
          complete: completeInput.complete,
          observedAt: completeInput.observedAt,
        })
        publicInput = await publicationInput(
          mergePublicCollections(activeRowsAfterPlan(current, plan).map(publicItemFromRow)),
          completeInput,
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
      }
      const checkpointJson = collectionArtifact.manifestJson
      try {
        await store.applyCollectionDiff(plan, {
          instanceId,
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
      } catch (error) {
        if (error instanceof StaleCollectionDiffError) {
          if (staleReplans === MAX_STALE_REPLANS) throw error
          staleReplans++
          responseLossReconciliations = 0
          supersededArtifactKeys.push(...collectionArtifact.chunkKeys)
          plan = undefined
          publicInput = undefined
          collectionCheckpoint = undefined
          collectionArtifact = undefined
          continue
        }
        const persisted = await store.getSyncRun(instanceId)
        const persistedArtifact = persisted?.status === 'running'
          && persisted.input_hash === completeInputHash
          && persisted.result_json === checkpointJson
          ? await loadReplayArtifact(store, persisted.result_json, completeInputHash, instanceId)
          : undefined
        if (
          persistedArtifact
          && persistedArtifact.kind === 'collection'
          && await decodeCollectionCheckpoint(persistedArtifact.artifactJson, completeInputHash)
          && responseLossReconciliations < MAX_RESPONSE_LOSS_RECONCILIATIONS
        ) {
          responseLossReconciliations++
          continue
        }
        throw error
      }
    }
    if (!collectionApplied || !plan || !publicInput) {
      throw new Error('Collection diff reconciliation failed')
    }
    if (supersededArtifactKeys.length > 0) {
      await store.deleteAppStateKeys(supersededArtifactKeys)
      supersededArtifactKeys.length = 0
    }
    const mediaRows = await store.listSubjectMediaRows()
    const utcDay = new Date(now * 1000).toISOString().slice(0, 10)
    const previousCursor = await store.getAppState('media:cold-cursor', decodeColdCursor) ?? { subject_ids: [] }
    const selection = selectRefreshCandidates(
      planMediaCandidates(completeInput, mediaRows, plan, now),
      utcDay,
      { soft: MEDIA_SOFT_LIMIT, hard: MEDIA_HARD_LIMIT },
      previousCursor,
    )
    const jobs = mediaJobs(instanceId, selection.selected)
    const request: BudgetReservationRequest<MediaRefreshJobV3> = {
      date: new Date(now * 1000).toISOString().slice(0, 10),
      resource: 'media',
      reservationId: `${instanceId}:media`,
      jobs,
      privilegedCount: selection.selected.filter(({ priority }) => priority === 'new_or_changed').length,
      softLimit: MEDIA_SOFT_LIMIT,
      hardLimit: MEDIA_HARD_LIMIT,
    }
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
        ...selection.selected
          .slice(reservation.granted)
          .filter(({ priority }) => priority === 'cold')
          .map(({ subject_id }) => subject_id),
        ...selection.cold_cursor.subject_ids,
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
        candidates: selection.candidates,
        granted: reservation.granted,
        confirmed,
        uncertain,
        deferred: Math.max(0, selection.candidates - reservation.granted),
      },
      runId: instanceId,
    }
    const preparedArtifactJson = canonicalJson({
      schema_version: 1,
      input_hash: completeInputHash,
      result: preparedResult,
      cold_cursor: nextColdCursor,
      cold_cursor_version: now,
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
      })
    } catch (error) {
      const persisted = await store.getSyncRun(instanceId)
      if (persisted?.result_json !== preparedResultJson) {
        await store.deleteAppStateKeys(preparedArtifact.chunkKeys)
        throw error
      }
    }
    if (collectionArtifact && collectionArtifact.chunkKeys.length > 0) {
      await store.deleteAppStateKeys(collectionArtifact.chunkKeys)
    }
    if (!sameCursor(previousCursor, nextColdCursor)) {
      await store.putAppStateIfNewer('media:cold-cursor', nextColdCursor, now)
    }
    const transition = await store.completeSyncRun(instanceId, {
      heartbeat_at: now,
      completed_at: now,
      input_hash: completeInputHash,
      public_hash: publicInput.content_hash,
      result_json: preparedResultJson,
    })
    if (transition.terminal !== 'ok') throw new Error(`Sync run completion preserved ${transition.terminal}`)

    return preparedResult
  } catch (error) {
    try {
      const transition = await store.failSyncRun(instanceId, {
        heartbeat_at: now,
        completed_at: now,
        error_code: classifyError(error),
      })
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
    } catch {
      // Preserve the originating error; run failure persistence is best effort.
    }
    throw error
  }
}
