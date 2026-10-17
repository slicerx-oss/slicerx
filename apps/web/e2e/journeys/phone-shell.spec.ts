// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The phone's frame: Slice with its settings sheet, the machine card, the Objects card and the Filament rail inside
// that sheet, and toasts over it. A phone views and prints, so its settings are Simple only and its panes are bottom
// sheets. The desktop window's checks are in shell.spec.ts and sidebar.spec.ts.
import { closeSheet, expect, openSheet } from '../fixtures'
import { addPlateFromPicker, pickPlate } from '../plate-project'
import {
  BAY_1, HAND_PRINTERS, addFilamentMovesNothing, box, dismiss, emptyPlateSaysSo, exampleX, exportOnly, fullSectionWraps, goSlice, machineBoxesChange, objectRowIsCompact, optionsMenuOnTop, plateTypePerPlate,
  postToast, sidebarAs, sidebarDone, slotHighlights, spoolsShow, test, toastAwayFromPlate, visibleControls, mode,
} from './lib/shell'

test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'simple', printerId: BAY_1, pilot: { mode: 'off' }, cadTools: true, handPrinters: HAND_PRINTERS } })
test.skip(({ isMobile }) => !isMobile, 'Phone window; the desktop checks are in shell.spec.ts and sidebar.spec.ts')

test('a phone\'s Slice, with its settings sheet open, shows 31 controls or fewer', { tag: '@smoke' }, async ({ page }) => {
  await exampleX(page)
  await mode(page, 'simple')
  await openSheet(page)
  const list = await visibleControls(page)
  console.log('phone slice', list.length, list.join(' | '))
  // a phone views and prints: Simple settings, the objects as a list, and no plate tools or modeling
  // 29: the plate picker's Previous plate, the plate and Next plate (see the desktop count)
  // 31: every loaded spool shows in the Filament section, not only the ones in use (two more on the reference AMS)
  expect(list.length).toBeLessThanOrEqual(31)
  await closeSheet(page)
})

test('the printer row is three boxes in the sheet, each other section is its own panel, and nothing folds', async ({ page }) => {
  await sidebarAs(page, { mode: 'simple' })
  const row = page.locator('.sx-block[data-section="printer"] .mc-row')
  await expect(row).toBeVisible()
  for (const id of ['slice-machine-printer', 'slice-machine-nozzle', 'slice-machine-plate']) await expect(row.getByTestId(id)).toBeVisible()
  for (const id of ['filament', 'settings']) {
    const sec = page.locator(`.pane-body > .sx-block[data-section="${id}"]`)
    await expect(sec).toBeVisible()
    await expect(sec.locator('.sx-block-h .sx-block-icon')).toHaveCount(1)
  }
  await expect(page.locator('#printer-fold, #filament-fold')).toHaveCount(0)
  await sidebarDone(page)
})

test.describe('the machine card in the sheet', () => {
  test('the printer, nozzle and plate boxes change them in place, with the printer\'s name in full', async ({ page }) => {
    await machineBoxesChange(page)
  })

  test('the plate type is per plate, with the sheet closing for the plate picker', async ({ page }) => {
    await plateTypePerPlate(page, { add: () => addPlateFromPicker(page), show: (n) => pickPlate(page, n) })
  })

  test('a printer with no connection reads Export only', async ({ page }) => {
    await exportOnly(page)
  })
})

test.describe('the Objects card in the sheet', () => {
  test('a row is one 44 px line with the name, the parts and their colors; print always shows and lock waits for the desktop', async ({ page }) => {
    await objectRowIsCompact(page, true)
  })

  test('an empty plate says so and points at Add', async ({ page }) => {
    await emptyPlateSaysSo(page)
  })
})

test.describe('the Filament rail in the sheet', () => {
  test('focusing a slot picks its filament out in the viewport, and leaving clears it', async ({ page }) => {
    await slotHighlights(page, true)
  })

  test('every loaded spool shows; the ones in use carry an edge and a part count; a tap moves nothing', async ({ page }) => {
    await spoolsShow(page)
  })

  test('the Filament options menu sits on top of the nozzle rows under it', async ({ page }) => {
    await optionsMenuOnTop(page, true)
  })

  test('a full section wraps inside the card, never the page', async ({ page }) => {
    await fullSectionWraps(page)
  })

  test('Add filament shows in Simple, opens the new filament, and moves nothing', async ({ page }) => {
    await addFilamentMovesNothing(page, 'simple')
  })
})

// ---- toasts --------------------------------------------------------------------------------------------------

test.describe('toasts on a phone', () => {
  test('a toast floats above an open sheet and leaves it where it is', { tag: '@gpu' }, async ({ page }) => {
    await box(page)
    await dismiss(page)
    await openSheet(page)
    const sheet = page.locator('aside.pane.sheet-open')
    // measured once it has finished sliding up
    await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined))))
    const before = (await sheet.boundingBox())!
    // A toast on the sheet would take the tap meant for the control under it.
    const toast = await postToast(page, 'Saved the plate.')
    expect(toast.y + toast.height).toBeLessThanOrEqual(before.y + 1)
    expect((await sheet.boundingBox())!.y).toBe(before.y)
    // Shut, the sheet frees the bottom again, and the stack goes back down over the plate bar.
    await closeSheet(page)
    const bar = (await page.locator('.vp > .hud-bl').boundingBox())!
    await expect.poll(async () => {
      const t = await postToast(page, 'Saved the plate again.')
      return Math.round(bar.y - (t.y + t.height))
    }).toBeGreaterThanOrEqual(0)
    expect((await postToast(page, 'Saved it once more.')).y).toBeGreaterThan(before.y)
  })

  test('away from the plate tab, toasts keep their place at the window bottom', { tag: '@gpu' }, async ({ page }) => {
    await goSlice(page)
    await closeSheet(page)
    await toastAwayFromPlate(page)
  })
})
