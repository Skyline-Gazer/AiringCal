import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSelectedDay, shortWeekdayLabel, todayWeekdayId, weekdayLabel } from './weekday.ts'

test('today maps Sunday to 7 and Monday to 1', () => {
  assert.equal(todayWeekdayId(new Date(2026, 10, 23, 12)), 1) // Monday
  assert.equal(todayWeekdayId(new Date(2026, 10, 27, 12)), 5) // Friday
  assert.equal(todayWeekdayId(new Date(2026, 10, 29, 12)), 7) // Sunday
})

test('selection survives re-render and falls back to today, then to the first day', () => {
  assert.equal(resolveSelectedDay(3, [1, 2, 3, 4, 5, 6, 7], 5), 3)
  assert.equal(resolveSelectedDay(null, [1, 2, 3], 5), 1)
  assert.equal(resolveSelectedDay(9, [1, 2, 3], 2), 2)
  assert.equal(resolveSelectedDay(2, [], 4), 4)
})

test('weekday labels come from data and fall back to constants', () => {
  assert.equal(shortWeekdayLabel({ cn: '星期三' }, 3), '周三')
  assert.equal(shortWeekdayLabel({ en: 'Wed' }, 3), 'Wed')
  assert.equal(weekdayLabel(7).cn, '星期日')
})
