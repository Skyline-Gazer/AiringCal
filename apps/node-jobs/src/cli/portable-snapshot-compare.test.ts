import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { comparePortableSnapshotFiles } from './portable-snapshot-compare.ts'

test('comparePortableSnapshotFiles reports equal for same fixture file', async () => {
  const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..')
  const fixture = join(repoRoot, 'docs/v3/fixtures/public-snapshot-48-synthetic.json')
  const result = await comparePortableSnapshotFiles(fixture, fixture)
  assert.equal(result.equal, true)
  assert.deepEqual(result.diffs, [])
})
