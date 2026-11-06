// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey: an H2D set up with a 0.4 mm left and a 0.6 mm right nozzle. Two boxes on one filament both print on the
// right nozzle; the second box's nozzle chip offers the left nozzle, with a new filament because the first box keeps
// the shared one. The slice reads back each box's nozzle size, the machine card names both sizes, and the filament map
// is set by hand with its automatic switch off. Nothing moves when the chip and its menu open. Desktop and phone.
import { type Page } from '@playwright/test'
import { closeSheet, expect, openSheet } from '../fixtures'
import { H2D, HAND_PRINTERS, setState, sidebarAs, sidebarDone, test } from './lib/shell'
import { command, startSlice } from './lib/slice'

test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, cadTools: true, handPrinters: HAND_PRINTERS } })

type Sx = { getState(): { plate: { id: string }[]; slotSetup: Record<string, unknown>; plates: { settings: { nozzleMap?: number[] } }[]; slice: { status: string; result?: { featureFilaments?: { name: string; nozzleMm?: number }[] } } } }
const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())

/** Two boxes on filament 1 of the H2D, its nozzles 0.4 and 0.6 mm as printer setup saves them. */
async function twoBoxes(page: Page): Promise<void> {
  await sidebarAs(page, { mode: 'advanced', printer: H2D.id })
  await setState(page, { printerExtruders: { [H2D.id]: [{ mm: 0.4 }, { mm: 0.6 }], [H2D.profileId]: [{ mm: 0.4 }, { mm: 0.6 }] }, overrides: { enable_prime_tower: false }, slotSetup: {}, plate: [], selection: null, selectedIds: [] })
  await closeSheet(page)
  await command(page, 'Add a box')
  await command(page, 'Add a box')
  await expect.poll(async () => (await state(page)).plate.length).toBe(2)
  await openSheet(page)
}

const shot = async (page: Page, name: string) => {
  if (process.env['SX_SHOTS']) await page.screenshot({ path: test.info().outputPath(`${name}.png`) })
}

test('a box prints with the other nozzle from its chip, and the slice reads back both sizes', async ({ page }) => {
  test.slow()
  await twoBoxes(page)
  try {
    const chips = page.getByTestId('object-nozzle')
    await expect(chips).toHaveCount(2)
    await expect(chips.nth(0)).toHaveText('0.6 R')
    await expect(chips.nth(1)).toHaveText('0.6 R')
    await expect(page.getByTestId('slice-machine-card')).toBeVisible()
    await shot(page, 'object-nozzle-rows')

    // The chip stays where it is while its menu opens.
    const before = await chips.nth(1).boundingBox()
    await chips.nth(1).click()
    const menu = page.getByTestId('object-nozzle-pick')
    await expect(menu).toBeVisible()
    expect(await chips.nth(1).boundingBox()).toEqual(before)
    await expect(menu.getByTestId('object-nozzle-item')).toHaveText([/Right nozzle, 0\.6 mm/])
    await expect(menu.getByTestId('object-nozzle-move')).toHaveText(/Move filament 1/)
    await expect(menu.getByTestId('object-nozzle-new')).toHaveText(/Use a new filament for/)
    await shot(page, 'object-nozzle-menu')
    await menu.getByTestId('object-nozzle-new').click()
    await expect(menu).toBeHidden()
    await expect(chips.nth(1)).toHaveText('0.4 L')
    await expect(chips.nth(0)).toHaveText('0.6 R')
    expect((await state(page)).plates[0]?.settings.nozzleMap).toEqual([2, 1])

    // The filament map is set by hand here, its automatic switch off and disabled with the reason.
    await expect(page.getByTestId('nozzle-map-sizes-note')).toBeVisible()
    await expect(page.locator('#nozzle-auto')).toBeDisabled()
    await shot(page, 'object-nozzle-map')

    await closeSheet(page)
    await startSlice(page)
    await expect.poll(async () => ((await state(page)).slice.result?.featureFilaments ?? []).map((f) => f.nozzleMm)).toEqual([0.6, 0.4])
    await openSheet(page)
    await shot(page, 'object-nozzle-sliced')
  } finally {
    await setState(page, { printerExtruders: {}, overrides: {} })
    await sidebarDone(page)
  }
})
