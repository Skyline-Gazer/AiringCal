import { expect, test } from '@playwright/test'
import { dismissAgeGate } from './helpers.ts'

test('footer shares the page width, stays on one line and reports real metadata', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(page.locator('.bgm-card').first()).toBeVisible()

  const health = await (await fetch('http://127.0.0.1:8790/api/health')).json() as {
    data: { cache: { total_subjects: number }; collections: { updated_at: string } }
  }

  const layout = await page.evaluate(() => {
    const footer = document.querySelector('.bgm-footer') as HTMLElement
    const container = document.querySelector('.bgm-container') as HTMLElement
    const children = [...footer.children].map((child) => Math.round(child.getBoundingClientRect().top))
    return {
      footerWidth: Math.round(footer.getBoundingClientRect().width),
      containerWidth: Math.round(container.getBoundingClientRect().width),
      rows: new Set(children).size,
      text: footer.innerText,
    }
  })

  expect(Math.abs(layout.footerWidth - layout.containerWidth)).toBeLessThanOrEqual(1)
  expect(layout.rows).toBe(1)
  expect(layout.text).toMatch(/Build [0-9a-f]{7} · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/)
  expect(layout.text).toContain(`SUBJECTS ${health.data.cache.total_subjects}`)
  expect(layout.text).toContain('LAST UPDATED')
  expect(layout.text).not.toMatch(/Next Writer|Last Writer|已连接/)
  expect(await page.locator('.bgm-status-bar').count()).toBe(0)
})

test('last updated comes from the published release, not the page view', async ({ page }) => {
  await page.goto('/')
  const health = await (await fetch('http://127.0.0.1:8790/api/health')).json() as {
    data: { collections: { updated_at: string } }
  }
  const expected = new Date(health.data.collections.updated_at).toISOString().slice(0, 16).replace('T', ' ')
  await expect(page.locator('.bgm-footer')).toContainText(`LAST UPDATED ${expected} UTC`)
})

test('active controls and focus rings meet contrast requirements', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(page.locator('.bgm-card').first()).toBeVisible()
  await dismissAgeGate(page)
  const active = await page.locator('.bgm-pagination .active').evaluate((element) => {
    const style = getComputedStyle(element)
    return { color: style.color, background: style.backgroundColor }
  })
  expect(active.color).toBe('rgb(0, 0, 0)')
  expect(active.background).toBe('rgb(0, 161, 214)')

  if (browserName !== 'webkit') {
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    const focus = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement as Element)
      return { tag: document.activeElement?.tagName, outline: style.outlineStyle, width: style.outlineWidth }
    })
    expect(focus.tag).toBe('BUTTON')
    expect(focus.outline).toBe('solid')
    expect(focus.width).toBe('3px')
  }
})

test('tabs expose roles, selection and a labelled panel', async ({ page }) => {
  await page.goto('/')
  await dismissAgeGate(page)
  await expect(page.locator('.bgm-view-switch[role="tablist"] [role="tab"]')).toHaveCount(2)
  await expect(page.getByRole('tab', { name: '番组计划' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.bgm-view[role="tabpanel"]').first()).toHaveAttribute('aria-labelledby', /bgm-tab-collection/)

  await page.getByRole('tab', { name: '放送日历' }).click()
  await expect(page.locator('.bgm-weekday-nav[role="tablist"]')).toBeVisible()
  await expect(page.locator('.bgm-weekday[role="tabpanel"]')).toHaveAttribute('aria-labelledby', /bgm-weekday-tab-/)
})

test('loading keeps the grid occupied and announces busy state', async ({ page }) => {
  const gate = Promise.withResolvers<void>()
  await page.route('**/api/collections*', async (route) => {
    await gate.promise
    await route.continue()
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  const grid = page.locator('.bgm-view:not([hidden]) .bgm-grid')
  await expect(grid).toHaveAttribute('aria-busy', 'true')
  expect(await page.locator('.bgm-view:not([hidden]) .bgm-card-skeleton').count()).toBeGreaterThan(0)
  gate.resolve()
  await expect(page.locator('.bgm-view:not([hidden]) .bgm-card-skeleton')).toHaveCount(0)
})
