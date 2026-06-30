import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./bangumi.js', import.meta.url), 'utf8')

test('public sync sends compared usernames instead of display placeholders', () => {
  assert.ok(source.includes('syncState.data.userA.name'), 'reads account A username from compare result')
  assert.ok(source.includes('syncState.data.userB.name'), 'reads account B username from compare result')
  assert.ok(source.includes("var fromUser = dir === 'A->B' ? nameA : nameB"), 'uses real source username')
  assert.ok(source.includes("var toUser = dir === 'A->B' ? nameB : nameA"), 'uses real target username')
  assert.equal(source.includes("var fromUser = dir === 'A->B' ? 'A' : 'B'"), false)
})

test('public sync result shows backend result count for diagnosis', () => {
  assert.ok(source.includes('var expected = ids.length'), 'computes expected sync count')
  assert.ok(source.includes("msg += '<br><small>"), 'renders diagnostic summary')
  assert.ok(source.includes('results.length'), 'uses actual response array length')
})

test('public sync displays operation log lookup urls', () => {
  assert.ok(source.includes("res.headers.get('X-Sync-Operation-Id')"), 'reads operation id header')
  assert.ok(source.includes("'/api/check/' + operationId"), 'builds human-readable check page endpoint')
  assert.equal(source.includes('/api/sync/operations/'), false)
  assert.ok(source.includes('operationLinks.push'), 'collects operation links per batch')
  assert.ok(source.includes('\\u64cd\\u4f5c\\u65e5\\u5fd7'), 'renders operation log label')
})

test('public sync renders operation log inline with progress before and after', () => {
  assert.ok(source.includes('renderInlineSyncLog(results, operationLinks)'), 'renders operation log inside sync page')
  assert.ok(source.includes('formatEpisodeProgress'), 'formats episode progress')
  assert.ok(source.includes("progress.before + '/' + progress.total + ' -> ' + progress.after + '/' + progress.total"), 'shows before and after progress')
  assert.ok(source.includes('formatFieldChange(r.collectionStatus)'), 'renders status before and after')
  assert.ok(source.includes('formatFieldChange(r.scoreChange)'), 'renders score before and after')
  assert.ok(source.includes('buildSyncBaseline(dir, chunk)'), 'sends before-state baseline with sync request')
})

test('public sync uses sync API routes and no legacy manage routes', () => {
  assert.ok(source.includes("API + '/api/sync/compare'"), 'calls sync compare endpoint')
  assert.ok(source.includes("API + '/api/sync/apply'"), 'calls sync apply endpoint')
  assert.equal(source.includes('/api/manage/compare'), false)
  assert.equal(source.includes('/api/manage/sync'), false)
})

test('public full sync batches source ids to avoid one huge worker request', () => {
  assert.ok(source.includes('var SYNC_BATCH_SIZE = 5'), 'uses a worker-safe batch size with episode progress writes')
  assert.ok(source.includes("mode: 'partial'"), 'sends backend chunk requests as partial batches')
  assert.ok(source.includes('for (var start = 0; start < ids.length; start += SYNC_BATCH_SIZE)'), 'iterates batches')
  assert.ok(source.includes("Math.round(done / expected * 100) + '%'"), 'updates progress per completed batch')
})

test('public full sync applies current filter search and direction', () => {
  assert.ok(source.includes('getSyncableFilteredIds(dir, syncState.filter, syncState.search)'), 'full sync uses current filter/search')
  assert.ok(source.includes("canSyncSection(dir, section)"), 'direction decides whether a section can sync')
  assert.ok(source.includes("if (section === 'diff') return true"), 'changed entries sync in either direction')
  assert.ok(source.includes("if (section === 'onlyA') return dir === 'A->B'"), 'A-only entries sync only A to B')
  assert.ok(source.includes("if (section === 'onlyB') return dir === 'B->A'"), 'B-only entries sync only B to A')
  assert.ok(source.includes("syncState.filter, 1, parseInt(document.getElementById('sync-pagesize').value), syncState.search"), 'direction changes re-render checkbox availability')
  assert.ok(source.includes('\\u540c\\u6b65\\u7b5b\\u9009\\u5168\\u90e8'), 'button text describes filtered sync')
})

test('public sync toolbar controls use theme classes instead of inline sizing', () => {
  assert.equal(source.includes('id="sync-pagesize" style='), false)
  assert.equal(source.includes('id="sync-direction" style='), false)
  assert.ok(source.includes('class="sync-select"'), 'select controls share themed sizing')
})

test('collection and calendar cards share the same renderer pipeline', () => {
  assert.ok(source.includes('function renderSubjectCard('), 'has shared subject card renderer')
  assert.equal(source.match(/return renderSubjectCard\(\{/g)?.length, 2, 'collection and calendar adapters use shared renderer')
  assert.equal(source.includes('function renderCalendarCard(entry) {\n    const hasHash'), false, 'calendar does not duplicate image URL logic')
})

test('public cards use R2 image refs and text cache failure state', () => {
  assert.ok(source.includes('images?.common?.uri'), 'uses hydrated R2 image refs from read-worker')
  assert.ok(source.includes('image cache failed'), 'renders a text state when cache is unavailable')
  assert.equal(source.includes('data:image'), false)
  assert.equal(source.includes('images.hash'), false)
})

test('public cards use eps as the collection total episode fallback', () => {
  assert.ok(source.includes('entry.eps || entry.total_episodes'), 'uses eps before falling back to total_episodes')
})
