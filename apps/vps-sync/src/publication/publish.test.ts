import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPublicSnapshot, canonicalSnapshotBytes } from '@airing-cal/domain'
import type { PublicationState } from '../postgres/repositories.ts'
import { publishSnapshot, type PublicationPorts, type PublicationStatePort, type SnapshotPublicationCandidate } from './publish.ts'

const hash = 'a'.repeat(64)
const observedAt = '2026-09-02T00:00:00.000Z'
const gitSha = 'b'.repeat(40)

function candidate(version = 0): SnapshotPublicationCandidate {
  return {
    snapshot: {
      collections: version === 0 ? [] : [{ subject_id: version, name: `Subject ${version}`, name_cn: '', summary: '',
        images: { common: null, large: null }, image_status: { common: 'missing_source', large: 'missing_source' },
        eps: 0, total_episodes: 0, ep_status: 0, vol_status: 0, type: 2, collection_type: 1, rate: 0,
        nsfw: false, date: '', tags: [], updated_at: '' }],
      calendar: [], published_at: 1_725_235_200,
    },
    runId: 'run-1', observedAt, gitSha,
  }
}

function state(overrides: Partial<PublicationState> = {}) {
  return {
    verifiedGeneration: 0, verifiedContentHash: null, verifiedObjectKey: null, verifiedAt: null, verifiedRunId: null,
    pendingGeneration: null, pendingContentHash: null, pendingObjectKey: null, pendingRunId: null, pendingClaimedAt: null,
    pendingCreatedAt: null, ...overrides,
  }
}

function fixture() {
  const events: string[] = []
  const objects = new Map<string, Uint8Array>()
  const publications = new Map<'live' | 'shadow', ReturnType<typeof state>>([
    ['live', state()], ['shadow', state()],
  ])
  const modePorts = new Map<'live' | 'shadow', PublicationStatePort>()
  const forMode = (mode: 'live' | 'shadow'): PublicationStatePort => {
    const existing = modePorts.get(mode)
    if (existing) return existing
    const port: PublicationStatePort = {
      getState: async () => publications.get(mode)!,
      savePending: async (input) => {
        events.push(`pending:${mode}:${input.generation}`)
        publications.set(mode, state({ ...publications.get(mode)!, pendingGeneration: input.generation, pendingContentHash: input.contentHash,
          pendingObjectKey: input.objectKey, pendingRunId: input.runId, pendingCreatedAt: input.createdAt }))
        return publications.get(mode)!
      },
      claimPending: async (input) => {
        events.push(`claim:${mode}:${input.generation}`)
        const publication = publications.get(mode)!
        publications.set(mode, { ...publication, pendingClaimedAt: input.claimedAt })
        return publications.get(mode)!
      },
      clearUnclaimedPending: async (input) => {
        events.push(`clear:${mode}:${input.verifiedGeneration}`)
        const publication = publications.get(mode)!
        if (publication.verifiedGeneration === input.verifiedGeneration
          && publication.verifiedContentHash === input.verifiedContentHash
          && publication.pendingGeneration !== null && publication.pendingClaimedAt === null) {
          publications.set(mode, { ...publication, pendingGeneration: null, pendingContentHash: null,
            pendingObjectKey: null, pendingRunId: null, pendingClaimedAt: null, pendingCreatedAt: null })
        }
        return publications.get(mode)!
      },
      verify: async (input) => {
        events.push(`verify:${mode}:${input.generation}`)
        publications.set(mode, state({ verifiedGeneration: input.generation, verifiedContentHash: input.contentHash,
          verifiedObjectKey: input.objectKey, verifiedRunId: input.runId, verifiedAt: input.verifiedAt }))
        return publications.get(mode)!
      },
    }
    modePorts.set(mode, port)
    return port
  }
  const ports: PublicationPorts = {
    now: () => observedAt,
    s3: {
      put: async (key, bytes) => { events.push(`put:${key}`); objects.set(key, bytes) },
      get: async (key) => { events.push(`get:${key}`); return objects.get(key) ?? null },
      list: async () => [],
      delete: async () => undefined,
    },
    publication: { forMode },
  }
  return { ports, events, objects, publication: (mode: 'live' | 'shadow' = 'live') => publications.get(mode)! }
}

test('publishes in immutable snapshot, verified manifest, then database order', async () => {
  const { ports, events, publication } = fixture()
  assert.equal(await publishSnapshot(ports, candidate(), 'live'), 'published')
  const snapshot = await buildPublicSnapshot(candidate().snapshot, 1)
  const key = `snapshots/v1/1-${snapshot.content_hash}.json`
  assert.deepEqual(events, [
    'pending:live:1', `put:${key}`, `get:${key}`, 'claim:live:1', 'put:public/manifest.json', 'get:public/manifest.json', 'verify:live:1',
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

test('keeps shadow state and objects separate so the same content still publishes live', async () => {
  const { ports, events } = fixture()
  assert.equal(await publishSnapshot(ports, candidate(), 'shadow'), 'published')
  assert.ok(events.includes('put:shadow/manifest.json'))
  assert.ok(!events.includes('put:public/manifest.json'))
  assert.ok(events.some((event) => event.startsWith('put:shadow/snapshots/v1/')))
  assert.equal(await publishSnapshot(ports, candidate(), 'live'), 'published')
  assert.ok(events.includes('put:public/manifest.json'))
})

test('replays a pending publication from a new run identity without allocating a generation', async () => {
  const pending = fixture()
  const snapshot = await buildPublicSnapshot(candidate().snapshot, 1)
  const port = pending.ports.publication.forMode('live')
  port.getState = async () => state({ pendingGeneration: 1, pendingContentHash: snapshot.content_hash,
    pendingObjectKey: `snapshots/v1/1-${snapshot.content_hash}.json`, pendingRunId: 'run-1', pendingCreatedAt: observedAt })
  const replay = { ...candidate(), runId: 'run-2' }
  assert.equal(await publishSnapshot(pending.ports, replay, 'live'), 'published')
  assert.ok(!pending.events.includes('pending:live:2'))
  assert.ok(pending.events.includes('verify:live:1'))
})

test('validates an existing immutable snapshot after a real conditional 412 response', async () => {
  const { ports, objects, events } = fixture()
  const snapshot = await buildPublicSnapshot(candidate().snapshot, 1)
  const key = `snapshots/v1/1-${snapshot.content_hash}.json`
  objects.set(key, canonicalSnapshotBytes(snapshot))
  ports.s3.put = async (objectKey, bytes, options) => {
    events.push(`put:${objectKey}`)
    if (objectKey === key && options?.ifNoneMatch) throw { $metadata: { httpStatusCode: 412 } }
    objects.set(objectKey, bytes)
  }
  assert.equal(await publishSnapshot(ports, candidate(), 'live'), 'published')
  assert.ok(events.includes(`get:${key}`))
})

test('does not switch a manifest when a 412 existing snapshot has wrong bytes', async () => {
  const { ports, objects, publication } = fixture()
  const snapshot = await buildPublicSnapshot(candidate().snapshot, 1)
  const key = `snapshots/v1/1-${snapshot.content_hash}.json`
  objects.set(key, new TextEncoder().encode('{"truncated":true}'))
  ports.s3.put = async (objectKey, _bytes, options) => {
    if (objectKey === key && options?.ifNoneMatch) throw { $metadata: { httpStatusCode: 412 } }
  }
  assert.equal(await publishSnapshot(ports, candidate(), 'live'), 'pending')
  assert.equal(objects.has('public/manifest.json'), false)
  assert.equal(publication().verifiedGeneration, 0)
  assert.equal(publication().pendingGeneration, 1)
})

test('retries a documented conditional 409 conflict once instead of swallowing it as pending', async () => {
  const { ports, events } = fixture()
  const put = ports.s3.put
  let conflicts = 0
  ports.s3.put = async (key, bytes, options) => {
    if (key.startsWith('snapshots/') && options?.ifNoneMatch && conflicts++ === 0) throw { $metadata: { httpStatusCode: 409 } }
    await put(key, bytes, options)
  }
  assert.equal(await publishSnapshot(ports, candidate(), 'live'), 'published')
  assert.equal(conflicts, 2)
  assert.ok(events.includes('verify:live:1'))
})

test('surfaces a repeated conditional 409 conflict instead of classifying it as ordinary pending', async () => {
  const { ports, publication } = fixture()
  ports.s3.put = async (key, _bytes, options) => {
    if (key.startsWith('snapshots/') && options?.ifNoneMatch) throw { $metadata: { httpStatusCode: 409 } }
  }
  await assert.rejects(() => publishSnapshot(ports, candidate(), 'live'), /SNAPSHOT_CONDITIONAL_CONFLICT/)
  assert.equal(publication().pendingGeneration, 1)
})

test('does not allocate or write when the canonical content hash is already verified', async () => {
  const { ports, events } = fixture()
  const snapshot = await buildPublicSnapshot(candidate().snapshot, 1)
  assert.equal(await publishSnapshot(ports, candidate(), 'live'), 'published')
  events.length = 0
  assert.equal(await publishSnapshot(ports, candidate(), 'live'), 'no_change')
  assert.deepEqual(events, ['clear:live:1'])
  assert.equal(canonicalSnapshotBytes(snapshot).byteLength > 0, true)
  assert.notEqual(snapshot.content_hash, hash)
})

for (const mode of ['live', 'shadow'] as const) {
  test(`clears an unclaimed ${mode} pending candidate when content returns to verified`, async () => {
    const { ports, publication } = fixture()
    assert.equal(await publishSnapshot(ports, candidate(), mode), 'published')

    const put = ports.s3.put
    ports.s3.put = async (key, bytes, options) => {
      if (key.includes('snapshots/')) throw new Error('B failed')
      await put(key, bytes, options)
    }
    assert.equal(await publishSnapshot(ports, candidate(1), mode), 'pending')
    assert.equal(publication(mode).pendingGeneration, 2)
    assert.equal(publication(mode).pendingClaimedAt, null)

    ports.s3.put = put
    assert.equal(await publishSnapshot(ports, candidate(), mode), 'no_change')
    assert.equal(publication(mode).pendingGeneration, null)
    assert.equal(await publishSnapshot(ports, candidate(2), mode), 'published')
    assert.equal(publication(mode).verifiedGeneration, 2)
  })
}
