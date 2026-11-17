// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Mixed filaments on the Filament card: the Mix button opens the editor, a mix saves as a striped spool under the
// loaded ones, a click on it puts the selection on it as on any spool, and Delete mix puts the parts back. Simple mode
// shows the row only once the project has a mix. With SX_SHOTS set it shoots the card, the editor, the part on the mix
// in the view and its sliced preview at desktop width, light and dark, to SX_SHOTS_DIR (test-results/shots by default).
import { join } from 'node:path'
import { type Page, type TestInfo } from '@playwright/test'
import { dismiss, expect, HAND_PRINTERS, BAY_1, mode, setState, sidebarAs, sidebarDone, sliceNow, test } from './lib/shell'

test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', printerId: BAY_1, pilot: { mode: 'off' }, cadTools: true, handPrinters: HAND_PRINTERS } })
test.skip(({ isMobile }) => isMobile, 'Desktop window')

type Sx = { getState(): { plate: { id: string; slotOverrides?: Record<string, number>; handle: { parts: { name: string; slot: number }[] } }[]; mixes: { id: number; name: string; ratio: number[] }[] } }
const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())
/** The filament each part of the plate's first object prints with. */
const onFirst = async (page: Page) => {
  const e = (await state(page)).plate[0]!
  return e.handle.parts.map((p) => e.slotOverrides?.[p.name] ?? p.slot)
}

/** Shoots the page as it is in both schemes, when SX_SHOTS is set. */
async function shots(page: Page, info: TestInfo, name: string): Promise<void> {
  if (!process.env['SX_SHOTS']) return
  for (const scheme of ['dark', 'light'] as const) {
    await setState(page, { scheme })
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('color-scheme'))).toBe(scheme)
    await page.screenshot({ path: join(process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots'), `${name}-${scheme}.png`) })
  }
  await setState(page, { scheme: 'dark' })
}

test('a mix made on the Filament card prints like a filament and shows striped', async ({ page }, info) => {
  await sidebarAs(page, { mode: 'advanced' })
  const mix = page.getByTestId('slice-filament-mix')
  await mix.scrollIntoViewIfNeeded()
  await expect(page.getByTestId('slice-filament-mix-spool')).toHaveCount(0)
  await mix.click()
  const dialog = page.getByTestId('mix-dialog')
  await expect(dialog).toBeVisible()
  // Two layers of A to one of B: the pattern, the color and the cost read back as they change.
  await page.getByTestId('mix-ra').fill('2')
  await expect(page.getByTestId('mix-preview')).toContainText('Layers print A A B, repeating.')
  await expect(page.getByTestId('mix-preview')).toContainText(/Approximate color #[0-9a-f]{6}/)
  await expect(page.getByTestId('mix-cost')).toContainText(/tool changes? and [\d.]+ g of flush|No extra tool changes/)
  await page.getByTestId('mix-name').fill('Sunset')
  await shots(page, info, 'mix-editor-1440')
  await page.getByTestId('mix-save').click()
  await expect(dialog).toHaveCount(0)
  const spool = page.getByTestId('slice-filament-mix-spool')
  await expect(spool).toHaveCount(1)
  await expect(spool).toHaveAttribute('data-slot', '32')
  await expect(spool.locator('circle[data-mix]')).toHaveCount(1)
  expect((await state(page)).mixes).toEqual([expect.objectContaining({ id: 32, name: 'Sunset', ratio: [2, 1] })])
  // The example plate's object is selected: a click on the mix puts it on the mix, as a click on a spool does.
  await spool.click()
  await expect(spool).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => onFirst(page)).toContain(32)
  await page.getByTestId('slice-filament-mixes').scrollIntoViewIfNeeded()
  await shots(page, info, 'mix-card-1440')
  // Simple mode keeps the row while the project has a mix.
  await mode(page, 'simple')
  await expect(spool).toHaveCount(1)
  await mode(page, 'advanced')
  if (process.env['SX_SHOTS']) {
    // The part in the view draws in the mix's color; the slice prints it by layer.
    await shots(page, info, 'mix-part-view-1440')
    await sliceNow(page)
    await shots(page, info, 'mix-preview-1440')
  }
  // Delete it from its editor: the part goes back to its first filament.
  await spool.click({ button: 'right' })
  await expect(dialog).toBeVisible()
  await page.getByTestId('danger-mix-delete').click()
  await expect(spool).toHaveCount(0)
  await expect.poll(() => onFirst(page)).not.toContain(32)
  await dismiss(page)
  await setState(page, { mixes: [] })
  await sidebarDone(page)
})

test('Simple mode leaves the Mixes row out of a project with no mix', async ({ page }) => {
  await sidebarAs(page, { mode: 'simple' })
  await expect(page.getByTestId('slice-filament-rail')).toBeVisible()
  await expect(page.getByTestId('slice-filament-mixes')).toHaveCount(0)
  await sidebarDone(page)
})
