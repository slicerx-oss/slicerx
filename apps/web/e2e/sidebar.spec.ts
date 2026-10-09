// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Slice sidebar: printer, filament and print settings stand as separate panels, and printer and filament fold to a
// summary line that stays folded after a reload.
import { expect, openSheet, test } from './fixtures'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('slicerx.prefs.v1')) localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', printerId: 'bay-1', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
})

test('each section is its own panel with an icon in its header', async ({ page }) => {
  await page.goto('./')
  await openSheet(page)
  for (const id of ['printer', 'filament', 'settings']) {
    const sec = page.locator(`.pane-body > .sx-block[data-section="${id}"]`)
    await expect(sec).toBeVisible()
    await expect(sec.locator('.sx-block-h .sx-block-icon')).toHaveCount(1)
    const look = await sec.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { radius: parseFloat(cs.borderTopLeftRadius), border: cs.borderTopStyle }
    })
    expect(look.radius).toBeGreaterThan(0)
    expect(look.border).toBe('solid')
  }
  // The panels sit apart on the darker ground.
  const gap = await page.locator('.pane-body').evaluate((el) => parseFloat(getComputedStyle(el).rowGap))
  expect(gap).toBeGreaterThan(0)
})

test('Simple mode keeps the sections open with no fold', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', printerId: 'bay-1', settingsMode: 'simple', pilot: { mode: 'off' } })))
  await page.goto('./')
  await expect(page.locator('.sx-block[data-section="printer"] .printer')).toBeVisible()
  await expect(page.locator('#printer-fold, #filament-fold')).toHaveCount(0)
})

test('printer and filament fold to a summary line and stay folded', async ({ page }) => {
  await page.goto('./')
  await openSheet(page)
  const printer = page.locator('.sx-block[data-section="printer"]')
  await printer.getByRole('button', { name: 'Printer', exact: true }).click()
  await expect(printer).toHaveAttribute('data-collapsed', 'true')
  await expect(printer.locator('.sec-sum')).toContainText('mm')
  const filament = page.locator('.sx-block[data-section="filament"]')
  await filament.getByRole('button', { name: 'Filament', exact: true }).click()
  await expect(filament.locator('.sec-sum')).toContainText('used')
  await page.reload()
  await openSheet(page)
  await expect(page.locator('.sx-block[data-section="printer"]')).toHaveAttribute('data-collapsed', 'true')
  await page.locator('.sx-block[data-section="printer"]').getByRole('button', { name: 'Printer', exact: true }).click()
  await expect(page.locator('.sx-block[data-section="printer"] .printer')).toBeVisible()
})
