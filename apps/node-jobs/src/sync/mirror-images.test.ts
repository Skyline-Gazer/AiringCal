import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryPublicStore } from '@airing-cal/v3-core'
import { mirrorImageRootToPublicStore } from './mirror-images.ts'

test('mirrorImageRootToPublicStore uploads images tree as immutable objects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-img-'))
  const hash = 'a'.repeat(64)
  mkdirSync(join(root, 'images', hash), { recursive: true })
  writeFileSync(join(root, 'images', hash, 'original'), 'orig')
  writeFileSync(join(root, 'images', hash, 'thumb.v2.webp'), 'thumb')
  writeFileSync(join(root, 'ignore.txt'), 'nope')
  const store = new MemoryPublicStore()
  try {
    const result = await mirrorImageRootToPublicStore(root, store)
    assert.equal(result.uploaded, 2)
    assert.deepEqual(
      new TextDecoder().decode((await store.getSnapshotBytes(`images/${hash}/original`))!),
      'orig',
    )
    assert.deepEqual(
      new TextDecoder().decode((await store.getSnapshotBytes(`images/${hash}/thumb.v2.webp`))!),
      'thumb',
    )
    assert.equal(await store.getSnapshotBytes('ignore.txt'), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
