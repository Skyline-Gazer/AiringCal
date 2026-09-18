import { hasUnsupportedMediaJobVersion, isMediaRefreshJobV2, isMediaRefreshJobV3, isMediaRefreshJobV4, KVStorage, putJsonIfChanged, subjectRefreshKey, type MediaRefreshJobV2, type MediaRefreshJobV3, type MediaRefreshJobV4Generation, type SubjectRefreshState } from '@airing-cal/storage'
import { sanitizeErrorMessage } from '@airing-cal/worker-common'
import { processJob, type MediaEnv, type MediaJob } from './index.ts'

interface CoordinatorStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
}

type FenceNamespace = 'legacy' | 'v4'
type FenceGeneration = number | MediaRefreshJobV4Generation
type BeginResult = { status: 'process' | 'obsolete' | 'duplicate'; generation: FenceGeneration }

const LAST_GENERATION_KEY = 'lastCompletedGeneration'
const LAST_JOB_KEY = 'lastCompletedJob'
const HIGHEST_ACCEPTED_GENERATION_KEY = 'highestAcceptedGeneration'

function fenceKey(key: string, namespace: FenceNamespace): string {
  return namespace === 'legacy' ? key : `v4:${key}`
}

function compareV4Generation(left: MediaRefreshJobV4Generation, right: MediaRefreshJobV4Generation): number {
  if (left.observed_at !== right.observed_at) return left.observed_at < right.observed_at ? -1 : 1
  if (left.run_id === right.run_id) return 0
  return left.run_id < right.run_id ? -1 : 1
}

function compareGeneration(namespace: FenceNamespace, left: FenceGeneration, right: FenceGeneration): number {
  if (namespace === 'legacy') return (left as number) - (right as number)
  return compareV4Generation(left as MediaRefreshJobV4Generation, right as MediaRefreshJobV4Generation)
}

export class SubjectRefreshCoordinatorCore {
  constructor(private storage: CoordinatorStorage) {}

  async begin(generation: FenceGeneration, jobId: string, namespace: FenceNamespace = 'legacy'): Promise<BeginResult> {
    const highestKey = fenceKey(HIGHEST_ACCEPTED_GENERATION_KEY, namespace)
    const lastGenerationKey = fenceKey(LAST_GENERATION_KEY, namespace)
    const lastJobKey = fenceKey(LAST_JOB_KEY, namespace)
    const highestAcceptedGeneration = await this.storage.get<FenceGeneration>(highestKey)
    if (highestAcceptedGeneration !== undefined && compareGeneration(namespace, generation, highestAcceptedGeneration) < 0) {
      return { status: 'obsolete', generation }
    }
    const lastGeneration = await this.storage.get<FenceGeneration>(lastGenerationKey)
    if (lastGeneration !== undefined && compareGeneration(namespace, generation, lastGeneration) < 0) {
      return { status: 'obsolete', generation }
    }
    const lastJob = await this.storage.get<string>(lastJobKey)
    if (lastGeneration !== undefined && compareGeneration(namespace, generation, lastGeneration) === 0 && lastJob === jobId) {
      return { status: 'duplicate', generation }
    }
    if (highestAcceptedGeneration === undefined || compareGeneration(namespace, generation, highestAcceptedGeneration) > 0) {
      await this.storage.put(highestKey, generation)
    }
    return { status: 'process', generation }
  }

  async complete(generation: FenceGeneration, jobId: string, namespace: FenceNamespace = 'legacy'): Promise<void> {
    const lastGenerationKey = fenceKey(LAST_GENERATION_KEY, namespace)
    const lastJobKey = fenceKey(LAST_JOB_KEY, namespace)
    const lastGeneration = await this.storage.get<FenceGeneration>(lastGenerationKey)
    if (lastGeneration !== undefined && compareGeneration(namespace, generation, lastGeneration) < 0) return
    await this.storage.put(lastGenerationKey, generation)
    await this.storage.put(lastJobKey, jobId)
  }
}

export class SubjectRefreshCoordinator {
  private core: SubjectRefreshCoordinatorCore
  private tail: Promise<void> = Promise.resolve()

  constructor(state: DurableObjectState, private env: MediaEnv) {
    this.core = new SubjectRefreshCoordinatorCore(state.storage)
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async process(job: MediaJob): Promise<Response> {
    if (typeof job.subject_id !== 'number') return Response.json({ error: 'Invalid coordinator request' }, { status: 400 })
    if (hasUnsupportedMediaJobVersion(job)) {
      return Response.json({ error: 'Invalid coordinator request' }, { status: 400 })
    }
    const v4 = isMediaRefreshJobV4(job)
    const generation = isMediaRefreshJobV3(job) || v4 ? job.generation : 0
    const namespace: FenceNamespace = v4 ? 'v4' : 'legacy'
    const jobId = 'job_id' in job && typeof job.job_id === 'string' ? job.job_id : `legacy:${job.subject_id}`
    const decision = await this.core.begin(generation, jobId, namespace)
    if (decision.status !== 'process') return Response.json(decision)
    try {
      const status = await processJob(job, this.env)
      if (status === 'retry_scheduled') {
        return Response.json({ status, generation }, { status: 503 })
      }
      await this.core.complete(generation, jobId, namespace)
      return Response.json({ status, generation })
    } catch (error) {
      const safeError = sanitizeErrorMessage(error instanceof Error ? error.message : String(error))
      if (
        isMediaRefreshJobV2(job)
        || isMediaRefreshJobV3(job)
      ) {
        const versioned = job as MediaRefreshJobV2 | MediaRefreshJobV3
        const storage = new KVStorage(this.env.AIRING_CAL_KV)
        const now = Math.floor(Date.now() / 1000)
        const previous = await storage.get<SubjectRefreshState>(subjectRefreshKey(job.subject_id))
        await putJsonIfChanged(storage, subjectRefreshKey(job.subject_id), {
          subject_id: job.subject_id,
          job_id: versioned.job_id,
          ...('generation' in versioned ? { generation: versioned.generation } : {}),
          status: 'failed',
          queued_at: previous?.job_id === versioned.job_id ? previous.queued_at : now,
          updated_at: now,
          completed_at: now,
          error: safeError,
        } satisfies SubjectRefreshState, (value) => value)
      }
      return Response.json({ error: safeError }, { status: 503 })
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const body = await request.json<Record<string, unknown>>()
    if (url.pathname === '/process') {
      return this.serialized(() => this.process(body as unknown as MediaJob))
    }
    if (typeof body.generation !== 'number' || typeof body.job_id !== 'string') {
      return Response.json({ error: 'Invalid coordinator request' }, { status: 400 })
    }
    if (url.pathname === '/begin') return this.serialized(async () => Response.json(await this.core.begin(body.generation as number, body.job_id as string)))
    if (url.pathname === '/complete') {
      return this.serialized(async () => {
        await this.core.complete(body.generation as number, body.job_id as string)
        return Response.json({ status: 'completed', generation: body.generation })
      })
    }
    return Response.json({ error: 'Invalid coordinator request' }, { status: 400 })
  }
}
