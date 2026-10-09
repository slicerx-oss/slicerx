// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Slice footer: the estimate on one line, the breakdown behind the time, the warnings chip, and the one Print as a
// split button whose menu has the file exports. These specs slice by hand (Auto slice off).
import { type Page } from '@playwright/test'
import { expect, plateReady, sliceCount, sliced, test } from './fixtures'

type Sx = { getState(): { slice: { status: string; result?: { warnings: unknown[] } } }; setState(p: unknown): void }
const A1_MINI = { id: 'e2e-a1-mini', name: 'Desk A1 mini', profileId: 'bambu-a1-mini', vendor: 'Bambu Lab', model: 'A1 mini', nozzleCount: 1 }

// On a phone the footer floats over the view until the sheet gets its tabs; these run at desktop width.
test.skip(({ isMobile }) => isMobile, 'Desktop width')

async function open(page: Page, prefs: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((p) => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', pilot: { mode: 'off' }, ...p }))
  }, prefs)
  await page.goto('./')
  await plateReady(page)
}

async function slice(page: Page): Promise<void> {
  const n = await sliceCount(page)
  await page.getByTestId('slice-estimate-slice').click()
  await expect(sliced(page, n)).toBeVisible({ timeout: 120_000 })
}

test('after a slice the footer reads time and grams on one line, and the time opens the breakdown', async ({ page }) => {
  test.slow()
  await open(page)
  const foot = page.getByTestId('slice-estimate')
  await expect(foot).toContainText('Slice to see time, filament and cost.')
  await slice(page)
  await expect(page.getByTestId('slice-estimate-time')).toHaveText(/^(\d+h )?\d+m$/)
  await expect(foot.locator('.est-fig').first()).toHaveText(/^\d+(\.\d)? g$/)
  await expect(page.getByTestId('slice-estimate-warnings')).toHaveCount(0)
  await page.getByTestId('slice-estimate-time').click()
  const breakdown = page.getByTestId('slice-estimate-breakdown')
  await expect(breakdown).toBeVisible()
  await expect(breakdown).toContainText('Where the time goes')
  await expect(breakdown.locator('.est-slots li').first()).toContainText('Slot 1')
  await page.keyboard.press('Escape')
  await expect(breakdown).toHaveCount(0)
})

test('Print is a split button: its menu has the exports, and an edit marks the estimate stale', async ({ page }) => {
  test.slow()
  await open(page)
  await slice(page)
  await expect(page.getByTestId('danger-slice-print')).toBeEnabled()
  await page.getByTestId('slice-output-menu').click()
  await expect(page.getByTestId('slice-output-export-gcode')).toBeVisible()
  await expect(page.getByTestId('slice-output-export-3mf')).toBeVisible()
  await page.keyboard.press('Escape')
  // A setting change makes the slice stale: the tag says so and the main action is Slice again.
  await page.getByRole('radiogroup', { name: 'Supports' }).getByRole('radio', { name: 'Auto' }).click()
  await expect(page.getByTestId('slice-estimate')).toHaveAttribute('data-stale', 'true')
  await expect(page.getByTestId('slice-estimate')).toContainText('Settings changed')
  await expect(page.getByTestId('slice-estimate-slice')).toBeVisible()
})

test('a printer with no connection exports G-code as the main action', async ({ page }) => {
  test.slow()
  await open(page, { handPrinters: [A1_MINI], printerId: A1_MINI.id })
  await slice(page)
  await expect(page.getByTestId('slice-estimate-export-gcode')).toHaveText('Export G-code')
  await expect(page.getByTestId('danger-slice-print')).toHaveCount(0)
})

test('the warnings chip shows only with warnings, and names how many', async ({ page }) => {
  test.slow()
  await open(page)
  await slice(page)
  await expect(page.getByTestId('slice-estimate-warnings')).toHaveCount(0)
  // Two warnings on the finished slice, as the engine reports them.
  await page.evaluate(() => {
    const sx = (window as unknown as { __sx: Sx }).__sx
    const s = sx.getState().slice as { status: string; result: { warnings: unknown[] } }
    sx.setState({ slice: { ...s, result: { ...s.result, warnings: [{ code: 'thin_wall', message: 'A wall is thinner than the nozzle.' }, { code: 'long_bridge', message: 'A bridge is 40 mm long.' }] } } })
  })
  await expect(page.getByTestId('slice-estimate-warnings')).toHaveText('2 warnings')
  await page.getByTestId('slice-estimate-warnings').click()
})
