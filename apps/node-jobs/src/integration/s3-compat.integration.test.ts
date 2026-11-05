import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  acquireCheckpointLease,
  releaseCheckpointLease,
  renewCheckpointLease,
  restoreCheckpointToFile,
  uploadCheckpointFromFile,
} from '../adapters/s3-checkpoint-store.ts'
import { createS3ObjectStore } from '../adapters/s3-object-store.ts'
import { ObjectStorePreconditionError } from '../adapters/object-store.ts'
import { S3CompatiblePublicStore } from '../adapters/s3-public-store.ts'

/**
 * C10: conditional put / CAS / 412 compatibility suite for real S3-compatible
 * object stores (CI runs it against MinIO). PASS here proves S3-API conditional
 * semantics ONLY — it is explicitly NOT a real-R2 PASS (label: compatibility-only).
 */

const ENDPOINT = process.env.AIRINGCAL_S3_COMPAT_ENDPOINT?.trim()
const BUCKET = process.env.AIRINGCAL_S3_COMPAT_BUCKET?.trim() || 'airingcal-compat'
const ACCESS_KEY_ID = process.env.AIRINGCAL_S3_COMPAT_ACCESS_KEY_ID?.trim()
const SECRET_ACCESS_KEY = process.env.AIRINGCAL_S3_COMPAT_SECRET_ACCESS_KEY?.trim()
const SKIP_REASON = 'AIRINGCAL_S3_COMPAT_* not configured (run against MinIO in CI)'

interface CompatStore {
  objects: ReturnType<typeof createS3ObjectStore>
  sqliteDir: string
}

function makeCompat(): CompatStore | null {
  if (!ENDPOINT || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY) return null
  return {
    objects: createS3ObjectStore({
      endpoint: ENDPOINT,
      region: 'auto',
      bucket: BUCKET,
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    }),
    sqliteDir: mkdtempSync(join(tmpdir(), 'airingcal-compat-')),
  }
}

function writeSqlite(dir: string, tag: string): string {
  const path = join(dir, `builder-${tag}.sqlite`)
  writeFileSync(path, `sqlite-compat-bytes-${tag}`)
  return path
}

test('s3 compat: conditional put and 412 semantics (If-None-Match */If-Match)', { skip: !ENDPOINT && SKIP_REASON }, async () => {
  const compat = makeCompat()
  assert.ok(compat, 'compat object store must be constructible')
  const { objects } = compat
  const prefix = `ci/${randomUUID()}/`
  try {
    const body1 = new TextEncoder().encode('conditional-put-body')
    // First create with If-None-Match * succeeds...
    const head1 = await objects.put(`${prefix}cond.json`, body1, { ifNoneMatch: '*' })
    assert.ok(head1.etag)
    // ...a second create with If-None-Match * must fail with 412 (precondition).
    await assert.rejects(
      () => objects.put(`${prefix}cond.json`, body1, { ifNoneMatch: '*' }),
      ObjectStorePreconditionError,
    )
    // If-Match against the observed etag succeeds; a stale etag must 412.
    const head2 = await objects.put(`${prefix}cond.json`, new TextEncoder().encode('v2'), { ifMatch: head1.etag })
    await assert.rejects(
      () => objects.put(`${prefix}cond.json`, new TextEncoder().encode('v3'), { ifMatch: head1.etag }),
      ObjectStorePreconditionError,
    )
    assert.ok(head2.etag)
    // HEAD exposes size + etag; list returns keys under the prefix.
    const head = await objects.head(`${prefix}cond.json`)
    assert.equal(head?.size, 2)
    assert.deepEqual(await objects.list(prefix), [`${prefix}cond.json`])
  } finally {
    await objects.delete?.(`${prefix}cond.json`)
    objects.close()
    rmSync(compat.sqliteDir, { recursive: true, force: true })
  }
})

test('s3 compat: immutable public store put + pointer CAS conflict', { skip: !ENDPOINT && SKIP_REASON }, async () => {
  const compat = makeCompat()
  assert.ok(compat)
  const store = new S3CompatiblePublicStore(compat.objects)
  const { objects } = compat
  const prefix = `ci/${randomUUID()}`
  try {
    // Immutable put: same bytes are a no-op, different bytes are rejected.
    const bytes = new TextEncoder().encode(`snapshot-${prefix}`)
    await store.putImmutableObject(`${prefix}/snap.json`, bytes, 'application/json')
    await store.putImmutableObject(`${prefix}/snap.json`, bytes, 'application/json')
    await assert.rejects(
      () => store.putImmutableObject(`${prefix}/snap.json`, new TextEncoder().encode('other'), 'application/json'),
    )
    // Pointer CAS: first commit, expected-pointer advance, then stale expected conflicts.
    const pointerV1 = {
      schema_version: 1,
      generation: 1,
      content_hash: 'a'.repeat(64),
      published_at_unix: 1,
      artifact_ref: `${prefix}/snap.json`,
    }
    assert.equal(await store.commitRelease(null, pointerV1), 'committed')
    const pointerV2 = { ...pointerV1, generation: 2, content_hash: 'b'.repeat(64), artifact_ref: `${prefix}/snap2.json` }
    assert.equal(await store.commitRelease(pointerV1, pointerV2), 'committed')
    assert.equal(await store.commitRelease(pointerV1, { ...pointerV1, generation: 9 }), 'conflict')
    await objects.delete?.(`${prefix}/snap2.json`)
  } finally {
    await objects.delete?.(`${prefix}/snap.json`)
    objects.close()
    rmSync(compat.sqliteDir, { recursive: true, force: true })
  }
})

test('s3 compat: checkpoint CAS upload + lease lifecycle', { skip: !ENDPOINT && SKIP_REASON }, async () => {
  const compat = makeCompat()
  assert.ok(compat)
  const { objects, sqliteDir } = compat
  const sqliteA = writeSqlite(sqliteDir, 'v1')
  const sqliteB = writeSqlite(sqliteDir, 'v2')
  const sqliteC = writeSqlite(sqliteDir, 'v3')
  const leaseKey = `ci/${randomUUID()}/lease.json`
  try {
    // Checkpoint CAS: first create with If-None-Match *; a concurrent create without
    // a prior etag must precondition-fail; stale If-Match must precondition-fail.
    const uploaded = await uploadCheckpointFromFile(objects, sqliteA, `ci/${randomUUID()}/builder.sqlite`)
    assert.equal(uploaded.status, 'uploaded')
    const key = uploaded.key
    const conflict = await uploadCheckpointFromFile(objects, sqliteB, key)
    assert.equal(conflict.status, 'precondition_failed')
    const ok = await uploadCheckpointFromFile(objects, sqliteB, key, { priorEtag: uploaded.etag })
    assert.equal(ok.status, 'uploaded')
    const stale = await uploadCheckpointFromFile(objects, sqliteC, key, { priorEtag: uploaded.etag })
    assert.equal(stale.status, 'precondition_failed')
    const restoredPath = join(sqliteDir, 'restored.sqlite')
    const restored = await restoreCheckpointToFile(objects, restoredPath, key)
    assert.equal(restored.status, 'restored')

    // Lease lifecycle: acquire → renew → foreign renew lost → release is an expire put.
    const acquired = await acquireCheckpointLease(objects, { ownerToken: 'ci-runner', nowUnix: 1_000, ttlSeconds: 60, leaseKey })
    assert.equal(acquired.status, 'acquired')
    const renewed = await renewCheckpointLease(objects, { ownerToken: 'ci-runner', nowUnix: 1_010, ttlSeconds: 60, leaseKey })
    assert.equal(renewed.status, 'renewed')
    const foreign = await renewCheckpointLease(objects, { ownerToken: 'other', nowUnix: 1_020, ttlSeconds: 60, leaseKey })
    assert.equal(foreign.status, 'lost')
    await releaseCheckpointLease(objects, 'ci-runner', leaseKey)
    const raw = await objects.get(leaseKey)
    assert.ok(raw, 'lease object must survive release (expire put, no DELETE)')
    const lease = JSON.parse(new TextDecoder().decode(raw.body)) as { owner_token: string }
    assert.equal(lease.owner_token, '')
  } finally {
    objects.close()
    rmSync(sqliteDir, { recursive: true, force: true })
  }
})
