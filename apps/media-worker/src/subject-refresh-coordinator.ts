import { KVStorage, putJsonIfChanged, subjectRefreshKey, type MediaRefreshJobV2, type MediaRefreshJobV3, type SubjectRefreshState } from '@airing-cal/storage'
import { sanitizeErrorMessage } from '@airing-cal/worker-common'
import { processJob, type MediaEnv, type MediaJob } from './index.ts'

interface CoordinatorStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
}

type BeginResult = { status: 'process' | 'obsolete' | 'duplicate'; generation: number }

const LAST_GENERATION_KEY = 'lastCompletedGeneration'
const LAST_JOB_KEY = 'lastCompletedJob'
const HIGHEST_ACCEPTED_GENERATION_KEY = 'highestAcceptedGeneration'

export class SubjectRefreshCoordinatorCore {
  constructor(private storage: CoordinatorStorage) {}

  async begin(generation: number, jobId: string): Promise<BeginResult> {
    const highestAcceptedGeneration = await this.storage.get<number>(HIGHEST_ACCEPTED_GENERATION_KEY)
    if (highestAcceptedGeneration !== undefined && generation < highestAcceptedGeneration) return { status: 'obsolete', generation }
    const lastGeneration = await this.storage.get<number>(LAST_GENERATION_KEY)
    if (lastGeneration !== undefined && generation < lastGeneration) return { status: 'obsolete', generation }
    const lastJob = await this.storage.get<string>(LAST_JOB_KEY)
    if (lastGeneration === generation && lastJob === jobId) return { status: 'duplicate', generation }
    if (highestAcceptedGeneration === undefined || generation > highestAcceptedGeneration) {
      await this.storage.put(HIGHEST_ACCEPTED_GENERATION_KEY, generation)
    }
    return { status: 'process', generation }
  }

  async complete(generation: number, jobId: string): Promise<void> {
    const lastGeneration = await this.storage.get<number>(LAST_GENERATION_KEY)
    if (lastGeneration !== undefined && generation < lastGeneration) return
    await this.storage.put(LAST_GENERATION_KEY, generation)
    await this.storage.put(LAST_JOB_KEY, jobId)
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
    const generation = (job as Partial<MediaRefreshJobV3>).version === 3 ? (job as MediaRefreshJobV3).generation : 0
    const jobId = 'job_id' in job && typeof job.job_id === 'string' ? job.job_id : `legacy:${job.subject_id}`
    const decision = await this.core.begin(generation, jobId)
    if (decision.status !== 'process') return Response.json(decision)
    try {
      const status = await processJob(job, this.env)
      await this.core.complete(generation, jobId)
      return Response.json({ status, generation })
    } catch (error) {
      const safeError = sanitizeErrorMessage(error instanceof Error ? error.message : String(error))
      if ('version' in job && (job.version === 2 || job.version === 3)) {
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
