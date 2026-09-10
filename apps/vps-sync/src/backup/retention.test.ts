import assert from 'node:assert/strict'
import test from 'node:test'
import { selectBackupDeletions } from './retention.ts'

const sha = 'a'.repeat(40)
const pair = (date: string, time: string) => {
  const stem = `backups/postgres/${date.replaceAll('-', '/')}/${date}T${time}-${sha}`
  return [`${stem}.dump`, `${stem}.json`]
}

test('keeps the latest point for each of the newest 30 calendar days and the last point of older months', () => {
  const newest = Array.from({ length: 31 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 2, 31 - index)).toISOString().slice(0, 10)
    return pair(date, '12-00-00-000Z')
  }).flat()
  const sameDayOlder = pair('2026-03-31', '00-00-00-001Z')
  const february = pair('2026-02-28', '00-00-00-000Z')
  const januaryOld = pair('2026-01-01', '00-00-00-000Z')
  const januaryLast = pair('2026-01-31', '23-59-59-999Z')

  assert.deepEqual(
    selectBackupDeletions([...newest, ...sameDayOlder, ...february, ...januaryOld, ...januaryLast]),
    [...pair('2026-03-01', '12-00-00-000Z'), ...sameDayOlder, ...januaryOld],
  )
})

test('refuses deletion when listed objects are not complete explicit backup pairs', () => {
  const complete = pair('2026-01-01', '00-00-00-000Z')
  assert.deepEqual(selectBackupDeletions([...complete, 'backups/postgres/2026/01/unsafe.dump']), [])
  assert.deepEqual(selectBackupDeletions([complete[0]!]), [])
  assert.deepEqual(selectBackupDeletions([
    ...complete,
    `backups/postgres/2026/01/02/2026-01-01T00-00-00-000Z-${sha}.dump`,
    `backups/postgres/2026/01/02/2026-01-01T00-00-00-000Z-${sha}.json`,
  ]), [])
})
