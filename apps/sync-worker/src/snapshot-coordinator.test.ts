import assert from 'node:assert/strict'
import test from 'node:test'
import type { MediaRefreshJobV3, SnapshotManifest } from '@airing-cal/storage'
import { SnapshotCoordinator, SnapshotCoordinatorCore } from './snapshot-coordinator.ts'

class MemoryState {
  values = new Map<string, unknown>()
  failNextReservationConfirmation = false

  async get<T>(key: string) { return this.values.get(key) as T | undefined }
  async put<T>(key: string, value: T) {
    if (
      this.failNextReservationConfirmation
      && key.startsWith('mediaReservation:')
      && (value as { submission?: string })?.submission === 'confirmed'
    ) {
      this.failNextReservationConfirmation = false
      throw new Error('confirmation persistence interrupted')
    }
    this.values.set(key, value)
  }
  async delete(key: string) { this.values.delete(key) }
}

class MemoryKV {
  values = new Map<string, unknown>()
  async put(key: string, value: string) { this.values.set(key, JSON.parse(value)) }
}

class MemoryQueue {
  messages: MediaRefreshJobV3[] = []
  acceptThenLoseResponseNext = false
  sendCalls = 0

  async sendBatch(messages: Array<{ body: MediaRefreshJobV3; contentType?: 'json' }>) {
    this.sendCalls += 1
    this.messages.push(...messages.map(({ body }) => body))
    if (this.acceptThenLoseResponseNext) {
      this.acceptThenLoseResponseNext = false
      throw new Error('queue response lost after accept')
    }
  }
}

function mediaJobs(count: number, startSubjectId = 1): MediaRefreshJobV3[] {
  return Array.from({ length: count }, (_, index) => {
    const subjectId = startSubjectId + index
    return {
      version: 3,
      generation: 1,
      job_id: `workflow:${subjectId}`,
      subject_id: subjectId,
      title: `Subject ${subjectId}`,
      components: ['detail'],
    }
  })
}

function reserveRequest(
  coordinator: SnapshotCoordinator,
  body: {
    date: string
    reservation_id: string
    requested: number
    privileged_requested: number
    jobs: MediaRefreshJobV3[]
  },
) {
  return coordinator.fetch(new Request('https://snapshot-coordinator/reserve-media', {
    method: 'POST',
    body: JSON.stringify({ ...body, allow_over_soft: body.privileged_requested > 0 }),
  }))
}

function manifest(instanceId: string, generation: number): SnapshotManifest {
  return {
    instance_id: instanceId,
    generation,
    mode: 'live',
    published_at: 1_783_929_700,
    subject_count: 655,
    required_keys: [`snapshot:version:${instanceId}:summary`],
    digests: { [`snapshot:version:${instanceId}:summary`]: 'sha256:summary' },
  }
}

test('allocate is monotonic and idempotent per workflow instance', async () => {
  const coordinator = new SnapshotCoordinatorCore(new MemoryState(), new MemoryKV())
  assert.equal(await coordinator.allocate('workflow-1'), 1)
  assert.equal(await coordinator.allocate('workflow-1'), 1)
  assert.equal(await coordinator.allocate('workflow-2'), 2)
})

test('an older workflow cannot replace a newer active manifest', async () => {
  const kv = new MemoryKV()
  const coordinator = new SnapshotCoordinatorCore(new MemoryState(), kv)
  const generation1 = await coordinator.allocate('workflow-1')
  const generation2 = await coordinator.allocate('workflow-2')
  assert.deepEqual(await coordinator.commit(generation2, manifest('workflow-2', generation2)), { status: 'committed', generation: 2 })
  assert.deepEqual(await coordinator.commit(generation1, manifest('workflow-1', generation1)), { status: 'obsolete', generation: 1 })
  assert.deepEqual(kv.values.get('snapshot:active'), manifest('workflow-2', 2))
})

test('replaying the committed instance is idempotent', async () => {
  const kv = new MemoryKV()
  const coordinator = new SnapshotCoordinatorCore(new MemoryState(), kv)
  const generation = await coordinator.allocate('workflow-1')
  assert.equal((await coordinator.commit(generation, manifest('workflow-1', generation))).status, 'committed')
  assert.equal((await coordinator.commit(generation, manifest('workflow-1', generation))).status, 'committed')
})

test('concurrent commit requests cannot interleave while the older KV write is awaiting', async () => {
  const state = new MemoryState()
  let releaseOld!: () => void
  let oldWriteStarted!: () => void
  const oldWrite = new Promise<void>((resolve) => { releaseOld = resolve })
  const started = new Promise<void>((resolve) => { oldWriteStarted = resolve })
  const kv = new MemoryKV()
  kv.put = async (key: string, value: string) => {
    const parsed = JSON.parse(value)
    if (parsed.generation === 1) {
      oldWriteStarted()
      await oldWrite
    }
    kv.values.set(key, parsed)
  }
  const coordinator = new SnapshotCoordinator({ storage: state } as any, { AIRING_CAL_KV: kv, MEDIA_QUEUE: new MemoryQueue() })
  const request = (generation: number) => new Request('https://snapshot-coordinator/commit', {
    method: 'POST',
    body: JSON.stringify({ generation, manifest: manifest(`workflow-${generation}`, generation) }),
  })

  const older = coordinator.fetch(request(1))
  await started
  const newer = coordinator.fetch(request(2))
  await new Promise((resolve) => setTimeout(resolve, 0))
  releaseOld()
  await Promise.all([older, newer])
  assert.deepEqual(kv.values.get('snapshot:active'), manifest('workflow-2', 2))
})

test('media budget shares a UTC day across scheduled and manual reservations and resets on a new day', async () => {
  let now = Date.parse('2026-07-22T23:59:00Z')
  const queue = new MemoryQueue()
  const coordinator = new SnapshotCoordinatorCore(new MemoryState(), new MemoryKV(), queue, () => now)
  let reservation = 0
  let nextSubjectId = 1
  const reserve = async (date: string, requested: number, allowOverSoft: boolean) => {
    const result = await coordinator.reserveMedia(
      date,
      `workflow-${reservation++}:media`,
      requested,
      allowOverSoft ? requested : 0,
      mediaJobs(requested, nextSubjectId),
    )
    nextSubjectId += requested
    return result
  }

  assert.deepEqual(await reserve('2026-07-22', 40, false), {
    granted: 40,
    consumed: 40,
    soft_limit: 50,
    hard_limit: 100,
    submission: 'confirmed',
  })
  assert.deepEqual(await reserve('2026-07-22', 20, false), {
    granted: 10,
    consumed: 50,
    soft_limit: 50,
    hard_limit: 100,
    submission: 'confirmed',
  })
  assert.deepEqual(await reserve('2026-07-22', 75, true), {
    granted: 50,
    consumed: 100,
    soft_limit: 50,
    hard_limit: 100,
    submission: 'confirmed',
  })
  assert.deepEqual(await reserve('2026-07-22', 1, true), {
    granted: 0,
    consumed: 100,
    soft_limit: 50,
    hard_limit: 100,
    submission: 'not_needed',
  })
  now = Date.parse('2026-07-23T00:01:00Z')
  assert.deepEqual(await reserve('2026-07-23', 8, false), {
    granted: 8,
    consumed: 8,
    soft_limit: 50,
    hard_limit: 100,
    submission: 'confirmed',
  })
})

test('media budget replays one stable reservation without consuming or enqueueing twice', async () => {
  const queue = new MemoryQueue()
  const coordinator = new SnapshotCoordinator(
    { storage: new MemoryState() } as any,
    { AIRING_CAL_KV: new MemoryKV(), MEDIA_QUEUE: queue } as any,
  )
  const body = {
    date: '2026-07-22',
    reservation_id: 'workflow-1:media',
    requested: 40,
    privileged_requested: 0,
    jobs: mediaJobs(40),
  }

  const first = await (await reserveRequest(coordinator, body)).json()
  const replay = await (await reserveRequest(coordinator, body)).json()

  assert.deepEqual(first, { granted: 40, consumed: 40, soft_limit: 50, hard_limit: 100, submission: 'confirmed' })
  assert.deepEqual(replay, first)
  assert.equal(queue.messages.length, 40)
})

test('media budget keeps an accepted queue batch consumed when its response is lost', async () => {
  const queue = new MemoryQueue()
  queue.acceptThenLoseResponseNext = true
  const coordinator = new SnapshotCoordinator(
    { storage: new MemoryState() } as any,
    { AIRING_CAL_KV: new MemoryKV(), MEDIA_QUEUE: queue } as any,
  )
  const body = {
    date: '2026-07-22',
    reservation_id: 'workflow-retry:media',
    requested: 1,
    privileged_requested: 1,
    jobs: mediaJobs(1),
  }

  const first = await (await reserveRequest(coordinator, body)).json()
  const retried = await (await reserveRequest(coordinator, body)).json()

  assert.deepEqual(first, { granted: 1, consumed: 1, soft_limit: 50, hard_limit: 100, submission: 'uncertain' })
  assert.deepEqual(retried, { granted: 1, consumed: 1, soft_limit: 50, hard_limit: 100, submission: 'uncertain' })
  assert.equal(queue.messages.length, 1)
  assert.equal(queue.sendCalls, 1)
})

test('media budget replays a durable marker without resending after confirmation persistence is interrupted', async () => {
  const state = new MemoryState()
  state.failNextReservationConfirmation = true
  const queue = new MemoryQueue()
  const coordinator = new SnapshotCoordinator(
    { storage: state } as any,
    { AIRING_CAL_KV: new MemoryKV(), MEDIA_QUEUE: queue } as any,
  )
  const body = {
    date: '2026-07-22',
    reservation_id: 'workflow-interrupted:media',
    requested: 1,
    privileged_requested: 1,
    jobs: mediaJobs(1),
  }

  await assert.rejects(() => reserveRequest(coordinator, body), /confirmation persistence interrupted/)
  const replay = await (await reserveRequest(coordinator, body)).json()

  assert.deepEqual(replay, { granted: 1, consumed: 1, soft_limit: 50, hard_limit: 100, submission: 'uncertain' })
  assert.equal(queue.messages.length, 1)
  assert.equal(queue.sendCalls, 1)
})

test('media budget uses the coordinator UTC clock when a slow old run first arrives after midnight', async () => {
  const state = new MemoryState()
  const queue = new MemoryQueue()
  const now = Date.parse('2026-07-23T00:01:00Z')
  const coordinator = new SnapshotCoordinatorCore(state, new MemoryKV(), queue, () => now)

  const oldRun = await coordinator.reserveMedia(
    '2026-07-22',
    'slow-old-run:media',
    100,
    100,
    mediaJobs(100),
  )
  const newRun = await coordinator.reserveMedia(
    '2026-07-23',
    'new-run:media',
    100,
    100,
    mediaJobs(100, 101),
  )

  assert.equal(oldRun.granted, 100)
  assert.equal(newRun.granted, 0)
  assert.equal(queue.messages.length, 100)
  assert.deepEqual(state.values.get('mediaBudget'), { date: '2026-07-23', consumed: 100 })
  assert.equal((state.values.get('mediaReservation:slow-old-run:media') as any).date, '2026-07-22')
  assert.equal((state.values.get('mediaReservation:slow-old-run:media') as any).budget_date, '2026-07-23')
})

test('media budget treats caller dates as audit data that cannot reopen the actual UTC-day budget', async () => {
  const queue = new MemoryQueue()
  const coordinator = new SnapshotCoordinator(
    { storage: new MemoryState() } as any,
    { AIRING_CAL_KV: new MemoryKV(), MEDIA_QUEUE: queue } as any,
  )
  const reserve = async (date: string, reservationId: string, startSubjectId: number) => {
    const response = await reserveRequest(coordinator, {
      date,
      reservation_id: reservationId,
      requested: 100,
      privileged_requested: 100,
      jobs: mediaJobs(100, startSubjectId),
    })
    return await response.json() as { granted: number }
  }

  assert.equal((await reserve('2026-07-23', 'new-day-1:media', 1)).granted, 100)
  assert.equal((await reserve('2026-07-22', 'old-day:media', 101)).granted, 0)
  assert.equal((await reserve('2026-07-23', 'new-day-2:media', 201)).granted, 0)
  assert.equal(queue.messages.length, 100)
})

test('media budget grants a mixed reservation privileged headroom without letting ordinary work cross soft', async () => {
  const queue = new MemoryQueue()
  const coordinator = new SnapshotCoordinator(
    { storage: new MemoryState() } as any,
    { AIRING_CAL_KV: new MemoryKV(), MEDIA_QUEUE: queue } as any,
  )
  await reserveRequest(coordinator, {
    date: '2026-07-22',
    reservation_id: 'ordinary:media',
    requested: 50,
    privileged_requested: 0,
    jobs: mediaJobs(50),
  })

  const response = await reserveRequest(coordinator, {
    date: '2026-07-22',
    reservation_id: 'mixed:media',
    requested: 50,
    privileged_requested: 10,
    jobs: mediaJobs(50, 101),
  })

  assert.deepEqual(await response.json(), {
    granted: 10,
    consumed: 60,
    soft_limit: 50,
    hard_limit: 100,
    submission: 'confirmed',
  })
  assert.equal(queue.messages.length, 60)
})

test('media budget serializes concurrent reservations below the hard limit', async () => {
  const queue = new MemoryQueue()
  const coordinator = new SnapshotCoordinator(
    { storage: new MemoryState() } as any,
    { AIRING_CAL_KV: new MemoryKV(), MEDIA_QUEUE: queue } as any,
  )

  const responses = await Promise.all([
    reserveRequest(coordinator, {
      date: '2026-07-22',
      reservation_id: 'concurrent-a:media',
      requested: 75,
      privileged_requested: 75,
      jobs: mediaJobs(75),
    }),
    reserveRequest(coordinator, {
      date: '2026-07-22',
      reservation_id: 'concurrent-b:media',
      requested: 75,
      privileged_requested: 75,
      jobs: mediaJobs(75, 101),
    }),
  ])
  const results = await Promise.all(responses.map((response) => response.json() as Promise<{ granted: number; consumed: number }>))

  assert.equal(results.reduce((total, { granted }) => total + granted, 0), 100)
  assert.equal(Math.max(...results.map(({ consumed }) => consumed)), 100)
  assert.equal(queue.messages.length, 100)
})
