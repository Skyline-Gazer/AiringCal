interface CoordinatorStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
}

type BeginResult = { status: 'process' | 'obsolete' | 'duplicate'; generation: number }

const LAST_GENERATION_KEY = 'lastCompletedGeneration'
const LAST_JOB_KEY = 'lastCompletedJob'

export class SubjectRefreshCoordinatorCore {
  constructor(private storage: CoordinatorStorage) {}

  async begin(generation: number, jobId: string): Promise<BeginResult> {
    const lastGeneration = await this.storage.get<number>(LAST_GENERATION_KEY)
    if (lastGeneration !== undefined && generation < lastGeneration) return { status: 'obsolete', generation }
    const lastJob = await this.storage.get<string>(LAST_JOB_KEY)
    if (lastGeneration === generation && lastJob === jobId) return { status: 'duplicate', generation }
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

  constructor(state: DurableObjectState, private env: MediaEnv) {
    this.core = new SubjectRefreshCoordinatorCore(state.storage)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const body = await request.json<Record<string, unknown>>()
    if (url.pathname === '/process') {
      const job = body as unknown as MediaJob
      if (typeof job.subject_id !== 'number') return Response.json({ error: 'Invalid coordinator request' }, { status: 400 })
      const generation = (job as Partial<MediaRefreshJobV3>).version === 3
        ? (job as MediaRefreshJobV3).generation
        : 0
      const jobId = 'job_id' in job && typeof job.job_id === 'string' ? job.job_id : `legacy:${job.subject_id}`
      const decision = await this.core.begin(generation, jobId)
      if (decision.status !== 'process') return Response.json(decision)
      try {
        const status = await processJob(job, this.env)
        await this.core.complete(generation, jobId)
        return Response.json({ status, generation })
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 })
      }
    }
    if (typeof body.generation !== 'number' || typeof body.job_id !== 'string') {
      return Response.json({ error: 'Invalid coordinator request' }, { status: 400 })
    }
    if (url.pathname === '/begin') return Response.json(await this.core.begin(body.generation, body.job_id))
    if (url.pathname === '/complete') {
      await this.core.complete(body.generation, body.job_id)
      return Response.json({ status: 'completed', generation: body.generation })
    }
    return Response.json({ error: 'Invalid coordinator request' }, { status: 400 })
  }
}
import type { MediaRefreshJobV3 } from '@airing-cal/storage'
import { processJob, type MediaEnv, type MediaJob } from './index.ts'
