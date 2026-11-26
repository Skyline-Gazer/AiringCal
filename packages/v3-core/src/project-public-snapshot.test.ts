import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleFullFetch } from '@airing-cal/bgm-api'
import { projectPublicSnapshotInput } from './project-public-snapshot.ts'

test('projectPublicSnapshotInput flattens fetch into public snapshot input', () => {
  const input = assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 0, data: [] }] }],
    [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
    1_700_000_000,
  )
  const projected = projectPublicSnapshotInput(input)
  assert.equal(projected.collections.length, 0)
  assert.equal(projected.published_at, 1_700_000_000)
  assert.equal(projected.calendar.length, 1)
  assert.equal(projected.calendar[0]?.weekday.en, 'Mon')
})
