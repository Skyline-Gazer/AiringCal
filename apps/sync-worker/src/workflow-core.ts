import { BgmClient, BgmHttpError, type BgmCollection } from '@airing-cal/bgm-api'
import { mergeCollections, subjectDetailImages, transformCalendar } from '@airing-cal/domain'
import {
  snapshotActiveKey,
  snapshotVersionKey,
  imageStatusKey,
  subjectDetailKey,
  subjectMetaKey,
  subjectRefreshKey,
  syncCurrentKey,
  syncMetaKey,
  syncRunKey,
  syncShadowKey,
  syncStagingKey,
  SYNC_RUN_TTL_SECONDS,
  SYNC_STAGING_TTL_SECONDS,
  type CollectionType,
  type D1DatabaseLike,
  type MediaRefreshJobV3,
  type SnapshotManifest,
  type SyncRun,
  type SyncWorkflowParams,
} from '@airing-cal/storage'
import { sanitizeErrorMessage } from '@airing-cal/worker-common'
import {
  planSubjectRefresh,
  selectRefreshCandidates,
  type RefreshCandidate,
  type RefreshPlannerInput,
} from './refresh-planner.ts'
import { assembleFullFetch } from './full-fetch-boundary.ts'
import { runD1IncrementalSync, type D1SyncResult } from './d1-sync.ts'
import {
  publishPublicSnapshot,
  type PublishPublicSnapshotArguments,
} from './r2-publication.ts'

const COLLECTION_TYPES: CollectionType[] = ['want', 'watched', 'watching', 'on_hold', 'dropped']
const PAGE_LIMIT = 50
const REFRESH_CHUNK_SIZE = 10
const NETWORK_STEP = { retries: { limit: 3, delay: 1_000, backoff: 'exponential' as const }, timeout: 45_000 }
const STORAGE_STEP = { retries: { limit: 3, delay: 500, backoff: 'exponential' as const }, timeout: 45_000 }

interface KVNamespaceLike {
  get(key: string, type: 'json'): Promise<unknown>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

export interface SyncWorkflowEnv {
  AIRING_CAL_KV: KVNamespaceLike
  MEDIA_QUEUE: {
    sendBatch(messages: Array<{ body: MediaRefreshJobV3; contentType?: 'json' }>): Promise<void>
  }
  SNAPSHOT_COORDINATOR: {
    getByName(name: string): { fetch(request: Request): Promise<Response> }
  }
  BANGUMI_TOKEN: string
  BANGUMI_USERS: string
  AIRING_CAL_D1?: D1DatabaseLike
}

export interface SyncWorkflowDependencies {
  runD1IncrementalSync?: typeof runD1IncrementalSync
  publication?: Omit<PublishPublicSnapshotArguments, 'input' | 'now' | 'publicationId'>
  publishPublicSnapshot?: typeof publishPublicSnapshot
}

export interface WorkflowStepLike {
  do<T>(name: string, config: unknown, callback: () => Promise<T>): Promise<T>
}

export interface SyncWorkflowEventLike {
  instanceId: string
  payload: SyncWorkflowParams
  schedule?: { cron: string; scheduledTime: number }
}

interface StepOutput {
  key: string
  count: number
  digest: string
  total?: number
  offset?: number
  keys?: string[]
  snapshotKeys?: Partial<Record<CollectionType, string>>
  refreshInputKey?: string
  completeInputKey?: string
  refreshChunks?: number
  candidates?: RefreshCandidate[]
  planning_errors?: Array<{ subject_id: number; error: string }>
}

type RefreshInput = RefreshPlannerInput

type NonRetryableFactory = (message: string) => Error

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function getJson<T>(kv: KVNamespaceLike, key: string): Promise<T | null> {
  return await kv.get(key, 'json') as T | null
}

async function putJson(kv: KVNamespaceLike, key: string, value: unknown, expirationTtl?: number): Promise<void> {
  await kv.put(key, JSON.stringify(value), expirationTtl ? { expirationTtl } : undefined)
}

async function writeRun(env: SyncWorkflowEnv, run: SyncRun): Promise<void> {
  await putJson(env.AIRING_CAL_KV, syncRunKey(run.instance_id), run, SYNC_RUN_TTL_SECONDS)
}

async function coordinatorRequest<T>(env: SyncWorkflowEnv, path: string, body: unknown): Promise<T> {
  const response = await env.SNAPSHOT_COORDINATOR.getByName('snapshot-global').fetch(new Request(`https://snapshot-coordinator${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
  if (!response.ok) throw new Error(`Snapshot coordinator ${path} failed (${response.status})`)
  return await response.json() as T
}

function pageStepName(userIndex: number, page: number): string {
  return userIndex === 0 ? `fetch-collections-page-${page}` : `fetch-collections-user-${userIndex}-page-${page}`
}

function targetSnapshotKey(mode: 'shadow' | 'live', instanceId: string, suffix: string): string {
  return mode === 'shadow' ? syncShadowKey(instanceId, suffix) : snapshotVersionKey(instanceId, suffix)
}

function calendarSubjectIds(calendar: any[]): number[] {
  const ids: number[] = []
  for (const day of calendar) {
    for (const subject of day?.items ?? []) {
      if (typeof subject?.id === 'number') ids.push(subject.id)
    }
  }
  return ids
}

function sourceImages(collections: BgmCollection[], calendar: any[]): Map<number, { common?: string; large?: string }> {
  const result = new Map<number, { common?: string; large?: string }>()
  for (const entry of collections) result.set(entry.subject_id, subjectDetailImages(entry.subject))
  for (const day of calendar) {
    for (const subject of day?.items ?? []) {
      if (typeof subject?.id === 'number' && !result.has(subject.id)) result.set(subject.id, subjectDetailImages(subject))
    }
  }
  return result
}

function sourceTitles(collections: BgmCollection[], calendar: any[]): Map<number, string> {
  const result = new Map<number, string>()
  for (const entry of collections) {
    result.set(entry.subject_id, entry.subject?.name_cn || entry.subject?.name || String(entry.subject_id))
  }
  for (const day of calendar) {
    for (const subject of day?.items ?? []) {
      if (typeof subject?.id === 'number' && !result.has(subject.id)) {
        result.set(subject.id, subject.name_cn || subject.name || String(subject.id))
      }
    }
  }
  return result
}

async function fetchCollectionPage(
  client: BgmClient,
  username: string,
  offset: number,
  nonRetryable: NonRetryableFactory,
): Promise<{ data: BgmCollection[]; total: number }> {
  try {
    return await client.getCollections(username, offset, PAGE_LIMIT)
  } catch (error) {
    if (error instanceof BgmHttpError && (error.status === 401 || error.status === 403)) {
      throw nonRetryable(`bgm.tv collection authentication failed (${error.status})`)
    }
    throw error
  }
}

async function fetchCalendar(client: BgmClient, nonRetryable: NonRetryableFactory): Promise<any[]> {
  try {
    return await client.getCalendar() as any[]
  } catch (error) {
    if (error instanceof BgmHttpError && (error.status === 401 || error.status === 403)) {
      throw nonRetryable(`bgm.tv calendar authentication failed (${error.status})`)
    }
    throw error
  }
}

export async function runSyncWorkflow(
  env: SyncWorkflowEnv,
  event: SyncWorkflowEventLike,
  step: WorkflowStepLike,
  nonRetryable: NonRetryableFactory,
  dependencies: SyncWorkflowDependencies = {},
): Promise<{
  instance_id: string
  status: 'ok'
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
}> {
  const scheduled = Boolean(event.schedule)
  const mode = scheduled ? 'live' : event.payload?.mode
  if (mode !== 'shadow' && mode !== 'live') throw nonRetryable('Manual workflow requires mode shadow or live')
  const source = scheduled || event.payload?.source === 'schedule' ? 'schedule' : 'manual'
  if (source === 'schedule' && mode !== 'live') throw nonRetryable('Scheduled workflow requires live mode')
  const users = env.BANGUMI_USERS.split(',').map((user) => user.trim()).filter(Boolean)
  if (!users.length) throw nonRetryable('BANGUMI_USERS is empty')
  if (!env.BANGUMI_TOKEN) throw nonRetryable('BANGUMI_TOKEN is empty')

  let run: SyncRun = {
    instance_id: event.instanceId,
    mode,
    source,
    status: 'queued',
    stage: 'initialize',
    started_at: nowSeconds(),
    heartbeat_at: nowSeconds(),
    completed_at: null,
    collection_pages: 0,
    subject_count: 0,
    refresh_jobs: 0,
    refresh_candidates: 0,
    refresh_candidates_by_priority: { new_or_changed: 0, hot: 0, cold: 0, retry: 0 },
    refresh_selected: 0,
    refresh_granted: 0,
    refresh_deferred: 0,
    refresh_confirmed: 0,
    refresh_uncertain: 0,
    refresh_skipped: 0,
    error: null,
  }

  try {
    await step.do('initialize', STORAGE_STEP, async () => {
      const generation = mode === 'live'
        ? (await coordinatorRequest<{ generation: number }>(env, '/allocate', { instance_id: event.instanceId })).generation
        : undefined
      run = { ...run, generation, status: 'running', heartbeat_at: nowSeconds() }
      await writeRun(env, run)
      if (mode === 'live') {
        await putJson(env.AIRING_CAL_KV, syncCurrentKey(), {
          instance_id: event.instanceId,
          generation,
          updated_at: run.heartbeat_at,
        })
      }
      return { key: syncRunKey(run.instance_id), count: 1, digest: await digest(run) }
    })
    const initializedRun = await getJson<SyncRun>(env.AIRING_CAL_KV, syncRunKey(run.instance_id))
    run = { ...run, ...initializedRun, status: 'running' }

    const client = new BgmClient(env.BANGUMI_TOKEN, { maxGetRetries: 0 })
    const pageOutputs: StepOutput[] = []
    const collectionGroups: Array<{ user_id: string; outputs: StepOutput[] }> = []
    for (let userIndex = 0; userIndex < users.length; userIndex++) {
      const username = users[userIndex]
      const userOutputs: StepOutput[] = []
      const first = await step.do(pageStepName(userIndex, 0), NETWORK_STEP, async () => {
        const page = await fetchCollectionPage(client, username, 0, nonRetryable)
        const key = syncStagingKey(event.instanceId, `collections:${userIndex}:0`)
        await putJson(env.AIRING_CAL_KV, key, page.data, SYNC_STAGING_TTL_SECONDS)
        run = { ...run, stage: 'collections', heartbeat_at: nowSeconds() }
        await writeRun(env, run)
        return { key, count: page.data.length, total: page.total, offset: 0, digest: await digest(page.data) }
      })
      run = { ...run, stage: 'collections' }
      pageOutputs.push(first)
      userOutputs.push(first)
      const pages = Math.ceil((first.total ?? 0) / PAGE_LIMIT)
      for (let pageIndex = 1; pageIndex < pages; pageIndex++) {
        const output = await step.do(pageStepName(userIndex, pageIndex), NETWORK_STEP, async () => {
          const page = await fetchCollectionPage(client, username, pageIndex * PAGE_LIMIT, nonRetryable)
          const key = syncStagingKey(event.instanceId, `collections:${userIndex}:${pageIndex}`)
          await putJson(env.AIRING_CAL_KV, key, page.data, SYNC_STAGING_TTL_SECONDS)
          run = { ...run, stage: 'collections', heartbeat_at: nowSeconds() }
          await writeRun(env, run)
          return {
            key,
            count: page.data.length,
            total: page.total,
            offset: pageIndex * PAGE_LIMIT,
            digest: await digest(page.data),
          }
        })
        run = { ...run, stage: 'collections' }
        pageOutputs.push(output)
        userOutputs.push(output)
      }
      collectionGroups.push({ user_id: username, outputs: userOutputs })
    }
    run = { ...run, collection_pages: pageOutputs.length }

    const calendarOutput = await step.do('fetch-calendar', NETWORK_STEP, async () => {
      const calendar = await fetchCalendar(client, nonRetryable)
      const key = syncStagingKey(event.instanceId, 'calendar')
      await putJson(env.AIRING_CAL_KV, key, calendar, SYNC_STAGING_TTL_SECONDS)
      run = { ...run, stage: 'calendar', heartbeat_at: nowSeconds() }
      await writeRun(env, run)
      return { key, count: calendarSubjectIds(calendar).length, digest: await digest(calendar) }
    })
    run = { ...run, stage: 'calendar' }

    const prepared = await step.do('prepare-snapshot-inputs', STORAGE_STEP, async () => {
      const groups = await Promise.all(collectionGroups.map(async (group) => ({
        pages: await Promise.all(group.outputs.map(async (output) => ({
          offset: output.offset ?? -1,
          total: output.total ?? -1,
          data: await (async () => {
            const data = await getJson<BgmCollection[]>(env.AIRING_CAL_KV, output.key)
            if (data !== null && await digest(data) !== output.digest) {
              throw new Error(`Staged collection digest mismatch: ${output.key}`)
            }
            return data
          })(),
        }))),
        pageLimit: PAGE_LIMIT,
        user_id: group.user_id,
      })))
      const stagedCalendar = await getJson(env.AIRING_CAL_KV, calendarOutput.key)
      if (stagedCalendar !== null && await digest(stagedCalendar) !== calendarOutput.digest) {
        throw new Error(`Staged calendar digest mismatch: ${calendarOutput.key}`)
      }
      const fetched = assembleFullFetch(
        groups,
        stagedCalendar,
        run.started_at,
      )
      const collections = fetched.collections.map(({ collection }) => collection)
      const { calendar } = fetched
      const merged = mergeCollections(collections)
      const snapshotKeys: Partial<Record<CollectionType, string>> = {}
      for (const type of COLLECTION_TYPES) {
        const key = syncStagingKey(event.instanceId, `snapshot:collections:${type}`)
        await putJson(env.AIRING_CAL_KV, key, merged[type], SYNC_STAGING_TTL_SECONDS)
        snapshotKeys[type] = key
      }
      const calendarInputKey = syncStagingKey(event.instanceId, 'snapshot:calendar-input')
      await putJson(env.AIRING_CAL_KV, calendarInputKey, calendar, SYNC_STAGING_TTL_SECONDS)
      const ids = [...new Set([...collections.map((entry) => entry.subject_id), ...calendarSubjectIds(calendar)])]
      const hotIds = new Set(collections.map((entry) => entry.subject_id))
      const titles = sourceTitles(collections, calendar)
      const images = sourceImages(collections, calendar)
      const refreshInputs = ids.map((subjectId): RefreshInput => ({
        subject_id: subjectId,
        title: titles.get(subjectId) ?? String(subjectId),
        hot: hotIds.has(subjectId),
        images: images.get(subjectId),
      }))
      const refreshInputKey = syncStagingKey(event.instanceId, 'refresh-inputs')
      await putJson(env.AIRING_CAL_KV, refreshInputKey, refreshInputs, SYNC_STAGING_TTL_SECONDS)
      const completeInputKey = syncStagingKey(event.instanceId, 'complete-input')
      await putJson(env.AIRING_CAL_KV, completeInputKey, fetched, SYNC_STAGING_TTL_SECONDS)
      const refreshChunks = Math.ceil(ids.length / REFRESH_CHUNK_SIZE)
      const key = syncStagingKey(event.instanceId, 'prepared')
      await putJson(env.AIRING_CAL_KV, key, {
        snapshotKeys,
        calendarInputKey,
        completeInputKey,
        refreshInputKey,
        refreshChunks,
        observedAt: fetched.observedAt,
      }, SYNC_STAGING_TTL_SECONDS)
      return {
        key,
        snapshotKeys,
        calendarInputKey,
        refreshInputKey,
        completeInputKey,
        refreshChunks,
        count: ids.length,
        digest: await digest(ids),
      }
    })
    const summary: Record<string, number> = {}
    const publishedOutputs: StepOutput[] = []

    for (const type of COLLECTION_TYPES) {
      const published = await step.do(`publish-${type}`, STORAGE_STEP, async () => {
        const value = await getJson<any[]>(env.AIRING_CAL_KV, prepared.snapshotKeys?.[type] ?? '') ?? []
        const key = targetSnapshotKey(mode, event.instanceId, `collections:${type}`)
        await putJson(env.AIRING_CAL_KV, key, value, mode === 'shadow' ? SYNC_RUN_TTL_SECONDS : undefined)
        run = { ...run, stage: 'snapshots', heartbeat_at: nowSeconds() }
        await writeRun(env, run)
        return { key, count: value.length, digest: await digest(value) }
      })
      run = { ...run, stage: 'snapshots' }
      summary[type] = published.count
      publishedOutputs.push(published)
    }
    summary._total = COLLECTION_TYPES.reduce((total, type) => total + (summary[type] ?? 0), 0)
    publishedOutputs.push(await step.do('publish-summary', STORAGE_STEP, async () => {
      const key = targetSnapshotKey(mode, event.instanceId, 'summary')
      await putJson(env.AIRING_CAL_KV, key, summary, mode === 'shadow' ? SYNC_RUN_TTL_SECONDS : undefined)
      return { key, count: summary._total, digest: await digest(summary) }
    }))
    publishedOutputs.push(await step.do('publish-calendar', STORAGE_STEP, async () => {
      const calendar = await getJson<any[]>(env.AIRING_CAL_KV, prepared.calendarInputKey) ?? []
      const snapshot = transformCalendar(calendar)
      const key = targetSnapshotKey(mode, event.instanceId, 'calendar')
      await putJson(env.AIRING_CAL_KV, key, snapshot, mode === 'shadow' ? SYNC_RUN_TTL_SECONDS : undefined)
      return { key, count: calendarSubjectIds(calendar).length, digest: await digest(snapshot) }
    }))
    if (mode === 'shadow') await step.do('publish-shadow-audit', STORAGE_STEP, async () => {
      const key = syncShadowKey(event.instanceId, 'audit')
      const value = { instance_id: event.instanceId, mode, subject_count: summary._total, published_at: nowSeconds() }
      await putJson(env.AIRING_CAL_KV, key, value, SYNC_RUN_TTL_SECONDS)
      return { key, count: 1, digest: await digest(value) }
    })

    if (mode === 'shadow' && env.AIRING_CAL_D1) {
      await step.do('persist-d1-shadow', STORAGE_STEP, async () => {
        const completeInput = await getJson<ReturnType<typeof assembleFullFetch>>(
          env.AIRING_CAL_KV,
          prepared.completeInputKey ?? '',
        )
        if (completeInput?.complete !== true) throw new Error('Missing complete D1 sync input')
        const runner = dependencies.runD1IncrementalSync ?? runD1IncrementalSync
        const result: D1SyncResult = await runner({
          env,
          instanceId: event.instanceId,
          completeInput,
          now: completeInput.observedAt,
        })
        if (dependencies.publication) {
          const publisher = dependencies.publishPublicSnapshot ?? publishPublicSnapshot
          const publication = await publisher({
            ...dependencies.publication,
            input: result.publicationInput,
            now: completeInput.observedAt,
            sourceObservedAt: completeInput.observedAt,
            publicationId: event.instanceId,
          })
          if (publication.status === 'pending') {
            throw new Error('Public snapshot publication remains pending')
          }
        }
        return {
          key: syncRunKey(event.instanceId),
          count: result.rowsWritten,
          digest: result.publicationInput.content_hash,
        }
      })
    }

    const planOutputs: StepOutput[] = []
    for (let chunkIndex = 0; mode === 'live' && chunkIndex < (prepared.refreshChunks ?? 0); chunkIndex++) {
      const output = await step.do(`plan-refresh-${chunkIndex}`, STORAGE_STEP, async () => {
        const allInputs = await getJson<RefreshInput[]>(env.AIRING_CAL_KV, prepared.refreshInputKey ?? '') ?? []
        const inputs = allInputs.slice(chunkIndex * REFRESH_CHUNK_SIZE, (chunkIndex + 1) * REFRESH_CHUNK_SIZE)
        const planned = await Promise.all(inputs.map(async (input) => {
          try {
            const cached = {
              detail: await getJson<any>(env.AIRING_CAL_KV, subjectDetailKey(input.subject_id)),
              meta: await getJson<any>(env.AIRING_CAL_KV, subjectMetaKey(input.subject_id)),
              image: await getJson<any>(env.AIRING_CAL_KV, imageStatusKey(input.subject_id)),
              refresh: await getJson<any>(env.AIRING_CAL_KV, subjectRefreshKey(input.subject_id)),
            }
            return { candidate: planSubjectRefresh(input, cached, nowSeconds()) }
          } catch (error) {
            return {
              candidate: null,
              planning_error: {
                subject_id: input.subject_id,
                error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
              },
            }
          }
        }))
        const candidates = planned.flatMap(({ candidate }) => candidate ? [candidate] : [])
        const planningErrors = planned.flatMap(({ planning_error }) => planning_error ? [planning_error] : [])
        const key = syncStagingKey(event.instanceId, `refresh:${chunkIndex}`)
        await putJson(env.AIRING_CAL_KV, key, candidates, SYNC_STAGING_TTL_SECONDS)
        run = { ...run, stage: 'refresh_plan', heartbeat_at: nowSeconds() }
        await writeRun(env, run)
        return { key, count: candidates.length, candidates, planning_errors: planningErrors, digest: await digest(candidates) }
      })
      planOutputs.push(output)
      run = { ...run, stage: 'refresh_plan' }
    }

    if (mode === 'live') {
      const utcDay = new Date(run.started_at * 1000).toISOString().slice(0, 10)
      const selection = selectRefreshCandidates(planOutputs.flatMap((output) => output.candidates ?? []), utcDay, {
        soft: 50,
        hard: 100,
      })
      run = {
        ...run,
        subject_count: prepared.count,
        refresh_candidates: selection.candidates,
        refresh_candidates_by_priority: selection.by_priority,
        refresh_selected: selection.selected.length,
        refresh_deferred: selection.candidates,
        refresh_skipped: Math.max(0, prepared.count - selection.candidates),
      }
      const jobs: MediaRefreshJobV3[] = selection.selected.map((candidate) => ({
        version: 3,
        generation: run.generation ?? 0,
        job_id: `${event.instanceId}:${candidate.subject_id}`,
        subject_id: candidate.subject_id,
        title: candidate.title,
        components: candidate.components,
        images: candidate.images,
      }))
      let reservation: {
        granted: number
        consumed: number
        soft_limit: number
        hard_limit: number
        submission: 'confirmed' | 'uncertain' | 'not_needed'
      } = {
        granted: 0,
        consumed: 0,
        soft_limit: 50,
        hard_limit: 100,
        submission: 'not_needed',
      }
      if (selection.selected.length > 0) {
        reservation = await step.do('reserve-media', STORAGE_STEP, async () => {
          const result = await coordinatorRequest<typeof reservation>(env, '/reserve-media', {
            date: utcDay,
            reservation_id: `${event.instanceId}:media`,
            requested: selection.selected.length,
            privileged_requested: selection.selected.filter((candidate) => candidate.priority === 'new_or_changed').length,
            jobs,
          })
          return result
        })
      }
      run = {
        ...run,
        stage: 'enqueue',
        heartbeat_at: nowSeconds(),
        refresh_jobs: reservation.granted,
        refresh_granted: reservation.granted,
        refresh_deferred: Math.max(0, selection.candidates - reservation.granted),
        refresh_confirmed: reservation.submission === 'confirmed' ? reservation.granted : 0,
        refresh_uncertain: reservation.submission === 'uncertain' ? reservation.granted : 0,
      }

      await step.do('commit-live-snapshot', STORAGE_STEP, async () => {
        const manifest: SnapshotManifest = {
          instance_id: event.instanceId,
          generation: run.generation ?? 0,
          mode: 'live',
          published_at: nowSeconds(),
          subject_count: prepared.count,
          required_keys: publishedOutputs.map((output) => output.key),
          digests: Object.fromEntries(publishedOutputs.map((output) => [output.key, output.digest])),
        }
        await coordinatorRequest(env, '/commit', { generation: manifest.generation, manifest })
        return { key: snapshotActiveKey(), count: 1, digest: await digest(manifest) }
      })
    }

    await step.do('finalize', STORAGE_STEP, async () => {
      const completedAt = nowSeconds()
      run = {
        ...run,
        status: 'ok',
        stage: 'complete',
        heartbeat_at: completedAt,
        completed_at: completedAt,
        subject_count: prepared.count,
        refresh_skipped: Math.max(0, prepared.count - run.refresh_candidates),
      }
      await writeRun(env, run)
      const currentMeta = await getJson<Record<string, unknown>>(env.AIRING_CAL_KV, syncMetaKey()) ?? {}
      await putJson(env.AIRING_CAL_KV, syncMetaKey(), {
        ...currentMeta,
        workflow_instance_id: event.instanceId,
        workflow_stage: 'complete',
        workflow_completed_at: completedAt,
      })
      return { key: syncRunKey(event.instanceId), count: 1, digest: await digest(run) }
    })

    return {
      instance_id: event.instanceId,
      status: 'ok',
      subject_count: prepared.count,
      refresh_jobs: run.refresh_jobs,
      refresh_candidates: run.refresh_candidates,
      refresh_candidates_by_priority: run.refresh_candidates_by_priority,
      refresh_selected: run.refresh_selected,
      refresh_granted: run.refresh_granted,
      refresh_deferred: run.refresh_deferred,
      refresh_confirmed: run.refresh_confirmed,
      refresh_uncertain: run.refresh_uncertain,
      refresh_skipped: run.refresh_skipped,
    }
  } catch (error) {
    await step.do('record-error', STORAGE_STEP, async () => {
      const completedAt = nowSeconds()
      run = {
        ...run,
        status: 'error',
        heartbeat_at: completedAt,
        completed_at: completedAt,
        error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
      }
      await writeRun(env, run)
      const currentMeta = await getJson<Record<string, unknown>>(env.AIRING_CAL_KV, syncMetaKey()) ?? {}
      await putJson(env.AIRING_CAL_KV, syncMetaKey(), {
        ...currentMeta,
        workflow_instance_id: event.instanceId,
        workflow_stage: run.stage,
        workflow_error: run.error,
      })
      return { key: syncRunKey(event.instanceId), count: 1, digest: await digest(run) }
    })
    throw error
  }
}
