import { expect, test } from '@playwright/test'
import { cardIds, cardRows, columns, currentPage, dismissAgeGate, goToPage, openCollection } from './helpers.ts'

const APP = 'http://127.0.0.1:8790'

async function total(shown: boolean): Promise<number> {
  const response = await fetch(`${APP}/api/collections?type=watching&limit=100&nsfw=${shown ? 'show' : 'hide'}`)
  expect(response.ok).toBe(true)
  return (await response.json()).total as number
}

test('every non-final page fills complete grid rows at each breakpoint', async ({ page }) => {
  const count = await total(true)
  expect(count).toBe(55)

  for (const [width, height] of [[1920, 1080], [1440, 900], [820, 1180], [390, 844]] as const) {
    await openCollection(page, width, height)
    const cols = await columns(page)
    expect(cols).toBeGreaterThan(0)
    const capacity = cols * 2
    const pages = Math.ceil(count / capacity)

    for (let target = 1; target <= pages; target += 1) {
      await goToPage(page, target)
      const { cards, rowCounts } = await cardRows(page)
      if (target < pages) {
        expect(cards, `${width}px page ${target} must be full`).toBe(capacity)
        expect(rowCounts, `${width}px page ${target} cols=${cols} cards=${cards}`).toEqual([cols, cols])
      } else {
        expect(cards).toBe(count - (pages - 1) * capacity)
      }
    }
  }
})

test('paging never duplicates or omits a subject', async ({ page }) => {
  const count = await total(true)
  await openCollection(page, 1440, 900)
  const pages = Math.ceil(count / ((await columns(page)) * 2))
  const seen = new Set<string>()
  for (let target = 1; target <= pages; target += 1) {
    await goToPage(page, target)
    for (const id of await cardIds(page)) {
      if (id) {
        expect(seen.has(id), `duplicate card ${id} on page ${target}`).toBe(false)
        seen.add(id)
      }
    }
  }
  expect(seen.size).toBe(count)
})

test('resize re-pages without losing the current position or overflowing', async ({ page }) => {
  await openCollection(page, 1440, 900)
  await goToPage(page, 3)
  const firstBefore = (await cardIds(page))[0]

  await page.setViewportSize({ width: 820, height: 1180 })
  await expect.poll(async () => columns(page)).toBe(5)
  await expect.poll(async () => currentPage(page)).toBe(4)
  const firstAfter = (await cardIds(page))[0]
  expect(firstAfter).not.toBe(firstBefore)

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)

  await page.setViewportSize({ width: 1440, height: 900 })
  await expect.poll(async () => columns(page)).toBe(9)
})

test('NSFW gate hides items before pagination and reveals them after consent', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(page.locator('.bgm-view:not([hidden]) .bgm-card').first()).toBeVisible()
  await expect(page.locator('.bgm-nsfw')).toHaveCount(0)
  expect(await total(false)).toBe(52)

  await dismissAgeGate(page)
  await expect(page.locator('.bgm-view:not([hidden]) .bgm-nsfw').first()).toBeVisible()
  const { cards, cols } = await cardRows(page)
  expect(cards).toBe(cols * 2)
})

test('card content exposes the expected structure and link target', async ({ page }) => {
  await openCollection(page, 1440, 900)
  const first = page.locator('.bgm-view:not([hidden]) .bgm-grid .bgm-card').first()
  await expect(first).toHaveAttribute('target', '_blank')
  await expect(first).toHaveAttribute('rel', /noopener/)
  await expect(first.locator('img')).toHaveAttribute('alt', /.+/)
  await expect(first.locator('h3')).not.toBeEmpty()
})

test('changing type resets to page one and keeps the grid full', async ({ page }) => {
  await openCollection(page, 1440, 900)
  await goToPage(page, 2)
  await page.getByRole('button', { name: '看过', exact: true }).click()
  await expect(page.locator('.bgm-type.active')).toHaveText('看过')
  await expect(page.locator('.bgm-pagination .active')).toHaveText('1')
  const { cards, cols } = await cardRows(page)
  expect(cards).toBe(cols * 2)
  expect(page.url()).toContain('type=watched')
})

test('widget renders twice on a third-party origin without polluting the host', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('http://127.0.0.1:8791/')
  await expect(page.locator('.bgm-container .bgm-card').first()).toBeVisible()
  await expect(page.locator('.bgm-container')).toHaveCount(2)

  const host = await page.evaluate(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    url: location.href,
    globals: ['bgmConfirmAge', 'bgmLeaveAge', 'bgmFetchHealth', 'bgmSubscribeHealth']
      .filter((name) => name in window),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    dialogs: document.querySelectorAll('dialog.bgm-dialog').length,
    footers: document.querySelectorAll('.bgm-container .bgm-footer').length,
  }))
  expect(host.background).toBe('rgb(255, 255, 255)')
  expect(host.url).toBe('http://127.0.0.1:8791/')
  expect(host.globals).toEqual([])
  expect(host.overflow).toBeLessThanOrEqual(0)
  expect(host.dialogs).toBe(1)
  expect(host.footers).toBe(2)
  expect(errors).toEqual([])

  await dismissAgeGate(page)
  await expect(page.locator('.bgm-container').first().locator('.bgm-nsfw').first()).toBeVisible()
  await expect(page.locator('.bgm-container').nth(1).locator('.bgm-nsfw').first()).toBeVisible()
})

test('a single-container embed never rewrites the host URL', async ({ page }) => {
  await page.goto('http://127.0.0.1:8791/single')
  await expect(page.locator('.bgm-container .bgm-card').first()).toBeVisible()
  await expect(page.locator('.bgm-container')).toHaveCount(1)
  await dismissAgeGate(page)
  await expect(page).toHaveURL('http://127.0.0.1:8791/single')

  await page.getByRole('tab', { name: '放送日历' }).click()
  await expect(page.locator('.bgm-weekday-nav [role="tab"]')).toHaveCount(7)
  await expect(page).toHaveURL('http://127.0.0.1:8791/single')
})
