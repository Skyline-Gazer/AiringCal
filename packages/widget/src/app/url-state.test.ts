import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_BROWSE, parseBrowseState, writeBrowseState } from './url-state.ts'

test('browse state accepts only known views, types, pages and days', () => {
  assert.deepEqual(parseBrowseState('?view=calendar&type=watched&page=3&day=6'), {
    view: 'calendar',
    type: 'watched',
    page: 3,
    day: 6,
  })
  assert.deepEqual(parseBrowseState('?view=nope&type=nope&page=0&day=9'), DEFAULT_BROWSE)
  assert.deepEqual(parseBrowseState(''), DEFAULT_BROWSE)
})

test('browse state writes only owned keys and preserves host parameters', () => {
  const search = writeBrowseState('?host=1', { view: 'calendar', type: 'watching', page: 2, day: 3 })
  const params = new URLSearchParams(search)
  assert.equal(params.get('host'), '1')
  assert.equal(params.get('view'), 'calendar')
  assert.equal(params.get('page'), '2')
  assert.equal(params.get('day'), '3')

  const collection = new URLSearchParams(writeBrowseState(search, { view: 'collection', type: 'want', page: 1, day: 3 }))
  assert.equal(collection.get('day'), null)
  assert.equal(collection.get('page'), null)
  assert.equal(collection.get('type'), 'want')
})
