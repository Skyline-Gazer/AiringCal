import { expect, type Page } from '@playwright/test'

/** The acceptance server runs with NSFW enabled, so every fresh context sees the gate. */
export async function dismissAgeGate(page: Page): Promise<void> {
  // The dialog only renders once /api/config settles; wait for that state
  // (or for an existing consent) before deciding whether to click.
  await page.waitForFunction(() => {
    if ((document.querySelector('dialog.bgm-dialog') as HTMLDialogElement | null)?.open) return true
    if (document.querySelector('.bgm-info')) return true
    try {
      return sessionStorage.getItem('bgm-age-confirmed') === '1'
    } catch {
      return false
    }
  }, undefined, { timeout: 5_000 })
  const dialog = page.locator('dialog.bgm-dialog')
  if (await dialog.isVisible()) {
    await page.getByRole('button', { name: '确认已满 18 岁' }).click()
    await expect(dialog).not.toBeVisible()
  }
}

export async function openCollection(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height })
  await page.goto('/')
  await expect(page.locator('.bgm-view:not([hidden]) .bgm-grid .bgm-card').first()).toBeVisible()
  await dismissAgeGate(page)
}

export async function columns(page: Page): Promise<number> {
  return page.evaluate(() => {
    const grid = document.querySelector('.bgm-view:not([hidden]) .bgm-grid')
    if (!grid) return 0
    return getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length
  })
}
export async function cardRows(page: Page): Promise<{ cards: number; cols: number; rowCounts: number[] }> {
  await page.mouse.move(0, 0)
  await page.waitForTimeout(150)
  return page.evaluate(() => {
    const grid = document.querySelector('.bgm-view:not([hidden]) .bgm-grid') as HTMLElement
    const cards = [...grid.querySelectorAll('.bgm-card')]
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length
    const tops = cards.map((card) => card.getBoundingClientRect().top + window.scrollY).sort((a, b) => a - b)
    const rowCounts: number[] = []
    let rowStart = Number.NEGATIVE_INFINITY
    for (const top of tops) {
      if (rowCounts.length > 0 && top - rowStart < 4) {
        rowCounts[rowCounts.length - 1] += 1
        continue
      }
      rowStart = top
      rowCounts.push(1)
    }
    return { cards: cards.length, cols, rowCounts }
  })
}

export async function currentPage(page: Page): Promise<number> {
  return Number(await page.locator('.bgm-pagination .active').textContent())
}

export async function goToPage(page: Page, target: number): Promise<void> {
  let current = await currentPage(page)
  while (current < target) {
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    current += 1
    await expect.poll(async () => currentPage(page)).toBe(current)
    await expect(page.locator('.bgm-view:not([hidden]) .bgm-grid')).not.toHaveAttribute('aria-busy', 'true')
  }
  while (current > target) {
    await page.getByRole('button', { name: '上一页', exact: true }).click()
    current -= 1
    await expect.poll(async () => currentPage(page)).toBe(current)
    await expect(page.locator('.bgm-view:not([hidden]) .bgm-grid')).not.toHaveAttribute('aria-busy', 'true')
  }
}

export async function cardIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll('.bgm-view:not([hidden]) .bgm-grid .bgm-card')]
    .map((card) => card.getAttribute('href') ?? ''))
}
