import assert from 'node:assert/strict'
import test from 'node:test'
import type { SnapshotManifest } from '@airing-cal/storage'
import { SnapshotCoordinator, SnapshotCoordinatorCore } from './snapshot-coordinator.ts'

class MemoryState {
  values = new Map<string, unknown>()
  async get<T>(key: string) { return this.values.get(key) as T | undefined }
  async put<T>(key: string, value: T) { this.values.set(key, value) }
}

class MemoryKV {
  values = new Map<string, unknown>()
  async put(key: string, value: string) { this.values.set(key, JSON.parse(value)) }
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
  const coordinator = new SnapshotCoordinator({ storage: state } as any, { AIRING_CAL_KV: kv })
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
  const coordinator = new SnapshotCoordinator({ storage: new MemoryState() } as any, { AIRING_CAL_KV: new MemoryKV() })
  const reserve = async (date: string, requested: number, allowOverSoft: boolean) => {
    const response = await coordinator.fetch(new Request('https://snapshot-coordinator/reserve-media', {
      method: 'POST',
      body: JSON.stringify({ date, requested, allow_over_soft: allowOverSoft }),
    }))
    assert.equal(response.status, 200)
    return await response.json()
  }

  assert.deepEqual(await reserve('2026-07-22', 40, false), {
    granted: 40,
    consumed: 40,
    soft_limit: 50,
    hard_limit: 100,
  })
  assert.deepEqual(await reserve('2026-07-22', 20, false), {
    granted: 10,
    consumed: 50,
    soft_limit: 50,
    hard_limit: 100,
  })
  assert.deepEqual(await reserve('2026-07-22', 75, true), {
    granted: 50,
    consumed: 100,
    soft_limit: 50,
    hard_limit: 100,
  })
  assert.deepEqual(await reserve('2026-07-22', 1, true), {
    granted: 0,
    consumed: 100,
    soft_limit: 50,
    hard_limit: 100,
  })
  assert.deepEqual(await reserve('2026-07-23', 8, false), {
    granted: 8,
    consumed: 8,
    soft_limit: 50,
    hard_limit: 100,
  })
})
