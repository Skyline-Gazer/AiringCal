import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPublicSnapshot, canonicalSnapshotBytes } from '@airing-cal/domain'
import { publishSnapshot, type PublicationPorts, type SnapshotPublicationCandidate } from './publish.ts'

const hash = 'a'.repeat(64)
const observedAt = '2026-09-02T00:00:00.000Z'
const gitSha = 'b'.repeat(40)

function candidate(): SnapshotPublicationCandidate {
  return {
    snapshot: { collections: [], calendar: [], published_at: 1_725_235_200 },
    runId: 'run-1', observedAt, gitSha,
  }
}

function state(overrides: Partial<PublicationPorts['publication'] extends { getState(): Promise<infer Value> } ? Value : never> = {}) {
  return {
    verifiedGeneration: 0, verifiedContentHash: null, verifiedObjectKey: null, verifiedAt: null, verifiedRunId: null,
    pendingGeneration: null, pendingContentHash: null, pendingObjectKey: null, pendingRunId: null, pendingClaimedAt: null,
    pendingCreatedAt: null, ...overrides,
  }
}

function fixture() {
  const events: string[] = []
  const objects = new Map<string, Uint8Array>()
  let publication = state()
  const ports: PublicationPorts = {
    now: () => observedAt,
    s3: {
      put: async (key, bytes) => { events.push(`put:${key}`); objects.set(key, bytes) },
      get: async (key) => { events.push(`get:${key}`); return objects.get(key) ?? null },
      list: async () => [],
      delete: async () => undefined,
    },
    publication: {
      getState: async () => publication,
      savePending: async (input) => {
        events.push(`pending:${input.generation}`)
        publication = state({ pendingGeneration: input.generation, pendingContentHash: input.contentHash,
          pendingObjectKey: input.objectKey, pendingRunId: input.runId, pendingCreatedAt: input.createdAt })
        return publication
      },
      claimPending: async (input) => {
        events.push(`claim:${input.generation}`)
        publication = { ...publication, pendingClaimedAt: input.claimedAt }
        return publication
      },
      verify: async (input) => {
        events.push(`verify:${input.generation}`)
        publication = state({ verifiedGeneration: input.generation, verifiedContentHash: input.contentHash,
          verifiedObjectKey: input.objectKey, verifiedRunId: input.runId, verifiedAt: input.verifiedAt })
        return publication
      },
    },
  }
  return { ports, events, objects, publication: () => publication }
}

test('publishes in immutable snapshot, verified manifest, then database order', async () => {
  const { ports, events, publication } = fixture()
  assert.equal(await publishSnapshot(ports, candidate(), 'live'), 'published')
  const snapshot = await buildPublicSnapshot(candidate().snapshot, 1)
  const key = `snapshots/v1/1-${snapshot.content_hash}.json`
  assert.deepEqual(events, [
    'pending:1', `put:${key}`, `get:${key}`, 'claim:1', 'put:public/manifest.json', 'get:public/manifest.json', 'verify:1',
  ])
  assert.equal(publication().verifiedGeneration, 1)
})

test('every R2 boundary failure leaves the old manifest and publication pending', async () => {
  for (const boundary of ['snapshot-put', 'snapshot-get', 'manifest-put', 'manifest-get'] as const) {
    const { ports, objects, publication } = fixture()
    const put = ports.s3.put
    const get = ports.s3.get
    ports.s3.put = async (key, bytes) => {
      if ((boundary === 'snapshot-put' && key.startsWith('snapshots/')) || (boundary === 'manifest-put' && key.endsWith('manifest.json'))) throw new Error(boundary)
      await put(key, bytes)
    }
    ports.s3.get = async (key) => {
      if ((boundary === 'snapshot-get' && key.startsWith('snapshots/')) || (boundary === 'manifest-get' && key.endsWith('manifest.json'))) throw new Error(boundary)
      return get(key)
    }
    assert.equal(await publishSnapshot(ports, candidate(), 'live'), 'pending')
    // A GET failure after a successful final PUT is externally ambiguous: do not
    // advance PostgreSQL; a replay verifies and completes the same pending work.
    assert.equal(objects.has('public/manifest.json'), boundary === 'manifest-get')
    assert.equal(publication().verifiedGeneration, 0)
    assert.equal(publication().pendingGeneration, 1)
  }
})

test('replays the same pending generation and shadow never writes the live manifest', async () => {
  const { ports, events } = fixture()
  assert.equal(await publishSnapshot(ports, candidate(), 'shadow'), 'published')
  assert.ok(events.includes('put:shadow/manifest.json'))
  assert.ok(!events.includes('put:public/manifest.json'))
  const pending = fixture()
  pending.ports.publication.getState = async () => state({ pendingGeneration: 1, pendingContentHash: (await buildPublicSnapshot(candidate().snapshot, 1)).content_hash,
    pendingObjectKey: `snapshots/v1/1-${(await buildPublicSnapshot(candidate().snapshot, 1)).content_hash}.json`, pendingRunId: 'run-1', pendingCreatedAt: observedAt })
  assert.equal(await publishSnapshot(pending.ports, candidate(), 'live'), 'published')
  assert.ok(!pending.events.includes('pending:2'))
})

test('does not allocate or write when the canonical content hash is already verified', async () => {
  const { ports, events } = fixture()
  const snapshot = await buildPublicSnapshot(candidate().snapshot, 1)
  ports.publication.getState = async () => state({ verifiedGeneration: 1, verifiedContentHash: snapshot.content_hash,
    verifiedObjectKey: `snapshots/v1/1-${snapshot.content_hash}.json` })
  assert.equal(await publishSnapshot(ports, candidate(), 'live'), 'no_change')
  assert.deepEqual(events, [])
  assert.equal(canonicalSnapshotBytes(snapshot).byteLength > 0, true)
  assert.notEqual(snapshot.content_hash, hash)
})
