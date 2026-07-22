import { snapshotActiveKey, type MediaRefreshJobV3, type SnapshotManifest } from '@airing-cal/storage'

interface CoordinatorStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean | void>
}

interface JsonKV {
  put(key: string, value: string): Promise<void>
}

interface SnapshotCoordinatorEnv {
  AIRING_CAL_KV: JsonKV
  MEDIA_QUEUE: {
    sendBatch(messages: Array<{ body: MediaRefreshJobV3; contentType?: 'json' }>): Promise<unknown>
  }
}

type CommitResult = { status: 'committed' | 'obsolete'; generation: number }
type MediaBudgetResult = { granted: number; consumed: number; soft_limit: number; hard_limit: number }
type MediaReservation = {
  date: string
  budget_date?: string
  requested: number
  privileged_requested: number
  job_ids: string[]
  result: MediaBudgetResult
  submission?: 'reserved' | 'confirmed' | 'uncertain' | 'not_needed'
}

const NEXT_GENERATION_KEY = 'nextGeneration'
const INSTANCE_PREFIX = 'instance:'
const LAST_COMMITTED_KEY = 'lastCommittedGeneration'
const LAST_MANIFEST_KEY = 'lastCommittedManifest'
const MEDIA_BUDGET_KEY = 'mediaBudget'
const MEDIA_RESERVATION_PREFIX = 'mediaReservation:'
const MEDIA_SOFT_LIMIT = 50
const MEDIA_HARD_LIMIT = 100

export class SnapshotCoordinatorCore {
  constructor(
    private storage: CoordinatorStorage,
    private kv: JsonKV,
    private queue?: SnapshotCoordinatorEnv['MEDIA_QUEUE'],
    private clock: () => number = () => Date.now(),
  ) {}

  async allocate(instanceId: string): Promise<number> {
    const instanceKey = `${INSTANCE_PREFIX}${instanceId}`
    const existing = await this.storage.get<number>(instanceKey)
    if (existing !== undefined) return existing
    const generation = (await this.storage.get<number>(NEXT_GENERATION_KEY) ?? 0) + 1
    await this.storage.put(NEXT_GENERATION_KEY, generation)
    await this.storage.put(instanceKey, generation)
    return generation
  }

  async commit(generation: number, manifest: SnapshotManifest): Promise<CommitResult> {
    const lastGeneration = await this.storage.get<number>(LAST_COMMITTED_KEY) ?? 0
    if (generation < lastGeneration) return { status: 'obsolete', generation }
    if (generation === lastGeneration) {
      const lastManifest = await this.storage.get<SnapshotManifest>(LAST_MANIFEST_KEY)
      return {
        status: lastManifest?.instance_id === manifest.instance_id ? 'committed' : 'obsolete',
        generation,
      }
    }
    await this.kv.put(snapshotActiveKey(), JSON.stringify(manifest))
    await this.storage.put(LAST_COMMITTED_KEY, generation)
    await this.storage.put(LAST_MANIFEST_KEY, manifest)
    return { status: 'committed', generation }
  }

  async reserveMedia(
    date: string,
    reservationId: string,
    requested: number,
    privilegedRequested: number,
    jobs: MediaRefreshJobV3[],
  ): Promise<MediaBudgetResult> {
    const reservationKey = `${MEDIA_RESERVATION_PREFIX}${reservationId}`
    const jobIds = jobs.map(({ job_id }) => job_id)
    const existing = await this.storage.get<MediaReservation>(reservationKey)
    if (existing) {
      if (
        existing.date !== date
        || existing.requested !== requested
        || existing.privileged_requested !== privilegedRequested
        || existing.job_ids.length !== jobIds.length
        || existing.job_ids.some((jobId, index) => jobId !== jobIds[index])
      ) throw new Error(`Media reservation ${reservationId} payload mismatch`)
      return existing.result
    }

    const budgetDate = new Date(this.clock()).toISOString().slice(0, 10)
    const previous = await this.storage.get<{ date: string; consumed: number }>(MEDIA_BUDGET_KEY)
    const consumed = previous?.date === budgetDate ? previous.consumed : 0
    if (previous && budgetDate < previous.date) {
      const result = {
        granted: 0,
        consumed: previous.consumed,
        soft_limit: MEDIA_SOFT_LIMIT,
        hard_limit: MEDIA_HARD_LIMIT,
      }
      await this.storage.put(reservationKey, {
        date,
        budget_date: budgetDate,
        requested,
        privileged_requested: privilegedRequested,
        job_ids: jobIds,
        result,
        submission: 'not_needed',
      })
      return result
    }

    const privileged = Math.min(requested, privilegedRequested)
    const privilegedGranted = Math.min(privileged, Math.max(0, MEDIA_HARD_LIMIT - consumed))
    const ordinaryRequested = requested - privileged
    const ordinaryGranted = Math.min(ordinaryRequested, Math.max(0, MEDIA_SOFT_LIMIT - consumed - privilegedGranted))
    const granted = privilegedGranted + ordinaryGranted
    const nextConsumed = consumed + granted
    const result = {
      granted,
      consumed: nextConsumed,
      soft_limit: MEDIA_SOFT_LIMIT,
      hard_limit: MEDIA_HARD_LIMIT,
    }
    const reservation: MediaReservation = {
      date,
      budget_date: budgetDate,
      requested,
      privileged_requested: privilegedRequested,
      job_ids: jobIds,
      result,
      submission: granted > 0 ? 'reserved' : 'not_needed',
    }

    const budgetWrite = this.storage.put(MEDIA_BUDGET_KEY, { date: budgetDate, consumed: nextConsumed })
    const reservationWrite = this.storage.put(reservationKey, reservation)
    await Promise.all([budgetWrite, reservationWrite])
    if (granted === 0) return result

    if (!this.queue) {
      await this.storage.put(reservationKey, { ...reservation, submission: 'uncertain' })
      return result
    }
    try {
      await this.queue.sendBatch(jobs.slice(0, granted).map((body) => ({ body, contentType: 'json' as const })))
    } catch {
      await this.storage.put(reservationKey, { ...reservation, submission: 'uncertain' })
      return result
    }
    await this.storage.put(reservationKey, { ...reservation, submission: 'confirmed' })
    return result
  }
}

export class SnapshotCoordinator {
  private core: SnapshotCoordinatorCore
  private tail: Promise<void> = Promise.resolve()

  constructor(state: DurableObjectState, env: SnapshotCoordinatorEnv) {
    this.core = new SnapshotCoordinatorCore(state.storage, env.AIRING_CAL_KV, env.MEDIA_QUEUE)
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const body = await request.json<Record<string, unknown>>()
    return this.serialized(async () => {
      if (url.pathname === '/allocate' && typeof body.instance_id === 'string') {
        return Response.json({ generation: await this.core.allocate(body.instance_id) })
      }
      if (url.pathname === '/commit' && typeof body.generation === 'number' && body.manifest) {
        return Response.json(await this.core.commit(body.generation, body.manifest as SnapshotManifest))
      }
      if (
        url.pathname === '/reserve-media'
        && typeof body.date === 'string'
        && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        && typeof body.reservation_id === 'string'
        && body.reservation_id.length > 0
        && typeof body.requested === 'number'
        && Number.isInteger(body.requested)
        && body.requested >= 0
        && typeof body.privileged_requested === 'number'
        && Number.isInteger(body.privileged_requested)
        && body.privileged_requested >= 0
        && body.privileged_requested <= body.requested
        && Array.isArray(body.jobs)
        && body.jobs.length === body.requested
      ) {
        return Response.json(await this.core.reserveMedia(
          body.date,
          body.reservation_id,
          body.requested,
          body.privileged_requested,
          body.jobs as MediaRefreshJobV3[],
        ))
      }
      return Response.json({ error: 'Invalid coordinator request' }, { status: 400 })
    })
  }
}
