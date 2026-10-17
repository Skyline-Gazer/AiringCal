import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { build48ItemPublicSnapshotFixture } from './snapshot-fixture-48.ts'

const fixturePath = fileURLToPath(new URL('../../../docs/v3/fixtures/public-snapshot-48-synthetic.json', import.meta.url))

test('measured fixture snapshot size baseline for split-json decision (#69)', async () => {
  const snapshot = await build48ItemPublicSnapshotFixture()
  const json = JSON.stringify(snapshot)
  const gzipBytes = gzipSync(json)

  assert.ok(json.length > 10_000, 'fixture should be non-trivial')
  assert.ok(gzipBytes.length < json.length, 'gzip should compress JSON snapshot')
  assert.ok(gzipBytes.length < 500_000, '48-item fixture gzip stays under 500KiB — single JSON likely viable')
})

test('committed docs fixture matches 48-item synthetic snapshot (#69)', async () => {
  const expected = await build48ItemPublicSnapshotFixture()
  const onDisk = JSON.parse(readFileSync(fixturePath, 'utf8'))
  assert.equal(onDisk.content_hash, expected.content_hash)
  assert.equal(onDisk.generation, expected.generation)
  const itemCount = Object.values(onDisk.collections as Record<string, unknown[]>)
    .reduce((sum, bucket) => sum + bucket.length, 0)
  assert.equal(itemCount, 48)
})
