import { expect, test, type Page } from '@playwright/test'
import { dismissAgeGate } from './helpers.ts'

function todayWeekdayId(): number {
  const day = new Date().getDay()
  return day === 0 ? 7 : day
}

async function openCalendar(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await dismissAgeGate(page)
  await page.getByRole('tab', { name: '放送日历' }).click()
  await expect(page.locator('.bgm-weekday-nav [role="tab"]')).toHaveCount(7)
  await expect(page.locator('.bgm-weekday-title')).toBeVisible()
}

async function selectedDay(page: Page): Promise<string> {
  return page.evaluate(() => {
    const tab = document.querySelector('.bgm-weekday-nav [role="tab"][aria-selected="true"]')
    return tab?.id.replace('bgm-weekday-tab-', '') ?? ''
  })
}

test('calendar opens on today and switches content in place', async ({ page }) => {
  await openCalendar(page)
  expect(await selectedDay(page)).toBe(String(todayWeekdayId()))

  const scrollBefore = await page.evaluate(() => window.scrollY)
  await page.getByRole('tab', { name: '周三' }).click()
  await expect(page.locator('.bgm-weekday-title')).toContainText('星期三')
  expect(await selectedDay(page)).toBe('3')
  const scrollAfter = await page.evaluate(() => window.scrollY)
  expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThanOrEqual(2)

  const count = await page.locator('.bgm-weekday-count').textContent()
  const cards = await page.locator('.bgm-weekday .bgm-card').count()
  expect(Number(count)).toBe(cards)
  expect(new URL(page.url()).searchParams.get('day')).toBe('3')
})

test('calendar keeps the heading visible and never stacks the week', async ({ page }) => {
  await openCalendar(page)
  await expect(page.locator('.bgm-weekday')).toHaveCount(1)
  const heading = page.locator('.bgm-weekday-title')
  await expect(heading).toBeVisible()
  const box = await heading.boundingBox()
  expect(box?.height ?? 0).toBeGreaterThan(0)
  expect(await page.locator('.bgm-weekday-head').count()).toBe(1)
})

test('weekday tabs support arrow, home and end keys', async ({ page }) => {
  await openCalendar(page)
  await page.getByRole('tab', { name: '周三' }).click()
  await page.getByRole('tab', { name: '周三' }).focus()
  await page.keyboard.press('ArrowRight')
  expect(await selectedDay(page)).toBe('4')
  await page.keyboard.press('Home')
  expect(await selectedDay(page)).toBe('1')
  await page.keyboard.press('End')
  expect(await selectedDay(page)).toBe('7')
})

test('an empty weekday shows an empty state instead of a stale list', async ({ page }) => {
  await openCalendar(page)
  await page.getByRole('tab', { name: '周二' }).click()
  await expect(page.locator('.bgm-weekday-title')).toContainText('星期二')
  await expect(page.locator('.bgm-weekday-count')).toHaveText('0')
  await expect(page.locator('.bgm-weekday .bgm-empty')).toBeVisible()
  await expect(page.locator('.bgm-weekday .bgm-card')).toHaveCount(0)
})

test('selection is kept when switching views and reloading the URL', async ({ page }) => {
  await openCalendar(page)
  await page.getByRole('tab', { name: '周日' }).click()
  await page.getByRole('tab', { name: '番组计划' }).click()
  await page.getByRole('tab', { name: '放送日历' }).click()
  await expect(page.locator('.bgm-weekday-title')).toContainText('星期日')

  await page.reload()
  await expect(page.locator('.bgm-weekday-nav [role="tab"]')).toHaveCount(7)
  expect(await selectedDay(page)).toBe('7')
})
