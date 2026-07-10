import { BgmClient, BgmHttpError, type BgmCollection } from '@airing-cal/bgm-api'
import { mergeCollections, subjectDetailImages, transformCalendar } from '@airing-cal/domain'
import {
  imageStatusKey,
  nextSubjectRefreshAt,
  subjectDetailKey,
  subjectMetaKey,
  subjectRefreshKey,
  syncMetaKey,
  syncRunKey,
  syncShadowKey,
  syncStagingKey,
  SYNC_RUN_TTL_SECONDS,
  SYNC_STAGING_TTL_SECONDS,
  type CollectionType,
  type MediaRefreshJobV2,
  type SubjectDetailCacheEntry,
  type SubjectRefreshState,
  type SyncRun,
  type SyncWorkflowParams,
} from '@airing-cal/storage'
import { sanitizeErrorMessage } from '@airing-cal/worker-common'

const COLLECTION_TYPES: CollectionType[] = ['want', 'watched', 'watching', 'on_hold', 'dropped']
const PAGE_LIMIT = 50
const REFRESH_CHUNK_SIZE = 25
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
    sendBatch(messages: Array<{ body: MediaRefreshJobV2; contentType?: 'json' }>): Promise<void>
  }
  BANGUMI_TOKEN: string
  BANGUMI_USERS: string
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
  keys?: string[]
  snapshotKeys?: Partial<Record<CollectionType, string>>
}

interface RefreshInput {
  subject_id: number
  title: string
  images?: { common?: string; large?: string }
}

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

function pageStepName(userIndex: number, page: number): string {
  return userIndex === 0 ? `fetch-collections-page-${page}` : `fetch-collections-user-${userIndex}-page-${page}`
}

function versionSnapshotKey(instanceId: string, suffix: string): string {
  return `snapshot:version:${instanceId}:${suffix}`
}

function targetSnapshotKey(mode: 'shadow' | 'live', instanceId: string, suffix: string): string {
  return mode === 'shadow' ? syncShadowKey(instanceId, suffix) : versionSnapshotKey(instanceId, suffix)
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
): Promise<{ instance_id: string; status: 'ok'; subject_count: number; refresh_jobs: number }> {
  const scheduled = Boolean(event.schedule)
  const mode = scheduled ? 'live' : event.payload?.mode
  if (mode !== 'shadow' && mode !== 'live') throw nonRetryable('Manual workflow requires mode shadow or live')
  const source = scheduled ? 'schedule' : 'manual'
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
    error: null,
  }

  try {
    await step.do('initialize', STORAGE_STEP, async () => {
      run = { ...run, status: 'running', heartbeat_at: nowSeconds() }
      await writeRun(env, run)
      return { key: syncRunKey(run.instance_id), count: 1, digest: await digest(run) }
    })
    run = { ...run, status: 'running' }

    const client = new BgmClient(env.BANGUMI_TOKEN, { maxGetRetries: 0 })
    const pageOutputs: StepOutput[] = []
    for (let userIndex = 0; userIndex < users.length; userIndex++) {
      const username = users[userIndex]
      const first = await step.do(pageStepName(userIndex, 0), NETWORK_STEP, async () => {
        const page = await fetchCollectionPage(client, username, 0, nonRetryable)
        const key = syncStagingKey(event.instanceId, `collections:${userIndex}:0`)
        await putJson(env.AIRING_CAL_KV, key, page.data, SYNC_STAGING_TTL_SECONDS)
        run = { ...run, stage: 'collections', heartbeat_at: nowSeconds() }
        await writeRun(env, run)
        return { key, count: page.data.length, total: page.total, digest: await digest(page.data) }
      })
      run = { ...run, stage: 'collections' }
      pageOutputs.push(first)
      const pages = Math.ceil((first.total ?? 0) / PAGE_LIMIT)
      for (let pageIndex = 1; pageIndex < pages; pageIndex++) {
        const output = await step.do(pageStepName(userIndex, pageIndex), NETWORK_STEP, async () => {
          const page = await fetchCollectionPage(client, username, pageIndex * PAGE_LIMIT, nonRetryable)
          const key = syncStagingKey(event.instanceId, `collections:${userIndex}:${pageIndex}`)
          await putJson(env.AIRING_CAL_KV, key, page.data, SYNC_STAGING_TTL_SECONDS)
          run = { ...run, stage: 'collections', heartbeat_at: nowSeconds() }
          await writeRun(env, run)
          return { key, count: page.data.length, digest: await digest(page.data) }
        })
        run = { ...run, stage: 'collections' }
        pageOutputs.push(output)
      }
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
      const collectionPages = await Promise.all(pageOutputs.map((output) => getJson<BgmCollection[]>(env.AIRING_CAL_KV, output.key)))
      const collections = collectionPages.flatMap((page) => page ?? [])
      const calendar = await getJson<any[]>(env.AIRING_CAL_KV, calendarOutput.key) ?? []
      const merged = mergeCollections(collections)
      const snapshotKeys: Partial<Record<CollectionType, string>> = {}
      for (const type of COLLECTION_TYPES) {
        const key = syncStagingKey(event.instanceId, `snapshot:collections:${type}`)
        await putJson(env.AIRING_CAL_KV, key, merged[type], SYNC_STAGING_TTL_SECONDS)
        snapshotKeys[type] = key
      }
      const ids = [...new Set([...collections.map((entry) => entry.subject_id), ...calendarSubjectIds(calendar)])]
      const titles = sourceTitles(collections, calendar)
      const images = sourceImages(collections, calendar)
      const keys: string[] = []
      for (let index = 0; index < ids.length; index += REFRESH_CHUNK_SIZE) {
        const chunkIndex = index / REFRESH_CHUNK_SIZE
        const inputs = ids.slice(index, index + REFRESH_CHUNK_SIZE).map((subjectId): RefreshInput => ({
          subject_id: subjectId,
          title: titles.get(subjectId) ?? String(subjectId),
          images: images.get(subjectId),
        }))
        const key = syncStagingKey(event.instanceId, `refresh-input:${chunkIndex}`)
        await putJson(env.AIRING_CAL_KV, key, inputs, SYNC_STAGING_TTL_SECONDS)
        keys.push(key)
      }
      const key = syncStagingKey(event.instanceId, 'prepared')
      await putJson(env.AIRING_CAL_KV, key, { snapshotKeys, refreshKeys: keys }, SYNC_STAGING_TTL_SECONDS)
      return { key, keys, snapshotKeys, count: ids.length, digest: await digest(ids) }
    })
    const summary: Record<string, number> = {}

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
    }
    summary._total = COLLECTION_TYPES.reduce((total, type) => total + (summary[type] ?? 0), 0)
    await step.do('publish-summary', STORAGE_STEP, async () => {
      const key = targetSnapshotKey(mode, event.instanceId, 'summary')
      await putJson(env.AIRING_CAL_KV, key, summary, mode === 'shadow' ? SYNC_RUN_TTL_SECONDS : undefined)
      return { key, count: summary._total, digest: await digest(summary) }
    })
    await step.do('publish-calendar', STORAGE_STEP, async () => {
      const calendar = await getJson<any[]>(env.AIRING_CAL_KV, calendarOutput.key) ?? []
      const snapshot = transformCalendar(calendar)
      const key = targetSnapshotKey(mode, event.instanceId, 'calendar')
      await putJson(env.AIRING_CAL_KV, key, snapshot, mode === 'shadow' ? SYNC_RUN_TTL_SECONDS : undefined)
      return { key, count: calendarSubjectIds(calendar).length, digest: await digest(snapshot) }
    })
    await step.do(mode === 'live' ? 'commit-live-snapshot' : 'publish-shadow-audit', STORAGE_STEP, async () => {
      const key = mode === 'live' ? 'snapshot:active' : syncShadowKey(event.instanceId, 'audit')
      const value = { instance_id: event.instanceId, mode, subject_count: summary._total, published_at: nowSeconds() }
      await putJson(env.AIRING_CAL_KV, key, value, mode === 'shadow' ? SYNC_RUN_TTL_SECONDS : undefined)
      return { key, count: 1, digest: await digest(value) }
    })

    const planOutputs: StepOutput[] = []
    let refreshJobs = 0
    for (let chunkIndex = 0; chunkIndex < (prepared.keys?.length ?? 0); chunkIndex++) {
      const inputKey = prepared.keys![chunkIndex]
      const output = await step.do(`plan-refresh-${chunkIndex}`, STORAGE_STEP, async () => {
        const inputs = await getJson<RefreshInput[]>(env.AIRING_CAL_KV, inputKey) ?? []
        const jobs: MediaRefreshJobV2[] = []
        const now = nowSeconds()
        for (const input of inputs) {
          const subjectId = input.subject_id
          const [detail, meta, image, refresh] = await Promise.all([
            getJson<SubjectDetailCacheEntry>(env.AIRING_CAL_KV, subjectDetailKey(subjectId)),
            getJson<unknown>(env.AIRING_CAL_KV, subjectMetaKey(subjectId)),
            getJson<any>(env.AIRING_CAL_KV, imageStatusKey(subjectId)),
            getJson<SubjectRefreshState>(env.AIRING_CAL_KV, subjectRefreshKey(subjectId)),
          ])
          if (refresh && (refresh.status === 'queued' || refresh.status === 'running')) continue
          const detailDue = !detail || nextSubjectRefreshAt(subjectId, detail.cached_at) <= now
          const components: MediaRefreshJobV2['components'] = []
          if (detailDue) components.push('detail')
          if (detailDue || !meta) components.push('meta')
          if (detailDue || image?.common?.status !== 'cached') components.push('image_common')
          if (detailDue || image?.large?.status !== 'cached') components.push('image_large')
          if (!components.length) continue
          jobs.push({
            version: 2,
            job_id: `${event.instanceId}:${subjectId}`,
            subject_id: subjectId,
            title: input.title,
            components,
            images: input.images,
          })
        }
        const key = syncStagingKey(event.instanceId, `refresh:${chunkIndex}`)
        await putJson(env.AIRING_CAL_KV, key, jobs, SYNC_STAGING_TTL_SECONDS)
        run = { ...run, stage: 'refresh_plan', heartbeat_at: nowSeconds() }
        await writeRun(env, run)
        return { key, count: jobs.length, digest: await digest(jobs) }
      })
      planOutputs.push(output)
      refreshJobs += output.count
      run = { ...run, stage: 'refresh_plan' }
    }

    if (mode === 'live') {
      for (let index = 0; index < planOutputs.length; index += 4) {
        const batchIndex = index / 4
        const outputs = planOutputs.slice(index, index + 4)
        await step.do(`enqueue-refresh-${batchIndex}`, STORAGE_STEP, async () => {
          const groups = await Promise.all(outputs.map((output) => getJson<MediaRefreshJobV2[]>(env.AIRING_CAL_KV, output.key)))
          const jobs = groups.flatMap((group) => group ?? [])
          const queuedAt = nowSeconds()
          for (const job of jobs) {
            await putJson(env.AIRING_CAL_KV, subjectRefreshKey(job.subject_id), {
              subject_id: job.subject_id,
              job_id: job.job_id,
              status: 'queued',
              queued_at: queuedAt,
              updated_at: queuedAt,
              completed_at: null,
              error: null,
            } satisfies SubjectRefreshState)
          }
          if (jobs.length) await env.MEDIA_QUEUE.sendBatch(jobs.map((body) => ({ body, contentType: 'json' as const })))
          run = { ...run, stage: 'enqueue', heartbeat_at: nowSeconds() }
          await writeRun(env, run)
          return { key: outputs[0]?.key ?? syncStagingKey(event.instanceId, `refresh:${index}`), count: jobs.length, digest: await digest(jobs.map((job) => job.job_id)) }
        })
        run = { ...run, stage: 'enqueue' }
      }
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
        refresh_jobs: refreshJobs,
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

    return { instance_id: event.instanceId, status: 'ok', subject_count: prepared.count, refresh_jobs: refreshJobs }
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
