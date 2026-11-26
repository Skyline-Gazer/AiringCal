import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { buildPublicSnapshot, canonicalSnapshotBytes, snapshotObjectKey } from '@airing-cal/domain'
import { FilesystemPublicStore, planPublicImageGc } from '@airing-cal/v3-core'
import {
  applyPublicImageGcPlan,
  logPublicSnapshotGcDryRun,
  runPortablePublicGc,
  runPortablePublicImageGc,
} from './portable-public-gc.ts'
import type { PublicCollectionItemV1 } from '@airing-cal/storage'

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

test('image GC retains images referenced by retained rollback generations (C9)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-gc-rollback-'))
  try {
    const store = new FilesystemPublicStore(root)
    const refs: Array<{ hash: string; gen: number }> = [
      { hash: 'a'.repeat(64), gen: 1 },
      { hash: 'b'.repeat(64), gen: 2 },
      { hash: 'c'.repeat(64), gen: 3 },
    ]
    const orphan = 'd'.repeat(64)
    for (const { hash, gen } of refs) {
      const snapshot = await buildPublicSnapshot({
        collections: [collectionItem(gen, hash)],
        calendar: [],
        published_at: 1_700_000_000 + gen,
      }, gen)
      await store.putImmutableObject(snapshotObjectKey(snapshot), canonicalSnapshotBytes(snapshot), 'application/json')
      mkdirSync(join(root, 'images', hash), { recursive: true })
      writeFileSync(join(root, 'images', hash, 'original'), hash)
    }
    mkdirSync(join(root, 'images', orphan), { recursive: true })
    writeFileSync(join(root, 'images', orphan, 'original'), orphan)
    mkdirSync(join(root, 'public'), { recursive: true })
    const currentSnapshot = await buildPublicSnapshot({
      collections: [collectionItem(3, refs[2].hash)],
      calendar: [],
      published_at: 1_700_000_003,
    }, 3)
    writeFileSync(
      join(root, 'public/current-release.json'),
      `${JSON.stringify({
        schema_version: 1,
        generation: 3,
        content_hash: currentSnapshot.content_hash,
        artifact_ref: snapshotObjectKey(currentSnapshot),
        published_at_unix: 1_700_000_003,
      })}\n`,
    )
    const { plan, applied } = await runPortablePublicImageGc({
      AIRINGCAL_BUILDER_PUBLIC_DIR: root,
    }, true)
    assert.ok(plan)
    assert.equal(applied, 1)
    // current + 2 prior rollback generations keep their images
    for (const { hash } of refs) {
      assert.ok(existsSync(join(root, 'images', hash, 'original')), `images/${hash} must be retained`)
    }
    assert.ok(!existsSync(join(root, 'images', orphan)))
    assert.deepEqual(plan.delete, [orphan])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('image GC fails closed when a retained snapshot cannot be parsed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-gc-failclosed-'))
  try {
    mkdirSync(join(root, 'snapshots/v1'), { recursive: true })
    mkdirSync(join(root, 'images', 'a'.repeat(64)), { recursive: true })
    mkdirSync(join(root, 'public'), { recursive: true })
    writeFileSync(
      join(root, 'public/current-release.json'),
      `${JSON.stringify({
        schema_version: 1,
        generation: 3,
        content_hash: 'b'.repeat(64),
        artifact_ref: `snapshots/v1/3-${'b'.repeat(64)}.json`,
        published_at_unix: 1,
      })}\n`,
    )
    await assert.rejects(
      () => runPortablePublicImageGc({ AIRINGCAL_BUILDER_PUBLIC_DIR: root }, true),
      /retained snapshot/i,
    )
    // fail closed: nothing deleted
    assert.ok(existsSync(join(root, 'images', 'a'.repeat(64))))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('runPortablePublicGc dry-run never deletes files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-gc-'))
  const snapDir = join(root, 'snapshots/v1')
  mkdirSync(snapDir, { recursive: true })
  for (const gen of [1, 2, 3, 4, 5, 6]) {
    writeFileSync(join(snapDir, `${gen}-${'a'.repeat(64)}.json`), '{}')
  }
  mkdirSync(join(root, 'public'), { recursive: true })
  writeFileSync(
    join(root, 'public/current-release.json'),
    `${JSON.stringify({
      schema_version: 1,
      generation: 2,
      content_hash: 'a'.repeat(64),
      artifact_ref: `snapshots/v1/2-${'a'.repeat(64)}.json`,
      published_at_unix: 1,
    })}\n`,
  )
  const { plan, applied } = await runPortablePublicGc({
    AIRINGCAL_BUILDER_PUBLIC_DIR: root,
    AIRINGCAL_GC_MIN_GENERATIONS: '3',
  }, false)
  assert.equal(applied, 0)
  assert.ok(plan.delete.includes(`snapshots/v1/3-${'a'.repeat(64)}.json`))
})

test('logPublicSnapshotGcDryRun returns plan without deleting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-gc-log-'))
  const snapDir = join(root, 'snapshots/v1')
  mkdirSync(snapDir, { recursive: true })
  mkdirSync(join(root, 'public'), { recursive: true })
  const hash = 'a'.repeat(64)
  writeFileSync(join(snapDir, `1-${hash}.json`), '{"published_at":1}')
  writeFileSync(join(snapDir, `2-${hash}.json`), '{"published_at":2}')
  writeFileSync(
    join(root, 'public/current-release.json'),
    `${JSON.stringify({
      schema_version: 1,
      generation: 2,
      content_hash: hash,
      artifact_ref: `snapshots/v1/2-${hash}.json`,
      published_at_unix: 2,
    })}\n`,
  )
  const plan = await logPublicSnapshotGcDryRun({
    AIRINGCAL_BUILDER_PUBLIC_DIR: root,
    AIRINGCAL_GC_MIN_GENERATIONS: '1',
    AIRINGCAL_GC_ROLLBACK_GENERATIONS: '0',
  })
  assert.deepEqual(plan.delete, [`snapshots/v1/1-${hash}.json`])
})

test('applyPublicImageGcPlan removes only planned orphan hash directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-img-gc-'))
  const ref = 'a'.repeat(64)
  const orphan = 'b'.repeat(64)
  mkdirSync(join(root, 'images', ref), { recursive: true })
  mkdirSync(join(root, 'images', orphan), { recursive: true })
  const plan = planPublicImageGc({
    onDiskHashes: [ref, orphan],
    referencedHashes: new Set([ref]),
  })
  assert.equal(applyPublicImageGcPlan(root, plan), 1)
  assert.ok(existsSync(join(root, 'images', ref)))
  assert.ok(!existsSync(join(root, 'images', orphan)))
})
