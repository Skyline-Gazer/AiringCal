import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parsePublicSnapshotV1 } from '@airing-cal/domain'
import { compareShadowSnapshots, normalizePublicResult } from '@airing-cal/storage'
import { normalizeV2PublicExport } from './portable-v2-public-normalize.ts'

function loadFixture(name: string): unknown {
  const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..')
  return JSON.parse(readFileSync(join(repoRoot, 'docs/v3/fixtures', name), 'utf8'))
}

test('normalizeV2PublicExport accepts PublicSnapshotV1 fixture', async () => {
  const fixture = loadFixture('public-snapshot-48-synthetic.json')
  const normalized = await normalizeV2PublicExport(fixture)
  const direct = normalizePublicResult(await parsePublicSnapshotV1(fixture))
  assert.deepEqual(normalized, direct)
})

test('normalizeV2PublicExport accepts legacy public result with hydration sidecar', async () => {
  const legacy = {
    collections: {
      want: [],
      watched: [{
        subject_id: 1,
        name: 'A',
        name_cn: '',
        summary: '',
        images: { common: null, large: null },
        image_status: { common: 'cached', large: 'pending_next_cron' },
        eps: 1,
        total_episodes: 12,
        ep_status: 0,
        vol_status: 0,
        type: 2,
        collection_type: 'watched',
        rate: 0,
        nsfw: false,
        date: '',
        tags: [],
        updated_at: 0,
      }],
      watching: [],
      on_hold: [],
      dropped: [],
    },
    calendar: [],
    summary: { want: 0, watched: 1, watching: 0, on_hold: 0, dropped: 0, _total: 1 },
  }
  const hydrated = {
    1: {
      images: { common: { hash: 'abc', uri: '/image/abc', r2_key: 'images/abc/original' }, large: null },
      image_status: { common: 'cached', large: 'pending_next_cron' },
    },
  }
  const normalized = await normalizeV2PublicExport(legacy, hydrated)
  assert.equal(normalized.collections.watched.length, 1)
  assert.equal(normalized.collections.watched[0]?.images.common?.hash, 'abc')
})

test('normalizeV2PublicExport pairs with compareShadowSnapshots', async () => {
  const fixture = loadFixture('public-snapshot-48-synthetic.json')
  const left = await normalizeV2PublicExport(fixture)
  const right = await normalizeV2PublicExport(fixture)
  assert.equal(compareShadowSnapshots(left, right).equal, true)
})
