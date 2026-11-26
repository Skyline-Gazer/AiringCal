import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  BuilderStateStore,
  PrivateCheckpointStore,
  PublicReleasePointer,
  PublicStore,
  PublisherCapabilities,
  RuntimeAdapter,
} from './ports.ts'

class MemoryPublicStore implements PublicStore {
  current: PublicReleasePointer | null = null
  objects = new Map<string, Uint8Array>()

  async getCurrentRelease() {
    return this.current
  }

  async getSnapshotBytes(artifactRef: string) {
    return this.objects.get(artifactRef) ?? null
  }

  async putImmutableObject(key: string, body: Uint8Array, _contentType: string) {
    this.objects.set(key, body)
  }

  async commitRelease(expected: PublicReleasePointer | null, next: PublicReleasePointer) {
    if (expected?.content_hash !== this.current?.content_hash) return 'conflict'
    this.current = next
    return 'committed'
  }
}

class MemoryCheckpointStore implements PrivateCheckpointStore {
  blobs = new Map<string, Uint8Array>()

  async read(id: string) {
    return this.blobs.get(id) ?? null
  }

  async write(id: string, body: Uint8Array) {
    this.blobs.set(id, body)
  }

  async delete(id: string) {
    this.blobs.delete(id)
  }
}

class StubAdapter implements RuntimeAdapter {
  readonly platform_id = 'test'

  capabilities(): PublisherCapabilities {
    return {
      compare_and_swap_pointer: true,
      immutable_object_store: true,
      serve_static_assets: true,
      serve_read_gateway: true,
    }
  }
}

class MemoryBuilderState implements BuilderStateStore {
  leases = new Map<string, { owner: string; expires: number }>()
  kv = new Map<string, string>()

  async acquireLease(jobId: string, ownerToken: string, ttlSeconds: number, nowUnix = Math.floor(Date.now() / 1000)) {
    const existing = this.leases.get(jobId)
    if (existing && existing.expires > nowUnix && existing.owner !== ownerToken) return false
    this.leases.set(jobId, { owner: ownerToken, expires: nowUnix + ttlSeconds })
    return true
  }

  async releaseLease(jobId: string, ownerToken: string) {
    const existing = this.leases.get(jobId)
    if (existing?.owner === ownerToken) this.leases.delete(jobId)
  }

  async getLease(jobId: string) {
    const row = this.leases.get(jobId)
    if (!row) return null
    return { job_id: jobId, owner_token: row.owner, expires_at_unix: row.expires }
  }

  async setKv(key: string, valueJson: string) {
    this.kv.set(key, valueJson)
  }

  async getKv(key: string) {
    return this.kv.get(key) ?? null
  }
}

test('port doubles enforce release pointer CAS semantics', async () => {
  const store = new MemoryPublicStore()
  const pointer: PublicReleasePointer = {
    schema_version: 1,
    generation: 1,
    content_hash: 'c'.repeat(64),
    published_at_unix: 1,
    artifact_ref: 'snapshots/v1/1-cc.json',
  }
  await store.putImmutableObject(pointer.artifact_ref, new TextEncoder().encode('{}'), 'application/json')
  assert.equal(await store.commitRelease(null, pointer), 'committed')
  assert.equal(await store.commitRelease(null, pointer), 'conflict')
})

test('runtime adapter capability object is explicit', () => {
  const caps = new StubAdapter().capabilities()
  assert.equal(caps.serve_read_gateway, true)
})

test('builder state store lease fencing rejects competing owners', async () => {
  const state = new MemoryBuilderState()
  assert.equal(await state.acquireLease('sync', 'owner-a', 60, 1_000), true)
  assert.equal(await state.acquireLease('sync', 'owner-b', 60, 1_000), false)
  assert.equal(await state.acquireLease('sync', 'owner-a', 60, 1_050), true)
})
