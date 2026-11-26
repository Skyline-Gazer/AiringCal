import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildManifest,
  buildPublicSnapshot,
  canonicalSnapshotBytes,
  manifestObjectKey,
  snapshotObjectKey,
} from '@airing-cal/domain'
import { canonicalJson, imageOriginalKey, sha256Canonical } from '@airing-cal/storage'
import { FilesystemPublicStore } from '@airing-cal/v3-core'
import type { PublicCollectionItemV1 } from '@airing-cal/storage'
import { MemoryObjectStore } from '../adapters/memory-object-store.ts'
import { S3CompatiblePublicStore } from '../adapters/s3-public-store.ts'
import {
  DEFAULT_CHECKPOINT_LEASE_KEY,
  acquireCheckpointLease,
} from '../adapters/s3-checkpoint-store.ts'
import {
  assertReceiptWritable,
  buildRollbackPointer,
  rollbackReleasePointer,
  resolveRollbackTarget,
} from './portable-release-rollback.ts'

test('assertReceiptWritable rejects a receipt path whose directory is missing', () => {
  assert.throws(() => assertReceiptWritable('/definitely/missing/dir/receipt.json'), /--receipt directory does not exist/)
})

test('assertReceiptWritable resolves an existing receipt directory to an absolute path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-receipt-'))
  try {
    assert.equal(assertReceiptWritable(join(dir, 'receipt.json')), join(dir, 'receipt.json'))
    assert.equal(assertReceiptWritable(null), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const GIT_SHA = 'a'.repeat(40)

function collectionItem(subjectId: number, hash: string): PublicCollectionItemV1 {
  return {
    subject_id: subjectId,
    name: `s${subjectId}`,
    name_cn: '',
    summary: '',
    images: { common: { hash, uri: '', r2_key: '' }, large: null },
    image_status: { common: 'cached', large: 'missing_source' },
    eps: 0,
    total_episodes: 0,
    ep_status: 0,
    vol_status: 0,
    type: 2,
    collection_type: 1,
    rate: 0,
    nsfw: false,
    date: '',
    tags: [],
    updated_at: '',
  }
}

interface Fixture {
  store: S3CompatiblePublicStore
  objects: MemoryObjectStore
  snapshots: Map<number, Awaited<ReturnType<typeof buildPublicSnapshot>>>
}

async function seedGeneration(fixture: Fixture, generation: number, imageHash: string): Promise<void> {
  const snapshot = await buildPublicSnapshot({
    collections: [collectionItem(generation, imageHash)],
    calendar: [],
    published_at: 1_700_000_000 + generation,
  }, generation)
  fixture.snapshots.set(generation, snapshot)
  await fixture.store.putImmutableObject(snapshotObjectKey(snapshot), canonicalSnapshotBytes(snapshot), 'application/json')
  await fixture.store.putImmutableObject(imageOriginalKey(imageHash), new TextEncoder().encode(`image-${imageHash}`), 'image/jpeg')
  const manifest = buildManifest(snapshot, { source_observed_at: '2026-11-05T00:00:00.000Z', git_sha: GIT_SHA })
  await fixture.store.putImmutableObject(
    manifestObjectKey(generation, await sha256Canonical(manifest)),
    new TextEncoder().encode(canonicalJson(manifest)),
    'application/json',
  )
}

async function seedStore(): Promise<Fixture> {
  const objects = new MemoryObjectStore()
  const store = new S3CompatiblePublicStore(objects)
  const fixture: Fixture = { store, objects, snapshots: new Map() }
  for (const [generation, hash] of [[1, 'a'.repeat(64)], [2, 'b'.repeat(64)], [3, 'c'.repeat(64)]] as const) {
    await seedGeneration(fixture, generation, hash)
  }
  const current = fixture.snapshots.get(3)!
  const commit = await store.commitRelease(null, {
    schema_version: 1,
    generation: 3,
    content_hash: current.content_hash,
    published_at_unix: current.published_at,
    artifact_ref: snapshotObjectKey(current),
    manifest_ref: manifestObjectKey(3, await sha256Canonical(buildManifest(current, { source_observed_at: '2026-11-05T00:00:00.000Z', git_sha: GIT_SHA }))),
  })
  assert.equal(commit, 'committed')
  return fixture
}

test('rollback dry run resolves target, manifest, and images without touching the pointer', async () => {
  const fixture = await seedStore()
  const before = await fixture.store.getCurrentRelease()
  const receipt = await rollbackReleasePointer({ publicStore: fixture.store }, 2, { apply: false, writerFrozenAttested: false })
  assert.equal(receipt.dry_run, true)
  assert.equal(receipt.cas_result, 'not_attempted')
  assert.equal(receipt.target_generation, 2)
  assert.equal(receipt.prior_pointer?.generation, 3)
  assert.equal(receipt.target_pointer.generation, 2)
  assert.equal(receipt.target_pointer.content_hash, fixture.snapshots.get(2)!.content_hash)
  assert.ok(receipt.target_pointer.manifest_ref?.startsWith('public/manifests/2-'))
  assert.equal(receipt.image_gate.reused >= 1, true)
  const after = await fixture.store.getCurrentRelease()
  assert.deepEqual(after, before)
})

test('rollback apply CAS-commits the pointer back to the target generation with a receipt', async () => {
  const fixture = await seedStore()
  const receipt = await rollbackReleasePointer({ publicStore: fixture.store }, 1, {
    apply: true,
    writerFrozenAttested: true,
  })
  assert.equal(receipt.cas_result, 'committed')
  assert.equal(receipt.writer_frozen_attested, true)
  const pointer = await fixture.store.getCurrentRelease()
  assert.equal(pointer?.generation, 1)
  assert.equal(pointer?.content_hash, fixture.snapshots.get(1)!.content_hash)
  assert.equal(pointer?.manifest_ref, receipt.target_pointer.manifest_ref)
  assert.match(receipt.resume_rule, /AIRINGCAL_WRITER_ENABLED/)
})

test('rollback refuses to move the pointer forward', async () => {
  const fixture = await seedStore()
  await assert.rejects(
    () => rollbackReleasePointer({ publicStore: fixture.store }, 4, { apply: true, writerFrozenAttested: true }),
    /must be lower than current/,
  )
})

test('rollback requires the writer-freeze attestation before applying', async () => {
  const fixture = await seedStore()
  await assert.rejects(
    () => rollbackReleasePointer({ publicStore: fixture.store }, 2, { apply: true, writerFrozenAttested: false }),
    /writer.*frozen/i,
  )
})

test('rollback fails closed when a referenced image is missing from the public store', async () => {
  const fixture = await seedStore()
  // gen 1's image exists; drop it to simulate GC damage on a rollback candidate
  await fixture.objects.delete(imageOriginalKey('a'.repeat(64)))
  await assert.rejects(
    () => rollbackReleasePointer({ publicStore: fixture.store }, 1, { apply: true, writerFrozenAttested: true }),
    /publish gate/i,
  )
  const pointer = await fixture.store.getCurrentRelease()
  assert.equal(pointer?.generation, 3, 'pointer must not move on a failed rollback')
})

test('rollback refuses when the checkpoint lease is held by an in-flight writer', async () => {
  const fixture = await seedStore()
  const checkpoint = new MemoryObjectStore()
  await acquireCheckpointLease(checkpoint, { ownerToken: 'writer-run', nowUnix: 1_000, ttlSeconds: 600 })
  await assert.rejects(
    () => rollbackReleasePointer({ publicStore: fixture.store, checkpointStore: checkpoint, nowUnix: 1_010 }, 2, { apply: true, writerFrozenAttested: true }),
    /lease held/,
  )
  const pointer = await fixture.store.getCurrentRelease()
  assert.equal(pointer?.generation, 3)
})

test('rollback acquires and releases the checkpoint lease around the commit', async () => {
  const fixture = await seedStore()
  const checkpoint = new MemoryObjectStore()
  const receipt = await rollbackReleasePointer(
    { publicStore: fixture.store, checkpointStore: checkpoint, nowUnix: 1_000 },
    2,
    { apply: true, writerFrozenAttested: true },
  )
  assert.equal(receipt.cas_result, 'committed')
  assert.equal(receipt.checkpoint_lease.checked, true)
  const leaseRaw = await checkpoint.get(DEFAULT_CHECKPOINT_LEASE_KEY)
  assert.ok(leaseRaw)
  const lease = JSON.parse(new TextDecoder().decode(leaseRaw.body)) as { owner_token: string; expires_at_unix: number }
  assert.equal(lease.owner_token, '', 'lease must be released (expire put, no delete)')
  assert.equal(lease.expires_at_unix, 0)
})

test('rollback pointer commit conflicts when the current pointer moved concurrently', async () => {
  const fixture = await seedStore()
  const target = await resolveRollbackTarget({ publicStore: fixture.store }, 2)
  assert.ok(target, 'target must resolve')
  const pointer = buildRollbackPointer(target)
  // Simulate a concurrent writer: move the pointer to a different release after
  // the rollback target was resolved. Pointer CAS is logical (generation+hash),
  // so the moved pointer must differ from target.current to force a conflict.
  const gen2 = fixture.snapshots.get(2)!
  const moved = await fixture.store.commitRelease(await fixture.store.getCurrentRelease(), {
    schema_version: 1,
    generation: 2,
    content_hash: gen2.content_hash,
    published_at_unix: gen2.published_at,
    artifact_ref: snapshotObjectKey(gen2),
    manifest_ref: 'public/manifests/2-' + 'e'.repeat(64) + '.json',
  })
  assert.equal(moved, 'committed')
  const result = await fixture.store.commitRelease(target.current, pointer)
  assert.equal(result, 'conflict')
})

test('rollback to a pre-C1 generation without a verifiable manifest is refused when a foreign legacy manifest exists', async () => {
  const fixture = await seedStore()
  // Remove gen 1's versioned manifest, then plant a legacy manifest describing gen 3.
  const gen1 = fixture.snapshots.get(1)!
  const manifest = buildManifest(gen1, { source_observed_at: '2026-11-05T00:00:00.000Z', git_sha: GIT_SHA })
  const key = manifestObjectKey(1, await sha256Canonical(manifest))
  await fixture.objects.delete(key)
  const gen3 = fixture.snapshots.get(3)!
  const foreign = buildManifest(gen3, { source_observed_at: '2026-11-05T00:00:00.000Z', git_sha: GIT_SHA })
  await fixture.store.putImmutableObject('public/manifest.json', new TextEncoder().encode(canonicalJson(foreign)), 'application/json')
  await assert.rejects(
    () => rollbackReleasePointer({ publicStore: fixture.store }, 1, { apply: true, writerFrozenAttested: true }),
    /manifest/i,
  )
})

test('filesystem stores work as rollback targets via directory listing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-rollback-fs-'))
  try {
    const store = new FilesystemPublicStore(root)
    for (const [generation, hash] of [[1, 'a'.repeat(64)], [2, 'b'.repeat(64)]] as const) {
      const snapshot = await buildPublicSnapshot({
        collections: [collectionItem(generation, hash)],
        calendar: [],
        published_at: 1_700_000_000 + generation,
      }, generation)
      await store.putImmutableObject(snapshotObjectKey(snapshot), canonicalSnapshotBytes(snapshot), 'application/json')
      await store.putImmutableObject(imageOriginalKey(hash), new TextEncoder().encode(hash), 'image/jpeg')
      const manifest = buildManifest(snapshot, { source_observed_at: '2026-11-05T00:00:00.000Z', git_sha: GIT_SHA })
      await store.putImmutableObject(
        manifestObjectKey(generation, await sha256Canonical(manifest)),
        new TextEncoder().encode(canonicalJson(manifest)),
        'application/json',
      )
      if (generation === 2) {
        await store.commitRelease(null, {
          schema_version: 1,
          generation: 2,
          content_hash: snapshot.content_hash,
          published_at_unix: snapshot.published_at,
          artifact_ref: snapshotObjectKey(snapshot),
          manifest_ref: manifestObjectKey(generation, await sha256Canonical(manifest)),
        })
      }
    }
    const receipt = await rollbackReleasePointer({ publicStore: store }, 1, { apply: true, writerFrozenAttested: true })
    assert.equal(receipt.cas_result, 'committed')
    const pointer = await store.getCurrentRelease()
    assert.equal(pointer?.generation, 1)
    assert.ok(pointer?.manifest_ref?.startsWith('public/manifests/1-'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rollback list helper ignores mkdirSync-only empty dirs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-rollback-empty-'))
  try {
    const store = new FilesystemPublicStore(root)
    mkdirSync(join(root, 'snapshots/v1'), { recursive: true })
    writeFileSync(join(root, 'snapshots/v1/.keep'), '')
    const target = await resolveRollbackTarget({ publicStore: store }, 0)
    assert.equal(target, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
