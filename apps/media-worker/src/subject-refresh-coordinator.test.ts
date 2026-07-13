import assert from 'node:assert/strict'
import test from 'node:test'
import { SubjectRefreshCoordinator, SubjectRefreshCoordinatorCore } from './subject-refresh-coordinator.ts'

class MemoryState {
  values = new Map<string, unknown>()
  async get<T>(key: string) { return this.values.get(key) as T | undefined }
  async put<T>(key: string, value: T) { this.values.set(key, value) }
}

test('older subject generations become obsolete after a newer generation completes', async () => {
  const coordinator = new SubjectRefreshCoordinatorCore(new MemoryState())
  assert.deepEqual(await coordinator.begin(2, 'job-new'), { status: 'process', generation: 2 })
  await coordinator.complete(2, 'job-new')
  assert.deepEqual(await coordinator.begin(1, 'job-old'), { status: 'obsolete', generation: 1 })
})

test('legacy generation zero only runs before a V3 generation is processed', async () => {
  const coordinator = new SubjectRefreshCoordinatorCore(new MemoryState())
  assert.equal((await coordinator.begin(0, 'legacy-first')).status, 'process')
  await coordinator.complete(0, 'legacy-first')
  assert.equal((await coordinator.begin(3, 'job-v3')).status, 'process')
  await coordinator.complete(3, 'job-v3')
  assert.equal((await coordinator.begin(0, 'legacy-late')).status, 'obsolete')
})

test('the same completed job is a duplicate instead of being processed twice', async () => {
  const coordinator = new SubjectRefreshCoordinatorCore(new MemoryState())
  assert.equal((await coordinator.begin(4, 'job-4')).status, 'process')
  await coordinator.complete(4, 'job-4')
  assert.equal((await coordinator.begin(4, 'job-4')).status, 'duplicate')
})

test('the Durable Object rejects an old retry before media state can be overwritten', async () => {
  const state = new MemoryState()
  const kv = {
    values: new Map<string, unknown>(),
    puts: 0,
    async get(key: string) { return this.values.get(key) ?? null },
    async put(key: string, value: string) { this.puts++; this.values.set(key, JSON.parse(value)) },
    async delete(key: string) { this.values.delete(key) },
  }
  const coordinator = new SubjectRefreshCoordinator({ storage: state } as any, {
    AIRING_CAL_KV: kv,
    AIRING_CAL_R2: { async get() { return null }, async put() { return {} } },
  } as any)
  const request = (generation: number) => new Request('https://subject-refresh-coordinator/process', {
    method: 'POST',
    body: JSON.stringify({
      version: 3,
      generation,
      job_id: `job-${generation}`,
      subject_id: 23080,
      title: 'A CN',
      components: [],
    }),
  })

  assert.equal((await coordinator.fetch(request(3))).status, 200)
  const putsAfterNewJob = kv.puts
  const obsolete = await coordinator.fetch(request(2))
  assert.deepEqual(await obsolete.json(), { status: 'obsolete', generation: 2 })
  assert.equal(kv.puts, putsAfterNewJob)
})
