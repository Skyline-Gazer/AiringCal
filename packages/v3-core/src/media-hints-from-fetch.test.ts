import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleFullFetch } from '@airing-cal/bgm-api'
import { mediaPublishHintsFromFetch } from './media-hints-from-fetch.ts'
import { projectPublicSnapshotInput } from './project-public-snapshot.ts'

const LARGE_URL = 'https://lain.bgm.tv/pic/cover/l/large.jpg'

test('mediaPublishHintsFromFetch marks calendar large source as pending_next_cron in projection', () => {
  const input = assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 0, data: [] }] }],
    [{
      weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 },
      items: [{
        id: 42,
        type: 2,
        name: 'Test',
        name_cn: '',
        summary: '',
        images: { large: LARGE_URL },
        eps: 12,
        air_date: '2026-01-01',
        air_weekday: 1,
        nsfw: false,
      }],
    }],
    1_700_000_000,
  )
  const hints = mediaPublishHintsFromFetch(input)
  assert.equal(hints.get(42)?.hasSourceLarge, true)
  assert.equal(hints.get(42)?.hasSourceCommon, false)

  const projected = projectPublicSnapshotInput(input, new Map(), new Map(), new Map(), hints)
  const item = projected.calendar[0]?.items[0]
  assert.equal(item?.image_status.large, 'pending_next_cron')
  assert.equal(item?.image_status.common, 'missing_source')
})
