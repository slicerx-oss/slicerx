// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The live view of one printer from the Printers page: the panels over the camera, the drawers by mouse and
// keyboard, an approval before a pause, and the way back. Desktop and phone.
import { type Page } from '@playwright/test'
import { COLD_START_MS, expect, test } from './fixtures'

async function openPrinters(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'printers', settingsMode: 'advanced' }))
  })
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Printers' })).toBeVisible({ timeout: COLD_START_MS })
}

test('a printer opens in its live view with drawers, and Pause asks first', async ({ page, isMobile }) => {
  await openPrinters(page)
  await page.locator('.pcard').filter({ hasText: 'Bay 1' }).getByRole('button', { name: 'Bay 1', exact: true }).click()
  const hud = page.getByRole('region', { name: 'Bay 1 live view' })
  await expect(hud).toBeVisible()
  await expect(hud).toHaveAttribute('data-layout', isMobile ? 'phone' : 'wide')
  await expect(hud.getByRole('progressbar', { name: 'Bay 1 progress' })).toBeVisible()

  // The temperatures open from their tab and close with Esc, focus going back to the tab.
  const tab = hud.getByRole('button', { name: 'Show temperatures and fans' })
  await tab.click()
  const temps = hud.getByRole('complementary', { name: 'Temperatures and fans' })
  await expect(temps).toBeVisible()
  await expect(temps.getByRole('meter', { name: 'Part cooling fan' })).toHaveAttribute('aria-valuenow', '100')
  await page.keyboard.press('Escape')
  await expect(temps).toBeHidden()
  await expect(tab).toBeFocused()

  // The filament drawer opens from the keyboard and names the slot printing now.
  await hud.getByRole('button', { name: 'Show filament' }).focus()
  await page.keyboard.press('Enter')
  const filament = hud.getByRole('complementary', { name: 'Filament' })
  await expect(filament).toBeVisible()
  await expect(filament.locator('.ph-slot[data-active]')).toContainText('Printing now')
  await filament.getByRole('button', { name: 'Close filament' }).click()
  await expect(filament).toBeHidden()

  // Pause goes through the approval card; denying it leaves the print running.
  await hud.getByRole('button', { name: 'Pause' }).click()
  const card = page.getByRole('dialog', { name: /Pause the print on Bay 1/ })
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: 'Deny' }).click()
  await expect(hud.getByRole('button', { name: 'Pause' })).toBeVisible()

  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await hud.getByRole('button', { name: 'Back to all printers' }).click()
  await expect(page.locator('.pcard')).toHaveCount(6)
})
