import {
  normalizeCollection,
  planCollectionDiff,
  buildPublicSnapshot,
  transformCalendar,
  type CollectionDiffPlan,
  type PublicSnapshotInput,
} from '@airing-cal/domain'
import {
  D1StateStore,
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
import { reserveAndSubmitMedia } from './snapshot-coordinator.ts'
import type { CompleteFullFetch } from './full-fetch-boundary.ts'
import {
  selectRefreshCandidates,
  type ColdRefreshCursor,
  type RefreshCandidate,
} from './refresh-planner.ts'

const MEDIA_SOFT_LIMIT = 50
const MEDIA_HARD_LIMIT = 100
const MAX_STALE_REPLANS = 1

export interface D1IncrementalSyncEnv {
  AIRING_CAL_D1?: D1DatabaseLike
  MEDIA_QUEUE?: {
    sendBatch(messages: Array<{ body: MediaRefreshJobV3; contentType?: 'json' }>): Promise<unknown>
  }
}

export interface D1IncrementalSyncStore {
  listCollectionRows(): Promise<CollectionRow[]>
  listSubjectMediaRows(): Promise<SubjectMediaRow[]>
  getAppState<T>(key: string, decode: (value: unknown) => T): Promise<T | undefined>
  putAppState<T>(key: string, value: T): Promise<void>
  applyCollectionDiff(plan: CollectionDiffPlan): Promise<{ rowsWritten: number }>
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

function changedRows(plan: CollectionDiffPlan): CollectionRow[] {
  return [...plan.inserts, ...plan.updates, ...plan.restored]
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
    } else if (media.retry_count > 0 && media.retry_after !== null && media.retry_after <= now) {
      candidates.push({ subject_id: subjectId, ...input, components: ['detail', 'meta', 'image_common', 'image_large'], priority: 'retry' })
    } else if (media.next_refresh_at !== null && media.next_refresh_at <= now) {
      candidates.push({
        subject_id: subjectId,
        ...input,
        components: ['detail', 'meta', 'image_common', 'image_large'],
        priority: input.hot ? 'hot' : 'cold',
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
    input_hash: null,
    public_hash: null,
    error_code: null,
    started_at: now,
    heartbeat_at: now,
    completed_at: null,
  }
  await store.startSyncRun(run)

  try {
    const incoming = await Promise.all(completeInput.collections.map(({ user_id, collection }) =>
      normalizeCollection(user_id, collection)))
    let plan: CollectionDiffPlan | undefined
    let rowsWritten = 0
    for (let attempt = 0; attempt <= MAX_STALE_REPLANS; attempt++) {
      const current = await store.listCollectionRows()
      plan = await planCollectionDiff({
        current,
        incoming,
        complete: completeInput.complete,
        observedAt: completeInput.observedAt,
      })
      try {
        rowsWritten = (await store.applyCollectionDiff(plan)).rowsWritten
        break
      } catch (error) {
        if (!(error instanceof StaleCollectionDiffError) || attempt === MAX_STALE_REPLANS) throw error
        plan = undefined
      }
    }
    if (!plan) throw new Error('Collection diff reconciliation failed')

    const publicInput = await publicationInput(
      mergePublicCollections(incoming.map(({ public_item }) => public_item)),
      completeInput,
    )
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
    const submitMedia = suppliedSubmitMedia ?? (database
      ? (budgetRequest: BudgetReservationRequest<MediaRefreshJobV3>) =>
          reserveAndSubmitMedia(database, env.MEDIA_QUEUE, budgetRequest, now)
      : undefined)
    if (!submitMedia) throw new Error('D1 media submission is unavailable')
    const reservation = jobs.length === 0
      ? {
          granted: 0,
          consumed: 0,
          soft_limit: MEDIA_SOFT_LIMIT,
          hard_limit: MEDIA_HARD_LIMIT,
          submission: 'submitted' as const,
        }
      : await submitMedia(request)
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
    if (!sameCursor(previousCursor, nextColdCursor)) {
      await store.putAppState('media:cold-cursor', nextColdCursor)
    }
    const changed = changedRows(plan).length

    await store.updateSyncRun(instanceId, {
      stage: 'media',
      heartbeat_at: now,
      collection_count: completeInput.collections.length,
      changed_count: changed,
      missing_count: plan.firstMissing.length,
      deleted_count: plan.confirmedDeleted.length,
      media_selected_count: jobs.length,
      media_granted_count: reservation.granted,
      input_hash: publicInput.content_hash,
      public_hash: publicInput.content_hash,
    })
    await store.completeSyncRun(instanceId, {
      heartbeat_at: now,
      completed_at: now,
      input_hash: publicInput.content_hash,
      public_hash: publicInput.content_hash,
    })

    return {
      rowsWritten,
      firstMissing: plan.firstMissing.length,
      deleted: plan.confirmedDeleted.length,
      restored: plan.restored.length,
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
  } catch (error) {
    try {
      await store.failSyncRun(instanceId, {
        heartbeat_at: now,
        completed_at: now,
        error_code: classifyError(error),
      })
    } catch {
      // Preserve the originating error; run failure persistence is best effort.
    }
    throw error
  }
}
