// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate picker at the foot of Slice's view: the previous plate, the plate in view and the next, in one row of fixed
// widths with 1, 3 or 27 plates. The plate opens a sheet of every plate with a search and a Not sliced filter.
// Shift+[ and Shift+] step through the plates ([ and ] alone stay the side panels). Names are cut in the middle with the
// full name in the tooltip, nothing moves as plates or slices change, and the floating toolbar keeps its own lane at the
// top: the picker never reaches it, and neither does the open sheet.
import type { Locator, Page } from '@playwright/test'
import { expect, plateReady, sliceCount, sliced, test, viewSized } from './fixtures'
import { DECK_BOX_27, SMALL_3, addPlateFromPicker, openPlateProject, plateSheet, shutPlateSheet } from './plate-project'

type Box = { x: number; y: number; width: number; height: number }
type Sx = { getState(): { plates: { id: string; name: string }[]; activePlate: string } }

const shown = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as { __sx: Sx }).__sx.getState()
  return s.plates.findIndex((p) => p.id === s.activePlate) + 1
})
const picker = (page: Page) => page.getByTestId('plate-picker')
const current = (page: Page) => page.getByTestId('plate-picker-current')
const prev = (page: Page) => page.getByTestId('plate-picker-prev')
const next = (page: Page) => page.getByTestId('plate-picker-next')

/** The boxes of the picker's three controls, rounded, for checking that nothing moved. */
async function pickerBoxes(page: Page): Promise<Box[]> {
  const out: Box[] = []
  for (const l of [picker(page), prev(page), current(page), next(page)]) {
    const b = (await l.boundingBox())!
    out.push({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) })
  }
  return out
}

const apart = (a: Box, b: Box) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y

/** The picker is one row: one control tall, inside the view, and clear of the toolbar's lane at the top. */
async function oneRowClearOfLane(page: Page, also?: Locator): Promise<void> {
  const row = (await picker(page).boundingBox())!
  expect(row.height).toBeLessThanOrEqual(48)
  const vp = (await page.locator('.vp').boundingBox())!
  expect(row.x).toBeGreaterThanOrEqual(vp.x)
  expect(row.x + row.width).toBeLessThanOrEqual(vp.x + vp.width + 0.5)
  expect(row.y + row.height).toBeLessThanOrEqual(vp.y + vp.height + 0.5)
  const lane = page.locator('.plate-tools-group')
  if (await lane.count()) {
    const l = (await lane.boundingBox())!
    expect(apart(row, l), `picker ${JSON.stringify(row)} lane ${JSON.stringify(l)}`).toBe(true)
    if (also) {
      const s = (await also.boundingBox())!
      expect(apart(s, l), `sheet ${JSON.stringify(s)} lane ${JSON.stringify(l)}`).toBe(true)
      expect(s.y).toBeGreaterThanOrEqual(l.y + l.height)
    }
  }
}

test.describe('the plate picker', () => {
  test('one plate: Plate 1 of 1 with both steps off, and Add plate in the sheet moves nothing', async ({ page, isMobile }) => {
    await page.addInitScript(() => {
      localStorage.setItem('slicerx.debug', '1')
      if (sessionStorage.getItem('sx-e2e')) return
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
    })
    await page.goto('./')
    await plateReady(page)
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
    if (!isMobile) await oneRowClearOfLane(page, sheet)
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

  test('three plates: buttons and Shift+[ / Shift+] step and stop at the ends; [ alone stays the panel key', async ({ page, isMobile }) => {
    await openPlateProject(page, SMALL_3, [], { autoSlice: false })
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
    if (isMobile) return
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

  test('27 plates: one row, names cut in the middle with the full name in the tooltip, and nothing moves from first to last', async ({ page, isMobile }) => {
    await openPlateProject(page, DECK_BOX_27, [5, 12], { autoSlice: false })
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
    expect(await fits()).toBe(true)
    // Through every plate to the last: the controls keep their places, and each name fits its box.
    for (let i = 2; i <= 27; i++) {
      await next(page).click()
      await expect(current(page).locator('.pp-no')).toHaveText(`Plate ${i}`)
      expect(await fits(), `plate ${i}`).toBe(true)
      if (i % 9 === 0 || i === 27) expect(await pickerBoxes(page), `plate ${i}`).toEqual(before)
    }
    await expect(next(page)).toBeDisabled()
    await expect(name).toHaveAttribute('data-full', DECK_BOX_27[26]!)
    await oneRowClearOfLane(page)
    if (isMobile) return
    // The phone width test ends here; the desktop one checks 1280 by 800 as well.
    await page.setViewportSize({ width: 1280, height: 800 })
    await viewSized(page)
    await oneRowClearOfLane(page)
    const sheet = await plateSheet(page)
    await oneRowClearOfLane(page, sheet)
  })

  test('the sheet finds plates by name or number, and Not sliced leaves out sliced and empty plates', async ({ page, isMobile }) => {
    await openPlateProject(page, DECK_BOX_27, [5, 12], { autoSlice: false })
    await viewSized(page)
    const before = await pickerBoxes(page)
    const sheet = await plateSheet(page)
    if (!isMobile) await oneRowClearOfLane(page, sheet)
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
    expect(await pickerBoxes(page)).toEqual(before)
    const after = await plateSheet(page)
    await expect(after.locator('.pp-card').nth(26)).toHaveAttribute('data-state', 'sliced')
    await after.getByRole('radio', { name: 'Not sliced' }).click()
    await expect(after.locator('.pp-card')).toHaveCount(24)
    await after.getByRole('searchbox', { name: 'Find a plate' }).fill('coupon')
    await expect(after.locator('.pp-card')).toHaveCount(0)
    await expect(after.getByText('No plate matches.')).toBeVisible()
    await shutPlateSheet(page)
    expect(await pickerBoxes(page)).toEqual(before)
  })
})
