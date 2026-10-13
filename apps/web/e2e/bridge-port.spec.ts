// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The desktop app starts its own printer bridge on port 47615. When another program holds that port the start fails,
// and the person sees why on the Printers page, where they went to use a printer, not only in Settings. The page
// stands in for the desktop shell, whose start command rejects with the shell's own words.
import { type Page } from '@playwright/test'
import { COLD_START_MS, expect, test } from './fixtures'

// What apps/desktop/src-tauri/src/link.rs says for a port in use.
const TAKEN = 'Port 47615 is in use by another program, so the printer bridge did not start. Close that program, such as an sx-link left running, then try again.'

async function openPrinters(page: Page): Promise<void> {
  await page.addInitScript((message) => {
    Object.assign(window, { __sxTestShellStartError: message })
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'printers', settingsMode: 'advanced' }))
  }, TAKEN)
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Printers' })).toBeVisible({ timeout: COLD_START_MS })
}

const starts = (page: Page) => page.evaluate(() => (window as { __sxTestShellStarts?: number }).__sxTestShellStarts ?? 0)

test('a taken bridge port is said on the Printers page, with a way to try again', async ({ page }, info) => {
  await openPrinters(page)
  const note = page.getByTestId('bridge-error')
  await expect(note).toContainText(TAKEN)
  await page.screenshot({ path: info.outputPath('printers.png') })
  // Try again asks the shell to start the bridge once more; the port is still taken, so the note stays.
  const before = await starts(page)
  await note.getByRole('button', { name: 'Try again' }).click()
  await expect.poll(() => starts(page)).toBe(before + 1)
  await expect(note).toContainText(TAKEN)
  // The same words in Settings > Printer bridge.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Printer bridge' }).click()
  await expect(page.locator('#bridge-h').locator('..').getByRole('alert')).toHaveText(TAKEN)
})
