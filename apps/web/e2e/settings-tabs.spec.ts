// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print settings in Advanced and Expert sit behind tabs, one per group. Color shows only with two or more filaments
// and holds the atlas prime tower row; a search looks through every tab; arrows move between tabs.
import { expect, openSheet, plateReady, test } from './fixtures'
import type { Page } from '@playwright/test'

type Sx = { getState(): { plate: { parts: { name: string }[] }[] }; setState(p: unknown): void }

async function open(page: Page, isMobile: boolean): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ expertOpen: true }))
  // On a phone the settings are in the sheet.
  if (isMobile) await openSheet(page)
}

const tabs = (page: Page) => page.getByRole('tablist', { name: 'Setting groups' }).getByRole('tab')

test('one tab per group; Color shows with two filaments and holds the atlas row', async ({ page, isMobile }) => {
  await open(page, isMobile)
  // The demo X prints in two filaments.
  await expect.poll(() => tabs(page).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).toEqual(['Quality', 'Strength', 'Speed', 'Supports', 'Adhesion', 'Color', 'Surface', 'Output'])
  await expect(page.getByTestId('slice-settings-tab-quality')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#set-tab-panel .tier-group')).toHaveCount(1)
  await expect(page.getByTestId('slice-tower-atlas')).toHaveCount(0)
  await page.getByTestId('slice-settings-tab-multicolor').click()
  await expect(page.getByTestId('slice-settings-tab-multicolor')).toHaveAttribute('aria-selected', 'true')
  // One prime tower switch, first in the Color section under its heading, with atlas's placement under it.
  const color = page.locator('#set-tab-panel section[aria-label="Color"]')
  await expect(color.getByRole('switch', { name: /Prime tower/ })).toHaveCount(1)
  await expect(page.getByRole('switch', { name: /prime tower/i })).toHaveCount(1)
  await expect(color.locator('ul > li').first()).toHaveClass(/tower-row/)
  await expect(color.getByTestId('slice-tower-atlas')).toContainText('atlas places it')
  // The Filament card no longer has it.
  await expect(page.locator('[data-section="filament"] .tower-row')).toHaveCount(0)
})

test('with one filament there is no Color tab, and an open Color tab falls back to Quality', async ({ page, isMobile }) => {
  await open(page, isMobile)
  await page.getByTestId('slice-settings-tab-multicolor').click()
  await page.evaluate(() => {
    const sx = (window as unknown as { __sx: Sx }).__sx
    sx.setState({ plate: sx.getState().plate.map((e) => ({ ...e, slotOverrides: Object.fromEntries(e.parts.map((p) => [p.name, 1])) })) })
  })
  await expect(page.getByTestId('slice-settings-tab-multicolor')).toHaveCount(0)
  await expect(page.getByTestId('slice-settings-tab-quality')).toHaveAttribute('aria-selected', 'true')
})

test('arrows move between tabs, and a search looks through all of them', async ({ page, isMobile }) => {
  await open(page, isMobile)
  await page.getByTestId('slice-settings-tab-quality').focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('slice-settings-tab-strength')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('slice-settings-tab-strength')).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByTestId('slice-settings-tab-output')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('slice-settings-tab-quality')).toHaveAttribute('aria-selected', 'true')
  // A search lists matches from every group, with no tab picked.
  await page.locator('#expert-search').fill('wall')
  await expect.poll(() => page.locator('#set-tab-panel .tier-group').count()).toBeGreaterThan(1)
  await expect(tabs(page).and(page.locator('[aria-selected="true"]'))).toHaveCount(0)
})
