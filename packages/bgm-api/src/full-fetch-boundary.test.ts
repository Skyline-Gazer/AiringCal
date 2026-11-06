import assert from 'node:assert/strict'
import test from 'node:test'
import { BgmClient, type BgmCalendarItem } from './bgm-client.ts'
import { assembleFullFetch } from './full-fetch-boundary.ts'

function calendarDay(items: unknown[]): unknown {
  return [
    {
      weekday: { en: 'Mon', cn: '星期一', ja: '月耀日', id: 1 },
      items,
    },
  ]
}

function baseItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 501,
    type: 2,
    name: 'Test',
    name_cn: '测试',
    summary: '',
    date: '2026-10-06',
    eps: 12,
    images: {
      large: 'https://example.test/l.jpg',
      common: 'https://example.test/c.jpg',
      medium: 'https://example.test/m.jpg',
      small: 'https://example.test/s.jpg',
      grid: 'https://example.test/g.jpg',
    },
    ...overrides,
  }
}

test('assembleFullFetch accepts null optional calendar fields as absent', () => {
  const result = assembleFullFetch(
    [],
    calendarDay([
      baseItem({ images: null, date: null, name: null, name_cn: null, summary: null }),
    ]),
    1_700_000_000,
  )
  const item = result.calendar[0]?.items[0] as BgmCalendarItem['items'][number] & Record<string, unknown>
  assert.equal(item.id, 501)
  assert.equal(item.images, undefined)
  assert.equal(item.date, undefined)
  assert.equal(item.name, undefined)
  assert.equal(item.name_cn, undefined)
  assert.equal(item.summary, undefined)
})

test('assembleFullFetch still rejects wrong-typed optional calendar fields', () => {
  assert.throws(
    () => assembleFullFetch([], calendarDay([baseItem({ images: 'not-an-object' })]), 1_700_000_000),
    /Incomplete calendar fetch/,
  )
})

test('BgmClient remains the base class used for strict client checks', () => {
  const client = new BgmClient(undefined, { maxGetRetries: 0 })
  assert.equal(client.maxGetRetries, 0)
})
