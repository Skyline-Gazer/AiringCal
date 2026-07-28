import assert from 'node:assert/strict'
import test from 'node:test'
import { loadReplayArtifact, persistReplayArtifact, type ReplayArtifactStore } from './replay-artifact.ts'

class MemoryArtifactStore implements ReplayArtifactStore {
  readonly values = new Map<string, unknown>()

  async getAppState<T>(key: string, decode: (value: unknown) => T): Promise<T | undefined> {
    const value = this.values.get(key)
    return value === undefined ? undefined : decode(value)
  }

  async putAppState<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value))
  }
}

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
