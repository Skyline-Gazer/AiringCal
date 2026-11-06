import assert from 'node:assert/strict'
import test from 'node:test'
import { widgetCss, widgetJs } from './index.ts'

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} should exist in the packaged asset`)
  const bodyStart = source.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1)
  }
  throw new Error(`could not extract ${name}`)
}

function loadPaginationHelpers() {
  return Function(
    `${extractFunction(widgetJs, 'buildPaginationWindow')}\nreturn { buildPaginationWindow }`,
  )() as {
    buildPaginationWindow(current: number, totalPages: number): Array<number | string>
  }
}

function loadPrefetchHelpers() {
  return Function(
    `${extractFunction(widgetJs, 'createPrefetchCache')}\nreturn { createPrefetchCache }`,
  )() as {
    createPrefetchCache(cap?: number): {
      get(type: string, page: number): unknown
      set(type: string, page: number, data: unknown): void
      size(): number
    }
  }
}

function loadSkeletonHelpers() {
  return Function(
    `${extractFunction(widgetJs, 'skeletonCardsHtml')}\nreturn { skeletonCardsHtml }`,
  )() as {
    skeletonCardsHtml(count: number): string
  }
}

test('widgetJs declares loadAbort and loadSeq module state', () => {
  assert.match(widgetJs, /let loadAbort\s*=\s*null/)
  assert.match(widgetJs, /let loadSeq\s*=\s*0/)
})

test('load aborts prior controller, bumps loadSeq, and fetches with signal', () => {
  const loadFn = extractFunction(widgetJs, 'load')
  assert.match(loadFn, /loadAbort\.abort\(/)
  assert.match(loadFn, /loadSeq\s*=\s*loadSeq\s*\+\s*1|\+\+loadSeq|loadSeq\+\+/)
  assert.match(loadFn, /signal:\s*loadAbort\.signal|signal:\s*[\w.]+/)
  assert.match(loadFn, /seq\s*!==\s*loadSeq/)
})

test('load paints exactly 24 skeleton cards before fetch', () => {
  assert.match(widgetJs, /var PAGE_LIMIT\s*=\s*24/)
  const loadFn = extractFunction(widgetJs, 'load')
  assert.match(loadFn, /skeletonCardsHtml\(\s*PAGE_LIMIT\s*\)|skeletonCardsHtml\(\s*24\s*\)/)
  const { skeletonCardsHtml } = loadSkeletonHelpers()
  const html = skeletonCardsHtml(24)
  assert.equal((html.match(/bgm-card-skeleton/g) || []).length, 24)
})

test('load preserves grid min-height before replacing a rendered page', () => {
  const loadFn = extractFunction(widgetJs, 'load')
  assert.match(loadFn, /offsetHeight|getBoundingClientRect/)
  assert.match(loadFn, /minHeight|min-height/)
})

test('load ignores abort errors and clears pagination on hard errors', () => {
  const loadFn = extractFunction(widgetJs, 'load')
  assert.match(loadFn, /AbortError|name\s*===\s*['\"]AbortError['\"]/)
  assert.match(loadFn, /pagination\.innerHTML\s*=\s*['\"]['\"]/)
})

test('load consults prefetch cache and prefetches the next page after success', () => {
  const loadFn = extractFunction(widgetJs, 'load')
  assert.match(loadFn, /prefetchCache\.get|prefetchGet/)
  assert.match(widgetJs, /prefetchNextPage|prefetchCache\.set|prefetchSet/)
})

test('createPrefetchCache is an LRU map capped at 8 entries', () => {
  const { createPrefetchCache } = loadPrefetchHelpers()
  const cache = createPrefetchCache(8)
  for (let i = 1; i <= 9; i++) cache.set('watching', i, { page: i })
  assert.equal(cache.size(), 8)
  assert.equal(cache.get('watching', 1), null)
  assert.deepEqual(cache.get('watching', 2), { page: 2 })
  cache.set('watching', 10, { page: 10 })
  assert.equal(cache.get('watching', 3), null)
  assert.deepEqual(cache.get('watching', 10), { page: 10 })
})

test('buildPaginationWindow keeps at most 7 slots including edges', () => {
  const { buildPaginationWindow } = loadPaginationHelpers()
  assert.deepEqual(buildPaginationWindow(1, 5), [1, 2, 3, 4, 5])
  assert.deepEqual(buildPaginationWindow(1, 20), [1, 2, 3, 4, 5, '…', 20])
  assert.deepEqual(buildPaginationWindow(10, 20), [1, '…', 9, 10, 11, '…', 20])
  assert.deepEqual(buildPaginationWindow(20, 20), [1, '…', 16, 17, 18, 19, 20])
  for (const current of [1, 4, 10, 17, 20]) {
    assert.ok(buildPaginationWindow(current, 20).length <= 7)
  }
})

test('pagination buttons mark the active page with aria-current', () => {
  assert.match(widgetJs, /aria-current/)
  assert.match(widgetJs, /buildPaginationWindow\(/)
})

test('widgetCss reserves skeleton cover aspect-ratio and status/grid min-height', () => {
  assert.match(widgetCss, /\.bgm-card-skeleton/)
  assert.match(widgetCss, /\.bgm-card-skeleton\s+\.bgm-card-cover\s*\{[^}]*aspect-ratio:\s*3\s*\/\s*4/)
  assert.doesNotMatch(widgetCss, /\.bgm-card-skeleton\s*\{[^}]*aspect-ratio:\s*3\s*\/\s*4/)
  assert.match(widgetCss, /\.bgm-status-bar/)
  assert.match(widgetCss, /\.bgm-status-bar[^{]*\{[^}]*min-height/)
  assert.match(widgetCss, /\.bgm-grid[^{]*\{[^}]*min-height|\.bgm-grid\.bgm-grid-skeleton/)
})

function loadNsfwGateHelpers() {
  const source = [
    extractFunction(widgetJs, 'createNsfwGate'),
    extractFunction(widgetJs, 'entriesVisibleUnderGate'),
    extractFunction(widgetJs, 'applyNsfwConfigResult'),
    'return { createNsfwGate, entriesVisibleUnderGate, applyNsfwConfigResult }',
  ].join('\n')
  return Function(source)() as {
    createNsfwGate(): {
      configStatus: 'pending' | 'ok' | 'error'
      nsfwAllowed: boolean
      ageConfirmed: boolean
    }
    entriesVisibleUnderGate(
      gate: { configStatus: string; nsfwAllowed: boolean; ageConfirmed: boolean },
      entries: Array<{ nsfw?: boolean; id?: number }>,
    ): Array<{ nsfw?: boolean; id?: number }>
    applyNsfwConfigResult(
      gate: { configStatus: string; nsfwAllowed: boolean; ageConfirmed: boolean },
      result: { ok: boolean; nsfw?: boolean },
      storage: { getItem(key: string): string | null; removeItem(key: string): void; setItem?(key: string, value: string): void },
    ): void
  }
}

test('createNsfwGate starts pending and never shows restricted cards until policy allows', () => {
  const { createNsfwGate, entriesVisibleUnderGate, applyNsfwConfigResult } = loadNsfwGateHelpers()
  const gate = createNsfwGate()
  assert.equal(gate.configStatus, 'pending')
  const mixed = [{ id: 1, nsfw: false }, { id: 2, nsfw: true }]
  assert.deepEqual(entriesVisibleUnderGate(gate, mixed).map((e) => e.id), [1])

  const storage = {
    store: new Map<string, string>(),
    getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null },
    setItem(key: string, value: string) { this.store.set(key, value) },
    removeItem(key: string) { this.store.delete(key) },
  }

  applyNsfwConfigResult(gate, { ok: false }, storage)
  assert.equal(gate.configStatus, 'error')
  assert.equal(gate.nsfwAllowed, false)
  assert.deepEqual(entriesVisibleUnderGate(gate, mixed).map((e) => e.id), [1])

  applyNsfwConfigResult(gate, { ok: true, nsfw: false }, storage)
  assert.equal(gate.configStatus, 'ok')
  assert.equal(gate.nsfwAllowed, false)
  assert.equal(storage.getItem('bgm-age-confirmed'), null)
  assert.deepEqual(entriesVisibleUnderGate(gate, mixed).map((e) => e.id), [1])

  storage.setItem('bgm-age-confirmed', '1')
  gate.ageConfirmed = true
  applyNsfwConfigResult(gate, { ok: true, nsfw: false }, storage)
  assert.equal(storage.getItem('bgm-age-confirmed'), null)
  assert.equal(gate.ageConfirmed, false)

  applyNsfwConfigResult(gate, { ok: true, nsfw: true }, storage)
  assert.equal(gate.nsfwAllowed, true)
  assert.equal(gate.ageConfirmed, false)
  assert.deepEqual(entriesVisibleUnderGate(gate, mixed).map((e) => e.id), [1])

  gate.ageConfirmed = true
  assert.deepEqual(entriesVisibleUnderGate(gate, mixed).map((e) => e.id), [1, 2])
})

test('widgetJs starts config concurrently and replaces empty catch with deny path', () => {
  assert.match(widgetJs, /configStatus/)
  assert.match(widgetJs, /entriesVisibleUnderGate/)
  assert.match(widgetJs, /createNsfwGate/)
  assert.doesNotMatch(widgetJs, /catch\s*\(\s*e\s*\)\s*\{\s*\}/)
  assert.match(widgetJs, /bgm-status|status-bar|NSFW|年龄|配置/)
  const renderFn = extractFunction(widgetJs, 'render')
  assert.match(renderFn, /\/api\/config/)
  assert.match(renderFn, /activate\(['\"]collection['\"]\)/)
})

test('bgmConfirmAge reveals gated cards without full reload', () => {
  assert.match(widgetJs, /window\.bgmConfirmAge\s*=\s*function/)
  assert.match(widgetJs, /bgm-age-confirmed/)
  assert.match(widgetJs, /onNsfwGateChange|nsfwGateListeners|revealNsfw|repaintCollection|refreshVisibleCards/)
})

test('first two first-paint cards use fetchpriority high and eager loading', () => {
  const paintFn = extractFunction(widgetJs, 'paintCollectionData')
  assert.match(paintFn, /i\s*<\s*2/)
  assert.doesNotMatch(paintFn, /i\s*<\s*8/)
  assert.match(widgetJs, /loading=["']eager["']/)
  assert.match(widgetJs, /fetchpriority=["']high["']/)
})
