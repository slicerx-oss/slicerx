// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Plates, on one page: a project with several plates opens on plate 1 and draws it, the plate picker keeps one row and
// steps through 1, 3 or 27 plates, a delta printer's round bed, and the fit check on the Vault's starters. Each step
// opens its own project or starts over with the example plate, so none counts on the one before. The phone legs of
// the picker are in phone-model.spec.ts. The plate rows that were in plate.spec.ts (adding a plate, moving an object
// to it, each plate's bed type) are in 'plates in the Slice tab'. The plate output rows are in slicing-preview.spec.ts
// and the reveal in nightly/plate-reveal.spec.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page, TestInfo } from '@playwright/test'
import { aim, onCanvas, screenOf as screen } from '../canvas-press'
import { closeSheet, expect, openSheet, openTransform, sliceCount, sliced, viewSized, within } from '../fixtures'
import { journey as test } from '../journey'
import { DECK_BOX_27, SMALL_3, addPlateFromPicker, pickPlate, plateProject, plateSheet, shownPlateSettings, shutPlateSheet } from '../plate-project'
import { expectFileDialog, interceptFileDialogs } from '../file-dialog'
import { zip } from '../project-zip'
import { plateReady } from '../fixtures'
import { current, dropPath, examplePlate, next, openFile, openModel, openPlates, oneRowClearOfLane, pickerBoxes, picker, prev, setState, settleOpen, shown, useFileDialogs, useFlags, useStarters } from './lib/model'

// The V400 is one of the person's printers from the start, as the round bed steps need it; the others do not use it.
const V400 = { id: 'e2e-v400', name: 'Delta V400', profileId: 'flsun-v400', vendor: 'FLSUN', model: 'V400', nozzleCount: 1 }
test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, sliceLook: 'toolpaths', autoSliceBySize: false, handPrinters: [V400] } })
test.skip(({ isMobile }) => isMobile, 'Runs at desktop width')
useFlags()
useFileDialogs()
const starters = useStarters()

type Entry = { id: string; name: string; transform: number[]; parts: { positions: ArrayLike<number> }[] }
type Sx = {
  getState(): {
    plates: { id: string; objects: { id: string }[] }[]
    plate: Entry[]
    activePlate: string
    plateLoading: boolean
    viewportBackend: string
    printerId: string
    autoSlice: boolean
    autoSliceBySize: boolean
    bed: { widthMm: number; depthMm: number; heightMm: number; round?: boolean }
    slice: { status: string; stale?: boolean; result?: { id: string; primeTower?: unknown } }
    projectFile: { id: string; name: string; size: number; path?: string } | null
  }
  setState(p: unknown): void
}
const store = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())

// ---------------------------------------------------------------------------------------------------------------------
// A project with several plates draws the plate shown
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A project with several plates opens on plate 1, and the view draws plate 1: the objects the 3D view draws are the
 * shown plate's, as the plate picker and the store say. Showing another plate draws that plate, opening the project
 * again while plate 2 is shown starts on plate 1 again, and a project with one plate opens as before.
 */
test.describe('a project with plates draws the plate shown', () => {
  const PLATES = ['Bambu - Ivory White', 'Charcoal parts']
  type Vp = { drawnObjects(): string[] }

  /** The objects the view draws now, each plate's objects, and which plate is shown (from 1). */
  async function scene(page: Page): Promise<{ drawn: string[]; plates: string[][]; shown: number; loading: boolean }> {
    return page.evaluate(() => {
      const s = (window as unknown as { __sx: Sx }).__sx.getState()
      const vp = (window as unknown as { __vp?: Vp }).__vp
      const plates = s.plates.map((p) => (p.id === s.activePlate ? s.plate : p.objects).map((o) => o.id))
      const known = new Set(plates.flat())
      return { drawn: (vp?.drawnObjects() ?? []).filter((id) => known.has(id)).sort(), plates: plates.map((ids) => [...ids].sort()), shown: s.plates.findIndex((p) => p.id === s.activePlate) + 1, loading: s.plateLoading }
    })
  }

  /** Waits for the open to finish and a few frames to be drawn, then expects plate `n` shown and drawn. */
  async function expectDrawn(page: Page, n: number, snap?: () => Promise<void>): Promise<void> {
    await expect.poll(async () => (await scene(page)).loading, { timeout: 60_000 }).toBe(false)
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r())))))
    // The picture of the view as the open left it, before anything is checked.
    await snap?.()
    const s = await scene(page)
    expect(s.shown).toBe(n)
    expect(s.plates[n - 1]!.length).toBeGreaterThan(0)
    expect(s.drawn, `the view draws plate ${n}'s objects`).toEqual(s.plates[n - 1])
    await expect(page.getByTestId('plate-picker-current').locator('.pp-no')).toHaveText(`Plate ${n}`)
  }

  /** A picture of the view, for review: SX_SHOTS=1 only. */
  function shot(page: Page, info: TestInfo, name: string): (() => Promise<void>) | undefined {
    if (!process.env['SX_SHOTS']) return undefined
    return async () => {
      const path = info.outputPath(`${name}.png`)
      await page.screenshot({ path })
      await info.attach(name, { path, contentType: 'image/png' })
    }
  }

  async function on3d(page: Page): Promise<void> {
    // The 2D fallback draws the plate as it is told; the scene hold this checks is the 3D view's.
    await expect.poll(async () => (await store(page)).viewportBackend, { timeout: 30_000 }).toMatch(/WebGL2|WebGPU/)
  }

  test('a project with two plates opens on plate 1 and draws plate 1, and each plate shown is the one drawn', async ({ page }, info) => {
    await openPlates(page, PLATES)
    await on3d(page)
    await expectDrawn(page, 1, shot(page, info, 'open-two-plates'))
    await expect(page.getByTestId('plate-picker-current')).toContainText(PLATES[0]!)
    await pickPlate(page, 2)
    await expectDrawn(page, 2)
    await pickPlate(page, 1)
    await expectDrawn(page, 1)
  })

  test('opening the project again while plate 2 is shown starts on plate 1 and draws it', async ({ page }, info) => {
    await openPlates(page, PLATES)
    await expectDrawn(page, 1)
    await pickPlate(page, 2)
    await expectDrawn(page, 2)
    const before = (await scene(page)).plates.flat()
    await openFile(page, { name: 'Deck box.3mf', mimeType: 'model/3mf', buffer: plateProject(PLATES) })
    // The project opened from another slicer's file was never saved, so the app asks first; it is not kept. If it then
    // asks how to open the file onto a plate with objects, the whole project replaces what is open. The new open's
    // objects are on both plates (new ids, so this is not the project that was open).
    await settleOpen(page, async () => { const s = await scene(page); return !s.loading && s.plates.length === PLATES.length && s.plates.every((ids) => ids.length > 0 && !ids.some((id) => before.includes(id))) }, { asProject: true })
    await expectDrawn(page, 1, shot(page, info, 'reopen-on-plate-two'))
    expect((await scene(page)).plates).toHaveLength(PLATES.length)
  })

  test('a project with one plate opens and draws it', async ({ page }) => {
    await openPlates(page, [PLATES[0]!])
    await expectDrawn(page, 1)
    expect((await scene(page)).plates).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// The plate picker
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The plate picker at the foot of Slice's view: the previous plate, the plate in view and the next, in one row of fixed
 * widths with 1, 3 or 27 plates. The plate opens a sheet of every plate with a search and a Not sliced filter.
 * Shift+[ and Shift+] step through the plates ([ and ] alone stay the side panels). Names are cut in the middle with the
 * full name in the tooltip, nothing moves as plates or slices change, and the floating toolbar keeps its own lane at the
 * top: the picker never reaches it, and neither does the open sheet. How a toast looks and times out is tested in
 * packages/ui/test/toast.test.tsx (the two line wrap :385, the warning and the error that stay :245-319, the card's
 * padding and lift :378) and the pill's height and lift in packages/app/test/plate-picker.test.ts:178-190.
 */
test.describe('the plate picker', () => {
  test('one plate: Plate 1 of 1 with both steps off, and Add plate in the sheet moves nothing', async ({ page }) => {
    await examplePlate(page)
    await viewSized(page)
    await expect(current(page).locator('.pp-no')).toHaveText('Plate 1')
    await expect(current(page).locator('.pp-of')).toHaveText('of 1')
    await expect(prev(page)).toBeDisabled()
    await expect(next(page)).toBeDisabled()
    // The old chip wall and the plate chip are gone; the picker is the one plate control in the view.
    await expect(page.locator('.vp .plate-strip, .vp .plate-card, [data-testid="plate-chip"]')).toHaveCount(0)
    await oneRowClearOfLane(page)
    const before = await pickerBoxes(page)
    const sheet = await plateSheet(page)
    await expect(sheet.locator('.pp-card')).toHaveCount(1)
    await oneRowClearOfLane(page, sheet)
    await addPlateFromPicker(page)
    await expect(current(page).locator('.pp-no')).toHaveText('Plate 2')
    await expect(current(page).locator('.pp-of')).toHaveText('of 2')
    await expect(prev(page)).toBeEnabled()
    await expect(next(page)).toBeDisabled()
    expect(await pickerBoxes(page)).toEqual(before)
    await prev(page).click()
    expect(await shown(page)).toBe(1)
    expect(await pickerBoxes(page)).toEqual(before)
  })

  test('three plates: buttons and Shift+[ / Shift+] step and stop at the ends; [ alone stays the panel key', async ({ page }) => {
    await openPlates(page, SMALL_3)
    await viewSized(page)
    await expect(current(page)).toContainText('Plate 1')
    await expect(current(page)).toContainText('Pi case base')
    await expect(current(page).locator('.pp-of')).toHaveText('of 3')
    const before = await pickerBoxes(page)
    await oneRowClearOfLane(page)
    await next(page).click()
    expect(await shown(page)).toBe(2)
    await expect(current(page)).toContainText('Pi case lid')
    await next(page).click()
    expect(await shown(page)).toBe(3)
    await expect(next(page)).toBeDisabled()
    expect(await pickerBoxes(page)).toEqual(before)
    // The keys, from the view: Shift+[ steps back, Shift+] forward, and both stop at the ends.
    await page.locator('canvas.vp-canvas').focus()
    await page.keyboard.press('Shift+BracketRight')
    expect(await shown(page)).toBe(3)
    await page.keyboard.press('Shift+BracketLeft')
    await expect.poll(() => shown(page)).toBe(2)
    await page.keyboard.press('Shift+BracketLeft')
    await expect.poll(() => shown(page)).toBe(1)
    await page.keyboard.press('Shift+BracketLeft')
    expect(await shown(page)).toBe(1)
    await expect(prev(page)).toBeDisabled()
    await page.keyboard.press('Shift+BracketRight')
    await expect.poll(() => shown(page)).toBe(2)
    // [ alone still shows or hides the left panel and leaves the plate where it is.
    const left = page.getByTestId('edge-tab-left')
    const was = await left.getAttribute('aria-expanded')
    await page.keyboard.press('BracketLeft')
    await expect(left).not.toHaveAttribute('aria-expanded', was ?? '')
    expect(await shown(page)).toBe(2)
    await page.keyboard.press('BracketLeft')
    await expect(left).toHaveAttribute('aria-expanded', was ?? '')
    // The picker's tooltips name the keys.
    await expect(next(page)).toHaveAttribute('data-tip-key', /\]/)
    await expect(prev(page)).toHaveAttribute('data-tip-key', /\[/)
  })

  test('27 plates: one row, names cut in the middle with the full name in the tooltip, and nothing moves from first to last', async ({ page }) => {
    await openPlates(page, DECK_BOX_27, [5, 12])
    await viewSized(page)
    await oneRowClearOfLane(page)
    const before = await pickerBoxes(page)
    await expect(current(page).locator('.pp-of')).toHaveText('of 27')
    // The long name keeps its start and its end, and the tooltip has it whole.
    const name = current(page).locator('.pp-name')
    await expect(name).toHaveText(/…/)
    await expect(name).toHaveAttribute('data-full', DECK_BOX_27[0]!)
    await expect(name).toHaveText(/^Retro/)
    await expect(name).toHaveText(/half$/)
    await expect(current(page)).toHaveAttribute('data-tip-title', `Plate 1: ${DECK_BOX_27[0]}`)
    const fits = () => name.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
    await expect.poll(fits).toBe(true)
    // Through every plate to the last: the controls keep their places, and each name fits its box.
    for (let i = 2; i <= 27; i++) {
      await next(page).click()
      await expect(current(page).locator('.pp-no')).toHaveText(`Plate ${i}`)
      await expect.poll(fits, { message: `plate ${i}` }).toBe(true)
      if (i % 9 === 0 || i === 27) expect(await pickerBoxes(page), `plate ${i}`).toEqual(before)
    }
    await expect(next(page)).toBeDisabled()
    await expect(name).toHaveAttribute('data-full', DECK_BOX_27[26]!)
    await oneRowClearOfLane(page)
    // The phone width test ends here; the desktop one checks 1280 by 800 as well.
    await page.setViewportSize({ width: 1280, height: 800 })
    try {
      await viewSized(page)
      await oneRowClearOfLane(page)
      const sheet = await plateSheet(page)
      await oneRowClearOfLane(page, sheet)
      await shutPlateSheet(page)
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 })
    }
  })

  test('every plate is reachable by Prev and Next, and by its card in the sheet', async ({ page }) => {
    await openPlates(page, DECK_BOX_27, [5, 12])
    await viewSized(page)
    const no = current(page).locator('.pp-no')
    // Next walks up to the last plate and Prev walks back down to the first, one plate a step, never wrapping.
    for (let i = 2; i <= 27; i++) {
      await next(page).click()
      await expect(no).toHaveText(`Plate ${i}`)
    }
    await expect(next(page)).toBeDisabled()
    for (let i = 26; i >= 1; i--) {
      await prev(page).click()
      await expect(no).toHaveText(`Plate ${i}`)
    }
    await expect(prev(page)).toBeDisabled()
    // Each card in the sheet shows its own plate and shuts the sheet, empty plates included.
    for (let i = 27; i >= 1; i--) {
      const sheet = await plateSheet(page)
      const card = sheet.locator('.pp-card').nth(i - 1)
      await card.click()
      await expect(sheet).toBeHidden()
      await expect(no).toHaveText(`Plate ${i}`)
    }
  })

  test('the sheet finds plates by name or number, and Not sliced leaves out sliced and empty plates', async ({ page }) => {
    await openPlates(page, DECK_BOX_27, [5, 12])
    await viewSized(page)
    const before = await pickerBoxes(page)
    const sheet = await plateSheet(page)
    await oneRowClearOfLane(page, sheet)
    const cards = sheet.locator('.pp-card')
    await expect(cards).toHaveCount(27)
    await expect(sheet.locator('.pp-card[aria-current="true"]')).toHaveCount(1)
    await expect(sheet.locator('.pp-card[data-state="empty"]')).toHaveCount(2)
    // Typing finds by name, every word; a number finds that plate.
    const search = sheet.getByRole('searchbox', { name: 'Find a plate' })
    await expect(search).toBeFocused()
    await search.fill('kart')
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).toHaveAttribute('data-tip-title', `Plate 19: ${DECK_BOX_27[18]}`)
    await search.fill('label plate')
    await expect(cards).toHaveCount(10)
    await search.fill('27')
    await expect(cards).toHaveCount(1)
    // Enter shows the first plate found and shuts the sheet.
    await search.press('Enter')
    await expect(sheet).toBeHidden()
    expect(await shown(page)).toBe(27)
    expect(await pickerBoxes(page)).toEqual(before)

    // Not sliced: plates with objects and no slice. Slicing the plate in view takes it off the list.
    const open = await plateSheet(page)
    await open.getByRole('radio', { name: 'Not sliced' }).click()
    await expect(open.locator('.pp-card')).toHaveCount(25)
    await expect(open.locator('.pp-card[data-state="empty"]')).toHaveCount(0)
    const seg = (await open.getByRole('radio', { name: 'Not sliced' }).boundingBox())!
    await open.getByRole('radio', { name: 'All' }).click()
    expect((await open.getByRole('radio', { name: 'Not sliced' }).boundingBox())!).toEqual(seg)
    await shutPlateSheet(page)
    const n = await sliceCount(page)
    await page.getByRole('button', { name: 'Slice plate' }).first().click()
    await expect(sliced(page, n)).toBeVisible({ timeout: 120_000 })
    await viewSized(page)
    // The layer panel opens under the view and the picker rides above it: the same sizes and left edges, one row.
    const raised = await pickerBoxes(page)
    expect(raised.map(({ x, width, height }) => ({ x, width, height }))).toEqual(before.map(({ x, width, height }) => ({ x, width, height })))
    await oneRowClearOfLane(page)
    const after = await plateSheet(page)
    await expect(after.locator('.pp-card').nth(26)).toHaveAttribute('data-state', 'sliced')
    await after.getByRole('radio', { name: 'Not sliced' }).click()
    await expect(after.locator('.pp-card')).toHaveCount(24)
    await after.getByRole('searchbox', { name: 'Find a plate' }).fill('coupon')
    await expect(after.locator('.pp-card')).toHaveCount(0)
    await expect(after.getByText('No plate matches.')).toBeVisible()
    await shutPlateSheet(page)
    expect(await pickerBoxes(page)).toEqual(raised)
  })

  test('the toasts wait out of sight while the sheet is open, and Details opens a line in place without moving the card top', async ({ page }) => {
    await openPlates(page, SMALL_3)
    await viewSized(page)
    type Toaster = { setState(p: { toast: { id: number; text: string; tone?: string } }): void }
    const post = (id: number, text: string) => page.evaluate(([i, t]) => (window as unknown as { __sx: Toaster }).__sx.setState({ toast: { id: i as number, text: t as string, tone: 'info' } }), [id, text] as const)
    // The project's own open note may still be on the card, so the lines are found by their text. The first note is
    // long enough that its reading time outlasts the steps below.
    await post(9001, 'First note for the card. With more to read behind Details, long enough to wrap onto a second line when it opens in place, and longer still so that it stays on the card while the sheet opens and shuts again.')
    await post(9002, 'Second note.')
    const card = page.getByTestId('toasts')
    const lines = card.getByTestId('toast')
    const first = lines.filter({ hasText: 'First note' })
    const second = lines.filter({ hasText: 'Second note.' })
    await expect(first).toHaveCount(1)
    await expect(second).toHaveCount(1)
    // One card, a line each.
    for (const l of [first, second]) expect((await l.boundingBox())!.height).toBeLessThanOrEqual(44)
    await plateSheet(page)
    await expect(card).toBeHidden()
    await shutPlateSheet(page)
    await expect(card).toBeVisible()
    await expect(first).toHaveCount(1)
    // The card's place is measured from the view's controls a frame or more after the sheet shuts, so under load it
    // can still move: wait until it holds still for 200 ms before taking its top.
    let top = -1
    await expect
      .poll(async () => {
        const was = top
        top = (await card.boundingBox())!.y
        await page.waitForTimeout(200)
        return was === top && (await card.boundingBox())!.y === top
      })
      .toBe(true)
    // Details grows the card down: its top edge stays, and the line shows its whole text.
    await first.getByTestId('toast-details').click()
    await expect(first).toHaveAttribute('data-expanded', '')
    await expect(first.locator('.sx-toast-more')).toBeVisible()
    expect(Math.round((await card.boundingBox())!.y)).toBe(Math.round(top))
    await first.getByRole('button', { name: 'Less' }).click()
    await expect(first.locator('.sx-toast-more')).toBeHidden()
  })

  test('the pill controls are 34 px tall and the pill, the grid and the card carry the lift edge', async ({ page }) => {
    await openPlates(page, SMALL_3)
    await viewSized(page)
    for (const l of [prev(page), current(page), next(page)]) expect((await l.boundingBox())!.height).toBe(34)
    const shadow = (l: ReturnType<typeof picker>) => l.evaluate((el) => getComputedStyle(el).boxShadow)
    const edge = /rgba\(255, 255, 255, 0\.07\) 0px 1px 0px 0px inset/
    expect(await shadow(picker(page))).toMatch(edge)
    await plateSheet(page)
    expect(await shadow(page.getByTestId('plate-sheet'))).toMatch(edge)
    await shutPlateSheet(page)
    await setState(page, { toast: { id: 9201, text: 'Lift edge check.', tone: 'info' } })
    const card = page.getByTestId('toasts')
    await expect(card).toBeVisible()
    expect(await shadow(card)).toMatch(edge)
    const pad = await card.evaluate((el) => { const c = getComputedStyle(el); return [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft] })
    expect(pad).toEqual(['16px', '16px', '16px', '16px'])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Plates in the Slice tab
// ---------------------------------------------------------------------------------------------------------------------

/** Set the shown plate's type in its plate settings, then close them. */
async function setBedType(page: Page, plate: string, value: string): Promise<void> {
  const form = await shownPlateSettings(page, plate)
  await form.getByLabel('Bed type').selectOption(value)
  await page.getByRole('button', { name: 'Done' }).click()
  await shutPlateSheet(page)
}

test.describe('plates in the Slice tab', () => {
  test('plates: add, switch, per-plate sequence, move objects', async ({ page }) => {
    await examplePlate(page)
    const objs = page.locator('.objs > li')
    await addPlateFromPicker(page)
    await expect((await plateSheet(page)).locator('.pp-card')).toHaveCount(2)
    await shutPlateSheet(page)
    await expect(objs).toHaveCount(0)
    await pickPlate(page, 1)
    await expect(objs).toHaveCount(1)
    await pickPlate(page, 2)
    const form = await shownPlateSettings(page, 'Plate 2')
    await form.getByLabel('Print sequence').selectOption('by-object')
    await page.getByRole('button', { name: 'Done' }).click()
    await shutPlateSheet(page)
    await pickPlate(page, 1)
    await openSheet(page)
    await page.locator('.obj-name', { hasText: 'Layered X' }).click()
    // Move to plate is on the selection bar under the object list.
    await page.getByTestId('slice-selection-move-plate').click()
    await page.getByRole('menuitem', { name: 'Plate 2' }).click()
    await expect(objs).toHaveCount(0)
    await closeSheet(page)
    await pickPlate(page, 2)
    await expect(objs).toHaveCount(1)
  })

  test('the printer card shows each plate\'s bed type', async ({ page }) => {
    await examplePlate(page)
    const card = page.locator('[data-section="printer"]')
    const plateType = page.getByTestId('slice-machine-plate-label')
    // Plate 1 prints on the printer's default; the card names it and never reads "unknown".
    await expect(plateType).toHaveText(/\S/)
    const first = (await plateType.textContent()) ?? ''
    expect(['Textured PEI', 'Smooth PEI', 'Cool plate', 'Engineering plate', 'High temp plate']).toContain(first)
    await expect(card).not.toContainText('unknown')
    await addPlateFromPicker(page)
    await setBedType(page, 'Plate 2', 'smooth-pei')
    await expect(plateType).toHaveText('Smooth PEI')
    await pickPlate(page, 1)
    await expect(plateType).toHaveText(first)
    await pickPlate(page, 2)
    await expect(plateType).toHaveText('Smooth PEI')
    // Back to the printer's default.
    await setBedType(page, 'Plate 2', '')
    await expect(plateType).toHaveText(first)
  })

  test('the plate box names the longest plate type in its tooltip and keeps the printer row one line', async ({ page }) => {
    await examplePlate(page)
    const plateType = page.getByTestId('slice-machine-plate')
    // The longest plate type in the picker, on the new plate.
    await addPlateFromPicker(page)
    await setBedType(page, 'Plate 2', 'engineering')
    await openSheet(page)
    await expect(page.getByTestId('slice-machine-plate-label')).toHaveText('Engineering plate')
    await expect(plateType).toHaveAttribute('data-tip-title', 'Engineering plate')
    await expect(plateType).toHaveAttribute('aria-label', 'Plate: Engineering plate')
    // The box shows the type's icon, so the row keeps its height: the plate box is as tall as the nozzle box beside it.
    expect(Math.abs((await plateType.boundingBox())!.height - (await page.getByTestId('slice-machine-nozzle').boundingBox())!.height)).toBeLessThan(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// A round bed
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A delta printer's round bed, on the FLSUN V400 (a 300 mm circle): the bed reads and draws as a circle, Fill bed and
 * Arrange all keep every part inside it, and the off-bed check judges a part by the circle, not its square box. A part
 * just past the rim on the diagonal sits well inside the box, so only the circle flags it. Everything is read from the
 * app's state and the viewport's own outline settings, never from pixels.
 */
/**
 * A P1S project printed by object: Bracket and Housing 15 mm apart, so the head would come down on Bracket, and Clip
 * clear of both. Bracket is 45 mm tall, over the 34 mm the gantry rod clears, and listed first.
 */
function byObjectProject(): Buffer {
  const parts = [
    { name: 'Bracket', size: [40, 40, 45], at: [60, 100] },
    { name: 'Housing', size: [60, 50, 15], at: [115, 95] },
    { name: 'Clip', size: [20, 20, 10], at: [205, 222] },
  ]
  const box = (id: number, [sx, sy, sz]: number[]) => {
    const v = [[0, 0, 0], [sx, 0, 0], [sx, sy, 0], [0, sy, 0], [0, 0, sz], [sx, 0, sz], [sx, sy, sz], [0, sy, sz]]
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
    return `<object id="${id}" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${f.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`
  }
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${parts.map((o, i) => box(i + 1, o.size)).join('')}</resources><build>${parts.map((o, i) => `<item objectid="${i + 1}" transform="1 0 0 0 1 0 0 0 1 ${o.at[0]} ${o.at[1]} 0" printable="1"/>`).join('')}</build></model>`
  const objects = parts.map((o, i) => `<object id="${i + 1}"><metadata key="name" value="${o.name}"/><metadata key="extruder" value="1"/></object>`).join('')
  const plate = `<plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="Enclosure parts"/><metadata key="locked" value="false"/>${parts.map((_, i) => `<model_instance><metadata key="object_id" value="${i + 1}"/><metadata key="instance_id" value="0"/></model_instance>`).join('')}</plate>`
  const settings = { printer_settings_id: 'Bambu Lab P1S 0.4 nozzle', printer_model: 'Bambu Lab P1S', nozzle_diameter: ['0.4'], printable_area: ['0x0', '256x0', '256x256', '0x256'], layer_height: '0.2', print_sequence: 'by object', filament_colour: ['#00AE42'] }
  return zip({ '3D/3dmodel.model': model, 'Metadata/model_settings.config': `<?xml version="1.0" encoding="UTF-8"?><config>${objects}${plate}</config>`, 'Metadata/project_settings.config': JSON.stringify(settings) })
}

test.describe('a plate printed by object', () => {
  test('names the objects too close, selects them from the warning, and Arrange clears the warning and the red zones, the tall one printed last', async ({ page }) => {
    interceptFileDialogs(page)
    await page.addInitScript(() => {
      localStorage.setItem('slicerx.debug', '1')
      if (sessionStorage.getItem('sx-e2e')) return
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, autoSlice: false }))
    })
    await page.goto('./')
    await plateReady(page)
    const chooser = await expectFileDialog(page, () => page.keyboard.press('ControlOrMeta+o'))
    await chooser.setFiles({ name: 'Enclosure parts.3mf', mimeType: 'model/3mf', buffer: byObjectProject() })
    type Sx = { getState(): { plate: { id: string; name: string }[]; selectedIds: string[] } }
    type Zones = { __vp: { clearance: { conflicts: Set<string> } } }
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate.length), { timeout: 60_000 }).toBe(3)
    const warning = page.getByTestId('slice-clearance-warning')
    await expect(warning).toContainText('Too close to print by object')
    const row = page.getByTestId('slice-clearance-select')
    await expect(row).toContainText('Bracket and Housing')
    // the zones of the two draw red; Clip's does not
    await expect.poll(() => page.evaluate(() => [...(window as unknown as Zones).__vp.clearance.conflicts].length)).toBe(2)
    await row.click()
    const ids = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate.filter((e) => e.name !== 'Clip').map((e) => e.id))
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().selectedIds)).toEqual(ids)
    await page.getByTestId('slice-clearance-arrange').click()
    await expect(warning).toBeHidden({ timeout: 60_000 })
    await expect.poll(() => page.evaluate(() => (window as unknown as Zones).__vp.clearance.conflicts.size)).toBe(0)
    // Arrange printed Bracket last, so the gantry never passes over it
    expect(await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate.map((e) => e.name).at(-1))).toBe('Bracket')
  })
})

test.describe('a round bed', () => {
  type Vp = { stage: { outline: { uniforms: { rnd: { value: number }; alert: { value: number } } } | null } }

  /** The example plate on the person's V400; the printer picked before is put back by the returned function. */
  async function onV400(page: Page): Promise<() => Promise<void>> {
    await examplePlate(page)
    const was = (await store(page)).printerId
    const restore = () => setState(page, { printerId: was })
    try {
      await setState(page, { printerId: V400.id })
      // The printer's profile loads after the first plate; the bed turns round once it has.
      await expect.poll(async () => (await store(page)).bed.round === true).toBe(true)
    } catch (e) {
      await restore()
      throw e
    }
    return restore
  }

  /** Each object's footprint on the bed: how far its farthest point reaches from the bed's center, and its box. */
  function footprints(page: Page): Promise<{ id: string; reach: number; min: [number, number]; max: [number, number] }[]> {
    return page.evaluate(() => {
      const s = (window as unknown as { __sx: Sx }).__sx.getState()
      const cx = s.bed.widthMm / 2
      const cy = s.bed.depthMm / 2
      return s.plate.map((e) => {
        const m = e.transform
        let reach = 0
        const min: [number, number] = [Infinity, Infinity]
        const max: [number, number] = [-Infinity, -Infinity]
        for (const part of e.parts) for (let i = 0; i + 2 < part.positions.length; i += 3) {
          const px = part.positions[i]!, py = part.positions[i + 1]!, pz = part.positions[i + 2]!
          const x = m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!
          const y = m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!
          reach = Math.max(reach, Math.hypot(x - cx, y - cy))
          min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y)
          max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y)
        }
        return { id: e.id, reach, min, max }
      })
    })
  }

  async function expectInsideCircle(page: Page): Promise<void> {
    const bed = (await store(page)).bed
    const r = Math.min(bed.widthMm, bed.depthMm) / 2
    for (const f of await footprints(page)) expect(f.reach, `object ${f.id} reaches ${f.reach.toFixed(2)} mm from the center of a ${r} mm radius bed`).toBeLessThanOrEqual(r + 0.01)
    await expect(page.locator('[data-testid="object-warning"][data-kind="off-bed"]')).toHaveCount(0)
  }

  test('the FLSUN V400 bed reads and draws as a 300 mm circle', async ({ page }) => {
    const restore = await onV400(page)
    try {
      const bed = (await store(page)).bed
      expect(bed.round).toBe(true)
      expect(bed.widthMm).toBeCloseTo(300, 0)
      expect(bed.depthMm).toBeCloseTo(300, 0)
      // The viewport draws the outline, grid and fill by the circle (its round setting), with no off-bed alert.
      await expect.poll(() => page.evaluate(() => (window as unknown as { __vp: Vp }).__vp.stage.outline?.uniforms.rnd.value)).toBe(1)
      expect(await page.evaluate(() => (window as unknown as { __vp: Vp }).__vp.stage.outline?.uniforms.alert.value)).toBe(0)
    } finally {
      await restore()
    }
  })

  test('Fill bed and Arrange all keep every part inside the circle', async ({ page }) => {
    const restore = await onV400(page)
    try {
      await openSheet(page)
      const objs = page.locator('.objs > li')
      await expect(objs).toHaveCount(1)
      await openTransform(page)
      await page.getByRole('button', { name: 'Fill bed' }).click()
      await expect.poll(() => objs.count()).toBeGreaterThan(4)
      await expect(page.locator('html')).not.toHaveAttribute('data-sx-busy')
      await expectInsideCircle(page)
      const filled = await objs.count()
      await closeSheet(page)
      await page.getByRole('toolbar', { name: 'Plate tools' }).getByRole('button', { name: 'Arrange all' }).click()
      await expect(page.locator('html')).not.toHaveAttribute('data-sx-busy')
      await expect(objs).toHaveCount(filled)
      await expectInsideCircle(page)
    } finally {
      await restore()
    }
  })

  test('the off-bed check flags a part just past the rim and clears it just inside', async ({ page }) => {
    const restore = await onV400(page)
    try {
      await openSheet(page)
      await openTransform(page)
      const pos = page.getByRole('group', { name: 'Position' })
      // Where the object's translation goes, on the bed's front right diagonal, for its farthest point to reach `target` mm
      // from the center.
      const place = (target: number) => page.evaluate((target) => {
        const s = (window as unknown as { __sx: Sx }).__sx.getState()
        const e = s.plate[0]!
        const m = e.transform
        const offsets: [number, number][] = []
        for (const part of e.parts) for (let i = 0; i + 2 < part.positions.length; i += 3) {
          const px = part.positions[i]!, py = part.positions[i + 1]!, pz = part.positions[i + 2]!
          offsets.push([m[0]! * px + m[4]! * py + m[8]! * pz, m[1]! * px + m[5]! * py + m[9]! * pz])
        }
        const u = Math.SQRT1_2
        const reach = (d: number) => Math.max(...offsets.map(([x, y]) => Math.hypot(d * u + x, -d * u + y)))
        let lo = 0
        let hi = target
        for (let k = 0; k < 60; k++) {
          const mid = (lo + hi) / 2
          if (reach(mid) < target) lo = mid
          else hi = mid
        }
        return [s.bed.widthMm / 2 + lo * u, s.bed.depthMm / 2 - lo * u]
      }, target)
      const moveTo = async ([x, y]: number[]) => {
        for (const [axis, v] of [['X', x!], ['Y', y!]] as const) {
          const field = pos.getByRole('textbox', { name: new RegExp(axis) })
          await field.fill(v.toFixed(2))
          await field.press('Enter')
          await expect.poll(async () => Math.abs(Number(await field.inputValue()) - v)).toBeLessThan(0.01)
        }
      }
      const warning = page.locator('[data-testid="object-warning"][data-kind="off-bed"]')
      const alert = () => page.evaluate(() => (window as unknown as { __vp: Vp }).__vp.stage.outline?.uniforms.alert.value)

      // 1 mm past the rim: flagged, in the list and on the bed outline.
      await moveTo(await place(151))
      await expect(warning).toHaveCount(1)
      await expect(warning).toHaveAttribute('aria-label', /Off the bed/)
      await expect.poll(alert).toBe(1)
      // The part's box is well inside the 300 mm square, so a rectangle test would have passed it.
      const [past] = await footprints(page)
      expect(past!.reach).toBeGreaterThan(150)
      expect(past!.min[0]).toBeGreaterThan(0)
      expect(past!.min[1]).toBeGreaterThan(0)
      expect(past!.max[0]).toBeLessThan(300)
      expect(past!.max[1]).toBeLessThan(300)

      // Just inside the rim: the part itself is on the bed.
      await moveTo(await place(149))
      await expect(page.locator('[data-testid="object-warning"][aria-label*="Off the bed"]')).toHaveCount(0)
      const [inside] = await footprints(page)
      expect(inside!.reach).toBeLessThan(150)
    } finally {
      await restore()
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// The fit check
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The fit check on the Vault's starters, made by the same generator: every one opens alone with no notes, a separate
 * object that touches warns and its marker goes the moment it is dragged away. A design with a real gap is a fixture
 * of its own (fixtures/loose-clip.sx3mf: an earlier cable clip, our own geometry, whose ring floats 0.76 mm off its
 * foot), so no starter has to keep a fault. Opening a design starts a new project, so designs never pile up. Moving
 * an object never rebuilds the scene.
 */
test.describe('the fit check', () => {
  const STARTERS = ['x-mark', 'calibration-cube-20mm', 'wall-hook', 'shelf-bracket', 'first-layer-test', 'overhang-test', 'bridging-test', 'retraction-test', 'temperature-tower', 'cable-clip']
  interface FitVp {
    gaps: { group: { children: { visible: boolean; children: { matrixWorld: { elements: number[] } }[] }[] } }
    objects: Map<string, { group: { matrixWorld: { elements: number[] } } }>
    setPlate(...a: unknown[]): void
  }

  // The fit check runs when the plate changes and a drag lands on a plate sliced in the background, so these steps slice
  // on their own after every edit (Always); the step after finds Auto slice as it was.
  let auto: { autoSlice: boolean; autoSliceBySize: boolean } | null = null
  test.beforeEach(async ({ page }) => {
    const s = await store(page)
    auto = { autoSlice: s.autoSlice, autoSliceBySize: s.autoSliceBySize }
    await setState(page, { autoSlice: true, autoSliceBySize: false })
  })
  test.afterEach(async ({ page }) => {
    if (auto) await setState(page, auto)
    auto = null
  })

  /** The starter's file, opened (Mod+O): a new project with the file. */
  const openStarter = (page: Page, file: string) => openModel(page, join(starters(), file))
  /** A file from e2e/fixtures. */
  const openFixture = (page: Page, file: string) => openModel(page, join(import.meta.dirname, '..', 'fixtures', file))
  /** A drop adds the file to the plate. */
  const drop = (page: Page, file: string) => dropPath(page, join(starters(), file))

  /** An object's world box on the bed, mm. */
  const box = (page: Page, name: string) =>
    page.evaluate((name) => {
      const e = (window as unknown as { __sx: Sx }).__sx.getState().plate.find((p) => p.name === name)!
      const m = e.transform
      const min = [Infinity, Infinity, Infinity]
      const max = [-Infinity, -Infinity, -Infinity]
      for (const part of e.parts)
        for (let i = 0; i + 2 < part.positions.length; i += 3) {
          const [x, y, z] = [part.positions[i]!, part.positions[i + 1]!, part.positions[i + 2]!]
          const w = [0, 1, 2].map((k) => m[k]! * x + m[k + 4]! * y + m[k + 8]! * z + m[k + 12]!)
          for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k]!, w[k]!)
            max[k] = Math.max(max[k]!, w[k]!)
          }
        }
      return { min, max }
    }, name)

  const lines = (page: Page) => page.evaluate(() => (window as unknown as { __vp: FitVp }).__vp.gaps.group.children.map((c) => c.visible))

  /** Puts one object's +X side against another's -X side, centered on it in Y. */
  async function against(page: Page, mover: string, target: string): Promise<void> {
    const a = await box(page, mover)
    const b = await box(page, target)
    await page.evaluate(({ mover, dx, dy }) => {
      const st = (window as unknown as { __sx: Sx }).__sx
      st.setState({ plate: st.getState().plate.map((p) => (p.name === mover ? { ...p, transform: p.transform.map((v, i) => (i === 12 ? v + dx : i === 13 ? v + dy : v)) } : p)) })
    }, { mover, dx: b.max[0]! - a.min[0]!, dy: (b.min[1]! + b.max[1]!) / 2 - (a.min[1]! + a.max[1]!) / 2 })
  }

  test('parts of one object that touch never warn; a separate object that touches does, and its marker clears as it moves', { tag: '@gpu' }, async ({ page }) => {
    test.slow()
    await examplePlate(page)
    await setState(page, { plate: [], selection: null, selectedIds: [] })
    await drop(page, 'temperature-tower.sx3mf')
    await expect(page.locator('.obj-name', { hasText: 'Temperature tower' })).toBeVisible({ timeout: 60_000 })
    await drop(page, 'calibration-cube-20mm.sx3mf')
    await expect(page.locator('.obj-name', { hasText: '20 mm calibration cube' })).toBeVisible({ timeout: 60_000 })

    await against(page, '20 mm calibration cube', 'Temperature tower')
    const notes = page.locator('.obj-note')
    await expect(notes).toHaveCount(2, { timeout: 30_000 })
    await expect(notes.nth(0)).toContainText('Touches 20 mm calibration cube, so they will print as one piece')
    await expect(notes.nth(1)).toContainText('Touches Temperature tower, so they will print as one piece')
    await expect(page.getByText(/touch, so they will print as one piece/)).toHaveCount(0)
    await expect.poll(() => lines(page)).toEqual([true])

    // Show which lists the other object.
    await notes.nth(1).getByRole('button', { name: 'Show which' }).click()
    await expect(notes.nth(1).locator('.obj-note-which li')).toHaveText(['Temperature tower, touching'])

    // Drag the cube away: the marker hides with the first move, before the drop.
    const c = await box(page, '20 mm calibration cube')
    const at = await aim(page, (c.min[0]! + c.max[0]!) / 2, (c.min[1]! + c.max[1]!) / 2, c.max[2]! / 2)
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    for (let i = 1; i <= 8; i++) await page.mouse.move(at.x + i * 6, at.y + i * 3)
    await expect.poll(() => lines(page)).toEqual([false])
    await page.mouse.up()
    await expect(notes).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(() => lines(page)).toEqual([])
  })

  test('a toast over the view lets a press through to the canvas, and its own button still works', { tag: '@gpu' }, async ({ page }) => {
    test.slow()
    await openStarter(page, 'calibration-cube-20mm.sx3mf')
    await expect(page.locator('.obj-name', { hasText: '20 mm calibration cube' })).toBeVisible({ timeout: 60_000 })
    const c = await box(page, '20 mm calibration cube')
    const at = await aim(page, (c.min[0]! + c.max[0]!) / 2, (c.min[1]! + c.max[1]!) / 2, c.max[2]! / 2)
    // A toast with a button, put right over the spot to press.
    await page.evaluate(() => {
      const w = window as unknown as { __sx: Sx; __urxxRan?: boolean }
      w.__urxxRan = false
      w.__sx.setState({ toast: { id: 9001, text: 'Something to read, right over the spot to press', action: { label: 'Dismiss', run: () => (w.__urxxRan = true) } } })
    })
    const toast = page.locator('.sx-toast', { hasText: 'Something to read' })
    await expect(toast).toBeVisible()
    // Slide it over the spot once its entrance is over (it animates its own transform).
    await toast.evaluate((el, [x, y]) => {
      return Promise.all(el.getAnimations().map((a) => a.finished)).then(() => {
        const r = el.getBoundingClientRect()
        ;(el as HTMLElement).style.transform = `translate(${x! - (r.left + r.width / 2)}px, ${y! - (r.top + r.height / 2)}px)`
      })
    }, [at.x, at.y] as const)
    const t = (await toast.boundingBox())!
    expect(at.x > t.x && at.x < t.x + t.width && at.y > t.y && at.y < t.y + t.height, 'the toast is over the spot').toBe(true)
    // A press there reaches the canvas, as the nightly's press did not when a toast sat on the spot.
    expect(await onCanvas(page, at.x, at.y)).toBe(true)
    // The toast's button takes a press of its own.
    await toast.getByTestId('toast-action').click()
    expect(await page.evaluate(() => (window as unknown as { __urxxRan?: boolean }).__urxxRan)).toBe(true)
  })

  test('every starter opens alone, with no notes and no markers', { tag: '@gpu' }, async ({ page }) => {
    test.slow()
    const plate = () => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate.map((p) => p.name))
    const titles = new Map((JSON.parse(readFileSync(join(starters(), 'manifest.json'), 'utf8')) as { listings: { slug: string; title: string }[] }).listings.map((l) => [l.slug, l.title]))
    for (const slug of STARTERS) {
      await openStarter(page, `${slug}.sx3mf`)
      await expect.poll(plate, { timeout: 60_000 }).toEqual([titles.get(slug)])
      // The check runs a moment after the plate changes.
      await page.waitForTimeout(2500)
      await expect(page.locator('.obj-note'), slug).toHaveCount(0)
      expect(await lines(page), slug).toEqual([])
    }
  })

  test('a design whose parts do not touch gets one note, Show which names them, and its marker follows a drag', { tag: '@gpu' }, async ({ page }) => {
    test.slow()
    await openFixture(page, 'loose-clip.sx3mf')
    await expect(page.locator('.obj-name')).toHaveText(['Cable clip'], { timeout: 60_000 })
    const note = page.locator('.obj-note')
    await expect(note).toHaveCount(1, { timeout: 30_000 })
    await expect(note).toContainText(/Clip and Foot are 0\.\d\d mm apart and do not touch, so they print as separate pieces/)
    await note.getByRole('button', { name: 'Show which' }).click()
    await expect(note.locator('.obj-note-which li')).toHaveText([/^Clip and Foot, 0\.\d\d mm$/])
    await expect.poll(() => lines(page)).toEqual([true])

    // Drag the clip: the marker moves with it, from the first move on.
    const where = () =>
      page.evaluate(() => {
        const vp = (window as unknown as { __vp: FitVp }).__vp
        // By its id: the view can also hold the prime tower once the plate is sliced.
        const id = (window as unknown as { __sx: Sx }).__sx.getState().plate[0]!.id
        const o = vp.objects.get(id)!.group.matrixWorld.elements
        const m = vp.gaps.group.children[0]!.children[1]!.matrixWorld.elements
        return { object: [o[12]!, o[13]!, o[14]!], marker: [m[12]!, m[13]!, m[14]!] }
      })
    const before = await where()
    // Press on the foot's top face: the middle of the whole clip is the gap between its pieces.
    const foot = await page.evaluate(() => {
      const e = (window as unknown as { __sx: Sx }).__sx.getState().plate[0]!
      const part = e.parts.find((p) => (p as { name?: string }).name === 'Foot')!
      const m = e.transform
      const min = [Infinity, Infinity, Infinity]
      const max = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i + 2 < part.positions.length; i += 3) {
        const [x, y, z] = [part.positions[i]!, part.positions[i + 1]!, part.positions[i + 2]!]
        const w = [0, 1, 2].map((k) => m[k]! * x + m[k + 4]! * y + m[k + 8]! * z + m[k + 12]!)
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k]!, w[k]!)
          max[k] = Math.max(max[k]!, w[k]!)
        }
      }
      return { x: (min[0]! + max[0]!) / 2, y: (min[1]! + max[1]!) / 2, z: max[2]! }
    })
    // Aimed once the view is still (aim): a slice landing moves it, and the press can land on the bed beside the clip.
    const at = await aim(page, foot.x, foot.y, foot.z)
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    for (let i = 1; i <= 8; i++) await page.mouse.move(at.x + i * 6, at.y + i * 3)
    await expect.poll(async () => (await where()).object[0] !== before.object[0]).toBe(true)
    await expect
      .poll(async () => {
        const now = await where()
        return [0, 1, 2].every((k) => Math.abs(now.marker[k]! - before.marker[k]! - (now.object[k]! - before.object[k]!)) < 0.01)
      })
      .toBe(true)
    expect(await lines(page)).toEqual([true])
    await page.mouse.up()
    await expect(note).toHaveCount(1)
  })

  test('opening a design over unsaved work asks nothing, keeps it, and Reopen brings it back', { tag: '@gpu' }, async ({ page }) => {
    test.slow()
    await openStarter(page, 'cable-clip.sx3mf')
    await expect(page.locator('.obj-name', { hasText: 'Cable clip' })).toBeVisible({ timeout: 60_000 })
    // An edit: a second object added by a drop.
    await drop(page, 'calibration-cube-20mm.sx3mf')
    await expect(page.locator('.obj-name', { hasText: '20 mm calibration cube' })).toBeVisible({ timeout: 60_000 })
    // The drop has finished, so the open below starts from a settled plate.
    await expect.poll(async () => (await store(page)).plateLoading, { timeout: 60_000 }).toBe(false)
    // A design adds to the plate where its file put it: both starters sit at the bed's center, so the cube overlaps the
    // clip and the fit check marks the two of them.
    await expect.poll(() => lines(page), { timeout: 30_000 }).toEqual([true])
    // The first open kept whatever the step before left unsaved, so its own note can still be under the printer card.
    // It is closed first, so the note found below is this open's.
    const saved = page.getByTestId('open-note').filter({ hasText: 'Your previous plate is saved.' })
    if (await saved.count()) await saved.getByTestId('open-note-dismiss').click()
    await expect(saved).toHaveCount(0, { timeout: 30_000 })
    // The clip as the desktop app opens it, from a file on disk that Save writes back to (the browser's files have no
    // path, so the step gives it one).
    const clipFile = { id: 'clip-file', name: 'cable-clip.sx3mf', size: 1, path: '/home/maker/cable-clip.sx3mf' }
    await setState(page, { projectFile: clipFile })
    await openFile(page, join(starters(), 'temperature-tower.sx3mf'))
    await expect(page.locator('.obj-name')).toHaveText(['Temperature tower'], { timeout: 60_000 })
    await expect(page.getByRole('dialog', { name: 'Save changes first?' })).toHaveCount(0)
    // The edited plate is a recent project now, with both objects.
    const kept = () =>
      page.evaluate(
        () =>
          new Promise<number[]>((resolve) => {
            const req = indexedDB.open('slicerx-projects')
            req.onsuccess = () => {
              const all = req.result.transaction('snapshots').objectStore('snapshots').getAll()
              all.onsuccess = () => resolve((all.result as { id: string; objects: number }[]).filter((r) => r.id.startsWith('recent:')).map((r) => r.objects))
              all.onerror = () => resolve([])
            }
            req.onerror = () => resolve([])
          }),
      )
    await expect.poll(kept, { timeout: 30_000 }).toContain(2)
    // The open's own note is replaced by the kept one once the open is done: wait for that note's own button.
    const reopen = saved.getByTestId('open-note-action')
    await expect(reopen).toHaveText('Reopen', { timeout: 30_000 })
    await expect(page.getByTestId('toast').filter({ hasText: 'Your previous plate is saved.' })).toHaveCount(0)
    // The old plate's fit mark goes with it: the tower alone has none.
    await page.waitForTimeout(2500)
    expect(await lines(page)).toEqual([])
    await reopen.click()
    await expect(page.locator('.obj-name')).toHaveText(['Cable clip', '20 mm calibration cube'], { timeout: 60_000 })
    await expect.poll(async () => (await store(page)).plateLoading, { timeout: 60_000 }).toBe(false)
    // The plate was clean when Reopen ran, so it asks nothing either.
    await expect(page.getByRole('dialog', { name: 'Save changes first?' })).toHaveCount(0)
    // It comes back as it was kept, the cube still over the clip, so the fit check marks them again.
    await expect.poll(() => lines(page), { timeout: 30_000 }).toEqual([true])
    try {
      // Still the clip's file, the one Save writes to without asking for a name on the desktop, and the top bar names it.
      expect((await store(page)).projectFile).toEqual(clipFile)
      await expect(page.locator('.sx-projname')).toContainText('cable-clip')
      await expect(page.locator('.sx-projname')).toHaveAttribute('data-tip-title', clipFile.path)
      // And still unsaved: the autosave, written only for unsaved work, picks it up again with both objects.
      const autosave = () =>
        page.evaluate(
          () =>
            new Promise<number | null>((resolve) => {
              const req = indexedDB.open('slicerx-projects')
              req.onsuccess = () => {
                const one = req.result.transaction('snapshots').objectStore('snapshots').get('autosave')
                one.onsuccess = () => resolve((one.result as { objects: number } | undefined)?.objects ?? null)
                one.onerror = () => resolve(null)
              }
              req.onerror = () => resolve(null)
            }),
        )
      await expect.poll(autosave, { timeout: 30_000 }).toBe(2)
    } finally {
      await setState(page, { projectFile: null })
    }
  })

  test('moving an object does not rebuild the scene, with a prime tower on the plate', { tag: '@gpu' }, async ({ page }) => {
    test.slow()
    await examplePlate(page)
    const was = (await store(page)).printerId
    try {
      // A printer with a filament unit, so the two color X gets a prime tower.
      await page.getByTestId('slice-machine-printer').click()
      await page.getByRole('list', { name: 'Choose a printer' }).getByRole('button', { name: /Bay 2/ }).click()
      const sliceId = () => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().slice.result?.id ?? null)
      const done = () => page.evaluate(() => { const s = (window as unknown as { __sx: Sx }).__sx.getState().slice; return s.status === 'done' && !s.stale })
      await expect.poll(done, { timeout: 120_000 }).toBe(true)
      const before = await sliceId()
      expect(await page.evaluate(() => Boolean((window as unknown as { __sx: Sx }).__sx.getState().slice.result?.primeTower))).toBe(true)
      await page.evaluate(() => {
        const w = window as unknown as { __vp: FitVp; __rebuilds: number }
        w.__rebuilds = 0
        const setPlate = w.__vp.setPlate.bind(w.__vp)
        w.__vp.setPlate = (...a: unknown[]) => {
          w.__rebuilds++
          setPlate(...a)
        }
      })
      const x = await box(page, 'Layered X')
      const at = await screen(page, (x.min[0]! + x.max[0]!) / 2, (x.min[1]! + x.max[1]!) / 2, x.max[2]! / 2)
      await page.mouse.move(at.x, at.y)
      await page.mouse.down()
      for (let i = 1; i <= 8; i++) await page.mouse.move(at.x - i * 5, at.y + i * 2)
      await page.mouse.up()
      await expect.poll(async () => (await box(page, 'Layered X')).min[0]).not.toBe(x.min[0])
      // The plate slices again on its own (a new slice, current); the tower stays drawn meanwhile and moves without a rebuild.
      await expect.poll(() => page.evaluate((b) => { const s = (window as unknown as { __sx: Sx }).__sx.getState().slice; return s.status === 'done' && !s.stale && s.result?.id !== b }, before), { timeout: 120_000 }).toBe(true)
      expect(await page.evaluate(() => (window as unknown as { __rebuilds: number }).__rebuilds)).toBe(0)
    } finally {
      await setState(page, { printerId: was })
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Arrange with more objects than the bed holds
// ---------------------------------------------------------------------------------------------------------------------

/** An A1 project of `n` cubes of `size` mm in a start grid of `cols` columns, `pitch` mm apart from `x0`, `y0`. */
function cubesProject(n: number, size: number, cols: number, pitch: number, x0: number, y0: number, sequence: 'by object' | 'by layer'): Buffer {
  const at = (i: number) => [x0 + (i % cols) * pitch, y0 + Math.floor(i / cols) * pitch]
  const v = [[0, 0, 0], [size, 0, 0], [size, size, 0], [0, size, 0], [0, 0, size], [size, 0, size], [size, size, size], [0, size, size]]
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
  const mesh = `<mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${f.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`
  const ids = Array.from({ length: n }, (_, i) => i + 1)
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${ids.map((id) => `<object id="${id}" type="model">${mesh}</object>`).join('')}</resources><build>${ids.map((id) => `<item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${at(id - 1).join(' ')} 0" printable="1"/>`).join('')}</build></model>`
  const objects = ids.map((id) => `<object id="${id}"><metadata key="name" value="Cube ${id}"/><metadata key="extruder" value="1"/></object>`).join('')
  const plate = `<plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="Cubes"/><metadata key="locked" value="false"/>${ids.map((id) => `<model_instance><metadata key="object_id" value="${id}"/><metadata key="instance_id" value="0"/></model_instance>`).join('')}</plate>`
  const settings = { printer_settings_id: 'Bambu Lab A1 0.4 nozzle', printer_model: 'Bambu Lab A1', nozzle_diameter: ['0.4'], printable_area: ['0x0', '256x0', '256x256', '0x256'], layer_height: '0.2', print_sequence: sequence, filament_colour: ['#00AE42'] }
  return zip({ '3D/3dmodel.model': model, 'Metadata/model_settings.config': `<?xml version="1.0" encoding="UTF-8"?><config>${objects}${plate}</config>`, 'Metadata/project_settings.config': JSON.stringify(settings) })
}

/**
 * Arrange all on an A1 with more cubes than the bed holds, by object (10 cubes of 20 mm, the 73 mm clearance) and by
 * layer (42 cubes of 30 mm): the cubes with no room move to Plate 2 and the toast says so, each plate slices with no
 * collision, and one undo puts the start grid back on one plate. Before, those cubes stayed in the start grid on top
 * of placed ones.
 */
test.describe('arrange with more objects than the bed holds', () => {
  type Unplaced = {
    getState(): {
      plate: { id: string; transform: number[] }[]
      plates: { id: string; name: string; objects: { id: string }[] }[]
      activePlate: string
      toast: { text: string } | null
      slice: { status: string; stale?: boolean; result?: { collisions?: { kind: string }[] } }
    }
  }
  const state = (page: Page) => page.evaluate(() => {
    const s = (window as unknown as { __sx: Unplaced }).__sx.getState()
    return { plate: s.plate.map((e) => ({ id: e.id, at: [e.transform[12], e.transform[13]] })), plates: s.plates.map((p) => ({ name: p.name, count: p.id === s.activePlate ? s.plate.length : p.objects.length })), toast: s.toast?.text ?? null, slice: s.slice.status === 'done' && !s.slice.stale ? (s.slice.result?.collisions ?? []).map((c) => c.kind) : null }
  })

  // On a hosted runner the reply to one read can be lost: the read ran in the page and the app had the right state, but
  // the answer never reached the test, and expect.poll waited on that one sample until its timeout. Inside a poll each
  // read is bounded: a read with no answer in 2 s gives no value, which the matcher refuses, so the poll reads again
  // (a throw would end the poll at once). Single reads keep no bound, since a slow page there is slow, not wrong.
  const LOST = 'No answer from the page to a state read within 2 s'
  async function sample<T>(page: Page, pick: (s: Awaited<ReturnType<typeof state>>) => T): Promise<T | undefined> {
    const s = await within(state(page), 2_000, LOST).catch((e: unknown) => {
      if (e instanceof Error && e.message === LOST) return undefined
      throw e
    })
    return s === undefined ? undefined : pick(s)
  }

  async function sliceShown(page: Page): Promise<string[]> {
    await page.getByRole('button', { name: /^Slice plate/ }).first().click()
    await expect.poll(() => sample(page, (s) => s.slice !== null), { timeout: 150_000 }).toBe(true)
    return (await state(page)).slice!
  }

  for (const c of [
    { name: 'by object, 10 cubes of 20 mm', n: 10, size: 20, cols: 5, pitch: 30, x0: 63, y0: 103, sequence: 'by object' as const },
    { name: 'by layer, 42 cubes of 30 mm', n: 42, size: 30, cols: 7, pitch: 34, x0: 10, y0: 10, sequence: 'by layer' as const },
  ]) {
    test(`${c.name}: the cubes with no room move to Plate 2, each plate slices clean, and one undo puts them back`, async ({ page }) => {
      test.setTimeout(300_000)
      interceptFileDialogs(page)
      await page.addInitScript(() => {
        localStorage.setItem('slicerx.debug', '1')
        if (sessionStorage.getItem('sx-e2e')) return
        sessionStorage.setItem('sx-e2e', '1')
        localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, autoSlice: false }))
      })
      await page.goto('./')
      await plateReady(page)
      const chooser = await expectFileDialog(page, () => page.keyboard.press('ControlOrMeta+o'))
      await chooser.setFiles({ name: 'Cubes.3mf', mimeType: 'model/3mf', buffer: cubesProject(c.n, c.size, c.cols, c.pitch, c.x0, c.y0, c.sequence) })
      await expect.poll(() => sample(page, (s) => s.plate.length), { timeout: 60_000 }).toBe(c.n)
      const before = await state(page)
      await page.getByRole('toolbar', { name: 'Plate tools' }).getByRole('button', { name: 'Arrange all' }).click()
      await expect.poll(() => sample(page, (s) => s.plates.length), { timeout: 120_000 }).toBe(2)
      const after = await state(page)
      const moved = after.plates[1]!.count
      expect(moved).toBeGreaterThan(0)
      expect(after.plates[0]!.count + moved).toBe(c.n)
      expect(after.plates[1]!.name).toBe('Plate 2')
      expect(after.toast).toBe(moved === 1 ? '1 object did not fit, so it moved to Plate 2.' : `${moved} objects did not fit, so they moved to Plate 2.`)
      await expect(page.getByText(after.toast!)).toBeVisible()
      // Plate 1 stays shown. The notice stays past its reading time, until dismissed, and Show opens Plate 2.
      await expect(page.getByTestId('plate-picker-current').locator('.pp-no')).toHaveText('Plate 1')
      const notice = page.getByTestId('toast').filter({ hasText: after.toast! })
      await page.waitForTimeout(6_000)
      await expect(notice).toBeVisible()
      await notice.getByTestId('toast-action').filter({ hasText: 'Show' }).click()
      await expect(page.getByTestId('plate-picker-current').locator('.pp-no')).toHaveText('Plate 2')
      await expect(notice).toHaveCount(0)
      await pickPlate(page, 1)
      // Plate 1 slices with no collision, and so does Plate 2.
      expect(await sliceShown(page)).toEqual([])
      await pickPlate(page, 2)
      expect((await state(page)).plate).toHaveLength(moved)
      expect(await sliceShown(page)).toEqual([])
      await pickPlate(page, 1)
      // One undo: the start grid on one plate again.
      await page.keyboard.press('ControlOrMeta+z')
      await expect.poll(() => sample(page, (s) => s.plates.length)).toBe(1)
      expect((await state(page)).plate).toEqual(before.plate)
    })
  }
})
