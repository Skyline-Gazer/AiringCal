import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cleanupReplayArtifactIfUnreferenced,
  loadReplayArtifact,
  persistReplayArtifact,
  type ReplayArtifactStore,
} from './replay-artifact.ts'

class MemoryArtifactStore implements ReplayArtifactStore {
  readonly values = new Map<string, unknown>()
  readonly runResults = new Map<string, string | null>()

  async getAppState<T>(key: string, decode: (value: unknown) => T): Promise<T | undefined> {
    const value = this.values.get(key)
    return value === undefined ? undefined : decode(value)
  }

  async putAppState<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value))
  }

  async deleteAppStateKeys(keys: string[]): Promise<void> {
    for (const key of keys) this.values.delete(key)
  }

  async getSyncRun(instanceId: string): Promise<{ result_json: string | null } | undefined> {
    return this.runResults.has(instanceId)
      ? { result_json: this.runResults.get(instanceId)! }
      : undefined
  }
}

class FailingArtifactStore extends MemoryArtifactStore {
  putAttempts = 0
  deletedKeys: string[][] = []

  constructor(
    private readonly failPutAt: number,
    private readonly failCleanup = false,
  ) {
    super()
  }

  override async putAppState<T>(key: string, value: T): Promise<void> {
    this.putAttempts++
    if (this.putAttempts === this.failPutAt) throw new Error('chunk write failed')
    await super.putAppState(key, value)
  }

  async deleteAppStateKeys(keys: string[]): Promise<void> {
    this.deletedKeys.push([...keys])
    if (this.failCleanup) throw new Error('cleanup failed')
    for (const key of keys) this.values.delete(key)
  }
}

test('artifact persistence removes earlier chunks after a mid-stream write failure', async () => {
  for (const failCleanup of [false, true]) {
    const store = new FailingArtifactStore(2, failCleanup)

    await assert.rejects(
      persistReplayArtifact(
        store,
        `partial-${String(failCleanup)}`,
        'd'.repeat(64),
        'prepared',
        'x'.repeat(300_000),
      ),
      /chunk write failed/,
    )

    assert.equal(store.deletedKeys.length, 1)
    assert.equal(store.deletedKeys[0]?.length, 1)
    if (!failCleanup) assert.equal(store.values.size, 0)
  }
})

test('artifact codec stores a bounded manifest and round-trips verified UTF-8 chunks', async () => {
  const store = new MemoryArtifactStore()
  const artifactJson = JSON.stringify({ summary: '番'.repeat(150_000) })
  const inputHash = 'a'.repeat(64)

  const persisted = await persistReplayArtifact(
    store,
    'run-large',
    inputHash,
    'prepared',
    artifactJson,
  )
  const manifest = JSON.parse(persisted.manifestJson)

  assert.ok(Buffer.byteLength(persisted.manifestJson, 'utf8') < 100_000)
  assert.ok(manifest.artifact.chunk_count > 1)
  assert.equal(manifest.artifact.byte_length, Buffer.byteLength(artifactJson, 'utf8'))
  assert.equal(store.values.size, manifest.artifact.chunk_count)
  assert.deepEqual(
    await loadReplayArtifact(store, persisted.manifestJson, inputHash, 'run-large'),
    persisted,
  )
})

test('artifact codec rejects wrong input identity, missing chunks, tampering and aggregate mismatch', async () => {
  const inputHash = 'b'.repeat(64)

  for (const corruption of ['input', 'missing', 'tampered', 'aggregate'] as const) {
    const store = new MemoryArtifactStore()
    const persisted = await persistReplayArtifact(
      store,
      `run-${corruption}`,
      inputHash,
      'collection',
      '{"schema_version":1}',
    )
    if (corruption === 'missing') store.values.delete(persisted.chunkKeys[0]!)
    if (corruption === 'tampered') store.values.set(persisted.chunkKeys[0]!, 'corrupt')
    const manifest = JSON.parse(persisted.manifestJson)
    if (corruption === 'aggregate') manifest.artifact.byte_length++

    await assert.rejects(
      loadReplayArtifact(
        store,
        corruption === 'aggregate' ? JSON.stringify(manifest) : persisted.manifestJson,
        corruption === 'input' ? 'c'.repeat(64) : inputHash,
        `run-${corruption}`,
      ),
      /replay artifact/i,
    )
  }
})

test('artifact cleanup deletes only an unreferenced or retained-run artifact', async () => {
  const store = new MemoryArtifactStore()
  const instanceId = 'retained-run'
  const superseded = await persistReplayArtifact(
    store,
    instanceId,
    'e'.repeat(64),
    'collection',
    '{"checkpoint":1}',
  )
  const current = await persistReplayArtifact(
    store,
    instanceId,
    'e'.repeat(64),
    'prepared',
    '{"result":2}',
  )
  store.runResults.set(instanceId, current.manifestJson)

  assert.equal(await cleanupReplayArtifactIfUnreferenced(store, instanceId, superseded), true)
  assert.ok(superseded.chunkKeys.every((key) => !store.values.has(key)))
  assert.equal(await cleanupReplayArtifactIfUnreferenced(store, instanceId, current), false)
  assert.ok(current.chunkKeys.every((key) => store.values.has(key)))

  store.runResults.delete(instanceId)
  assert.equal(await cleanupReplayArtifactIfUnreferenced(store, instanceId, current), true)
  assert.ok(current.chunkKeys.every((key) => !store.values.has(key)))
})
