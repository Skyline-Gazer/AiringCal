import assert from 'node:assert/strict'
import test from 'node:test'
import { imageIndexKey, imageOriginalKey, imageStatusKey, snapshotCollectionsKey, subjectDetailKey, subjectMetaKey, subjectRefreshKey, syncRunKey, syncShadowKey, syncStagingKey } from './index.ts'

test('storage key builders expose stable KV and R2 contracts', () => {
  assert.equal(snapshotCollectionsKey('watching'), 'snapshot:collections:watching')
  assert.equal(subjectMetaKey(23080), 'subject:meta:23080')
  assert.equal(subjectDetailKey(23080), 'subject:detail:23080')
  assert.equal(imageStatusKey(23080), 'image:status:23080')
  assert.equal(imageIndexKey('a'.repeat(64)), `image:index:${'a'.repeat(64)}`)
  assert.equal(imageOriginalKey('a'.repeat(64)), `images/${'a'.repeat(64)}/original`)
  assert.equal(subjectRefreshKey(23080), 'subject:refresh:23080')
  assert.equal(syncRunKey('instance-1'), 'sync:run:instance-1')
  assert.equal(syncStagingKey('instance-1', 'collections:0'), 'sync:staging:instance-1:collections:0')
  assert.equal(syncShadowKey('instance-1', 'calendar'), 'snapshot:shadow:instance-1:calendar')
})
