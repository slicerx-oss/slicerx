// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Slice sidebar fits: in Simple at 1440 x 900 nothing in it scrolls, with or without a slice and with several
// objects, since the objects sit in the right pane. The printer and filaments stay pinned while Advanced scrolls.
import { type Page } from '@playwright/test'
import { command, openStudio } from './cad-helpers'
import { expect, sliceCount, sliced, test } from './fixtures'

const left = (page: Page) => page.locator('aside.pane[data-side="left"]')

/** How far the sidebar's settings scroll: 0 when everything is on screen. */
function overflow(page: Page): Promise<number> {
  return left(page).locator('.sx-rail-body').evaluate((el) => el.scrollHeight - el.clientHeight)
}

async function slice(page: Page): Promise<void> {
  const n = await sliceCount(page)
  await page.mouse.click(700, 450)
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(sliced(page, n)).toBeVisible({ timeout: 120_000 })
}

test.describe('the Slice sidebar at 1440 x 900', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop width')

  test('Simple fits without scrolling, before and after a slice and with more objects', async ({ page }) => {
    test.slow()
    await openStudio(page, { settingsMode: 'simple' })
    const pin = left(page).locator('.sx-rail-pin')
    await expect(pin.getByTestId('slice-machine-card')).toBeVisible()
    await expect(pin.locator('[data-section="filament"]')).toBeVisible()
    // The objects are in the right pane, not the sidebar.
    await expect(left(page).getByTestId('objects-list')).toHaveCount(0)
    await expect(page.getByTestId('slice-summary').getByTestId('objects-list')).toBeVisible()
    for (const id of ['slice-goal-standard', 'slice-machine-plate']) await expect(page.getByTestId(id)).toBeInViewport()
    await expect(page.getByRole('radiogroup', { name: 'Supports' })).toBeInViewport()
    expect(await overflow(page)).toBeLessThanOrEqual(1)
    await slice(page)
    expect(await overflow(page)).toBeLessThanOrEqual(1)
    await command(page, 'Add a cylinder')
    await command(page, 'Add a cylinder')
    await expect(page.getByTestId('slice-summary').getByTestId('object-row')).toHaveCount(3)
    expect(await overflow(page)).toBeLessThanOrEqual(1)
  })

  test('Advanced scrolls its settings under a pinned printer and filament', async ({ page }) => {
    await openStudio(page)
    const card = page.getByTestId('slice-machine-card')
    const before = await card.boundingBox()
    expect(await overflow(page)).toBeGreaterThan(0)
    await left(page).locator('.sx-rail-body').evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await expect(card).toBeInViewport()
    expect((await card.boundingBox())?.y).toBe(before?.y)
  })

  test('the slice summary has no Print of its own: the one Print is in the sidebar footer', async ({ page }) => {
    test.slow()
    await openStudio(page, { settingsMode: 'simple' })
    await slice(page)
    await expect(page.getByTestId('slice-summary').locator('[data-section="totals"]')).toBeVisible()
    await expect(page.getByTestId('slice-summary').getByRole('button', { name: /^Print/ })).toHaveCount(0)
    await expect(left(page).locator('.sx-rail-foot').getByTestId('danger-slice-print')).toBeVisible()
  })
})
