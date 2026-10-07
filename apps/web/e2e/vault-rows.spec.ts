// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Vault rows size their cards from the width they have: a few large covers on a wide window, two on a phone,
// and either a full row or the next card peeking in from the edge.
import { type Page } from '@playwright/test'
import { COLD_START_MS, expect, test } from './fixtures'

async function openVault(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'feed', settingsMode: 'advanced' }))
  })
  await page.goto('./')
  await expect(page.locator('.lib-hero h2')).toBeVisible({ timeout: COLD_START_MS })
  await expect.poll(() => page.locator('#lib-popular-h').count()).toBe(1)
}

/** The first design row: how many cards fit whole, the cover size, and how far the cards reach across the row. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>('.lib-rail[data-kind=designs]')
    if (!rail) throw new Error('no design row')
    const box = rail.getBoundingClientRect()
    const items = [...rail.querySelectorAll<HTMLElement>('.lib-rail-item')].map((el) => el.getBoundingClientRect())
    const thumb = rail.querySelector<HTMLElement>('.lib-thumb')?.getBoundingClientRect()
    const whole = items.filter((r) => r.left >= box.left - 1 && r.right <= box.right + 1).length
    const reach = Math.max(...items.map((r) => Math.min(r.right, box.right))) - box.left
    return { whole, count: items.length, coverW: thumb?.width ?? 0, coverH: thumb?.height ?? 0, rowW: box.width, reach, scrolls: rail.scrollWidth > rail.clientWidth + 1 }
  })
}

for (const [w, h, min, max] of [
  [2560, 1321, 5, 6],
  [1440, 900, 4, 5],
] as const) {
  test(`at ${w} px a row holds ${min} to ${max} large covers and fills the width`, async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop widths')
    await page.setViewportSize({ width: w, height: h })
    await openVault(page)
    const m = await measure(page)
    expect(m.whole).toBeGreaterThanOrEqual(min)
    expect(m.whole).toBeLessThanOrEqual(max)
    expect(m.coverW).toBeGreaterThan(240)
    expect(Math.round((m.coverW / m.coverH) * 3)).toBe(4)
    // Either the cards reach the end of the row, or there is no next card to show.
    if (m.count > m.whole) expect(m.reach).toBeGreaterThan(m.rowW - 4)
    // The featured design stays in proportion: the first row starts within the first screen.
    const rowTop = await page.locator('#lib-popular-h').evaluate((el) => el.getBoundingClientRect().top)
    expect(rowTop).toBeLessThan(h)
    await page.locator('#lib-popular-h').evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await page.screenshot({ path: info.outputPath(`vault-rows-${w}.png`) })
  })
}

test('on a phone a row shows two covers and the edge of the next', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'phone width')
  await openVault(page)
  const m = await measure(page)
  expect(m.whole).toBe(2)
  expect(m.coverW).toBeGreaterThan(130)
  if (m.count > 2) {
    expect(m.scrolls).toBe(true)
    expect(m.reach).toBeGreaterThan(m.rowW - 4)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await page.locator('#lib-popular-h').evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: info.outputPath('vault-rows-390.png') })
})
