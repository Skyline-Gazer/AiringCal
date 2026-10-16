import assert from 'node:assert/strict'
import test from 'node:test'
import {
  publishRelease,
  type PrivateCheckpointStore,
  type PublicStore,
  type Publisher,
  type ReleasePointer,
} from './ports.ts'

const pointer: ReleasePointer = {
  generation: 1,
  contentHash: 'a'.repeat(64),
  publishedAt: 1_700_000_000,
  artifactKey: 'releases/1/snapshot.json',
}

test('publishRelease fails closed when artifacts are not verified', async () => {
  const store: PublicStore = {
    capabilities: { compareAndSwapPointer: true, immutableArtifacts: true },
    async getPointer() { return null },
    async getArtifact() { return null },
  }
  const publisher: Publisher = {
    async publish() { return { ok: true, generation: 1 } },
  }
  const result = await publishRelease(store, publisher, { pointer, artifactsVerified: false })
  assert.deepEqual(result, { ok: false, reason: 'VERIFICATION_FAILED' })
})

test('publishRelease fails closed when CAS pointer is unsupported', async () => {
  const store: PublicStore = {
    capabilities: { compareAndSwapPointer: false, immutableArtifacts: true },
    async getPointer() { return null },
    async getArtifact() { return null },
  }
  const publisher: Publisher = {
    async publish() { return { ok: true, generation: 1 } },
  }
  const result = await publishRelease(store, publisher, { pointer, artifactsVerified: true })
  assert.deepEqual(result, { ok: false, reason: 'POINTER_CAS_UNAVAILABLE' })
})

test('publishRelease fails closed when immutable artifacts are unsupported', async () => {
  const store: PublicStore = {
    capabilities: { compareAndSwapPointer: true, immutableArtifacts: false },
    async getPointer() { return null },
    async getArtifact() { return null },
  }
  const publisher: Publisher = {
    async publish() { return { ok: true, generation: 1 } },
  }
  const result = await publishRelease(store, publisher, { pointer, artifactsVerified: true })
  assert.deepEqual(result, { ok: false, reason: 'INCOMPLETE_INPUT' })
})

test('publishRelease delegates to publisher when capabilities and verification pass', async () => {
  const store: PublicStore = {
    capabilities: { compareAndSwapPointer: true, immutableArtifacts: true },
    async getPointer() { return pointer },
    async getArtifact(key: string) {
      return key === pointer.artifactKey ? new TextEncoder().encode('{}') : null
    },
  }
  const publisher: Publisher = {
    async publish(input) {
      assert.equal(input.pointer.generation, 1)
      return { ok: true, generation: 2 }
    },
  }
  const result = await publishRelease(store, publisher, { pointer, artifactsVerified: true })
  assert.deepEqual(result, { ok: true, generation: 2 })
})

test('PrivateCheckpointStore contract requires durableLocalWrites capability flag', () => {
  const store: PrivateCheckpointStore = {
    capabilities: { durableLocalWrites: true },
    async saveCheckpoint() {},
    async loadCheckpoint() { return null },
  }
  assert.equal(store.capabilities.durableLocalWrites, true)
})
