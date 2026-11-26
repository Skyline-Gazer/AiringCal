import assert from 'node:assert/strict'
import test from 'node:test'
import {
  msUntilNextDailyAt,
  nextDailyRunUnix,
  parseDailyAtUtc,
  resolveScheduledSyncMode,
} from './sync-schedule.ts'

test('parseDailyAtUtc accepts UTC wall clock', () => {
  assert.deepEqual(parseDailyAtUtc('03:15'), { hour: 3, minute: 15 })
  assert.throws(() => parseDailyAtUtc('24:00'), /HH:MM/)
})

test('nextDailyRunUnix rolls to tomorrow after today slot passed', () => {
  const now = new Date('2026-01-02T10:00:00.000Z')
  const next = nextDailyRunUnix(now, { hour: 3, minute: 0 })
  assert.equal(next, Date.parse('2026-01-03T03:00:00.000Z'))
})

test('resolveScheduledSyncMode picks full when no prior full or interval elapsed', () => {
  const now = 1_000_000
  assert.equal(resolveScheduledSyncMode(now, 7, null), 'full')
  assert.equal(resolveScheduledSyncMode(now, 7, now - 7 * 86_400), 'full')
  assert.equal(resolveScheduledSyncMode(now, 7, now - 6 * 86_400), 'incremental')
})

test('msUntilNextDailyAt is non-negative', () => {
  const now = new Date('2026-01-02T02:00:00.000Z')
  const ms = msUntilNextDailyAt(now, { hour: 3, minute: 0 })
  assert.equal(ms, 3_600_000)
})
