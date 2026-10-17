import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { measureSnapshotSizing, SINGLE_SNAPSHOT_GZIP_LIMIT_BYTES } from './portable-snapshot-sizing.ts'

const fixturePath = fileURLToPath(new URL('../../../../docs/v3/fixtures/public-snapshot-48-synthetic.json', import.meta.url))

test('measured 48-item fixture stays under the single-JSON gzip limit', async () => {
  const report = await measureSnapshotSizing(fixturePath)
  assert.equal(report.items.collections, 48)
  assert.equal(report.single_json_viable, true)
  assert.ok(report.gzip_bytes < SINGLE_SNAPSHOT_GZIP_LIMIT_BYTES)
  // Collections dominate the payload, matching the frontend read pattern.
  assert.ok((report.sections_kib.collections?.percent ?? 0) > 60)
})

test('sizing rejects a file that is not a valid PublicSnapshotV1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-sizing-'))
  const path = join(dir, 'not-snapshot.json')
  writeFileSync(path, JSON.stringify({ foo: 'bar' }))
  await assert.rejects(() => measureSnapshotSizing(path), /public snapshot/i)
})
