import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runPortablePublicGc } from './portable-public-gc.ts'

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
