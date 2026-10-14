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
    if (isMobile) return
    // The phone width test ends here; the desktop one checks 1280 by 800 as well.
    await page.setViewportSize({ width: 1280, height: 800 })
    await viewSized(page)
    await oneRowClearOfLane(page)
    const sheet = await plateSheet(page)
    await oneRowClearOfLane(page, sheet)
  })

  test('every plate is reachable by Prev and Next, and by its card in the sheet', async ({ page }) => {
    await openPlateProject(page, DECK_BOX_27, [5, 12], { autoSlice: false })
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
    await openPlateProject(page, SMALL_3)
    await viewSized(page)
    type Store = { setState(p: { toast: { id: number; text: string; tone?: string } }): void }
    const post = (id: number, text: string) => page.evaluate(([i, t]) => (window as unknown as { __sx: Store }).__sx.setState({ toast: { id: i as number, text: t as string, tone: 'info' } }), [id, text] as const)
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
})

// Design spec 2, 4 and 8: the pill's controls are 34 px, the card has 16 px padding, a note wraps to two lines before
// Details takes over, and a warning stays until it is dismissed while information goes with the card's one timer.
test.describe('the toast card and the picker, to the spec', () => {
  type Store = { setState(p: { toast: { id: number; text: string; tone?: string } }): void }
  const post = (page: Page, id: number, text: string, tone = 'info') =>
    page.evaluate(([i, t, k]) => (window as unknown as { __sx: Store }).__sx.setState({ toast: { id: i as number, text: t as string, tone: k as string } }), [id, text, tone] as const)
  const textHeight = async (line: Locator) => (await line.locator('.sx-toast-text').boundingBox())!.height

  test('the pill controls are 34 px tall and the pill, the grid and the card carry the lift edge', async ({ page }) => {
    await openPlateProject(page, SMALL_3)
    await viewSized(page)
    for (const l of [prev(page), current(page), next(page)]) expect((await l.boundingBox())!.height).toBe(34)
    const shadow = (l: Locator) => l.evaluate((el) => getComputedStyle(el).boxShadow)
    const edge = /rgba\(255, 255, 255, 0\.07\) 0px 1px 0px 0px inset/
    expect(await shadow(picker(page))).toMatch(edge)
    await plateSheet(page)
    expect(await shadow(page.getByTestId('plate-sheet'))).toMatch(edge)
    await shutPlateSheet(page)
    await post(page, 9201, 'Lift edge check.')
    const card = page.getByTestId('toasts')
    await expect(card).toBeVisible()
    expect(await shadow(card)).toMatch(edge)
    const pad = await card.evaluate((el) => { const c = getComputedStyle(el); return [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft] })
    expect(pad).toEqual(['16px', '16px', '16px', '16px'])
  })

  test('a note wraps to two lines before Details takes over', async ({ page }) => {
    await openPlateProject(page, SMALL_3)
    await viewSized(page)
    const lines = page.getByTestId('toasts').getByTestId('toast')
    await post(page, 9211, 'Short wrap check.')
    const one = lines.filter({ hasText: 'Short wrap check.' })
    await expect(one).toHaveCount(1)
    const h1 = await textHeight(one)
    await expect(one.getByTestId('toast-details')).toHaveCount(0)
    // About 75 characters: two lines on a desktop card and on a phone's, and no Details.
    await post(page, 9212, 'The nozzle in this project is not the one the printer has, so check it first')
    const two = lines.filter({ hasText: 'The nozzle in this project' })
    await expect(two).toHaveCount(1)
    const h2 = await textHeight(two)
    expect(h2).toBeGreaterThan(h1 * 1.8)
    expect(h2).toBeLessThan(h1 * 2.3)
    await expect(two.getByTestId('toast-details')).toHaveCount(0)
    // A sentence of three or more lines stops at two, and Details opens the whole of it in place.
    await post(page, 9213, 'This note keeps going well past two lines on any card so that the sentence itself would hide its own ending if it were cut at two lines and nothing offered the rest of it')
    const long = lines.filter({ hasText: 'This note keeps going' })
    await expect(long).toHaveCount(1)
    expect(await textHeight(long)).toBeCloseTo(h2, 0)
    await long.getByTestId('toast-details').click()
    await expect(long).toHaveAttribute('data-expanded', '')
    expect(await textHeight(long)).toBeGreaterThan(h2 * 1.4)
  })

  test('a warning stays past the card timer until it is dismissed', async ({ page }) => {
    await openPlateProject(page, SMALL_3)
    await viewSized(page)
    const lines = page.getByTestId('toasts').getByTestId('toast')
    const info = lines.filter({ hasText: 'Timer check info.' })
    const warn = lines.filter({ hasText: 'The bed is smaller than the plate.' })
    await post(page, 9221, 'Timer check info.')
    await post(page, 9222, 'The bed is smaller than the plate.', 'warn')
    await expect(info).toHaveCount(1)
    await expect(warn).toHaveCount(1)
    // Information has no dismiss control, the warning has one.
    await expect(info.getByTestId('toast-dismiss')).toHaveCount(0)
    await expect(warn.getByTestId('toast-dismiss')).toHaveCount(1)
    // The card's one timer ends the information. The warning would have gone with it at its 6 s reading time.
    await expect(info).toHaveCount(0, { timeout: 20_000 })
    await page.waitForTimeout(8000)
    await expect(warn).toHaveCount(1)
    await warn.getByTestId('toast-dismiss').click()
    await expect(warn).toHaveCount(0)
  })

  test('an error stays past the card timer until it is dismissed', async ({ page }) => {
    await openPlateProject(page, SMALL_3)
    await viewSized(page)
    const lines = page.getByTestId('toasts').getByTestId('toast')
    const info = lines.filter({ hasText: 'Error timer info.' })
    const error = lines.filter({ hasText: 'Could not reach the printer.' })
    await post(page, 9231, 'Error timer info.')
    await post(page, 9232, 'Could not reach the printer.', 'error')
    await expect(error.getByTestId('toast-dismiss')).toHaveCount(1)
    await expect(info).toHaveCount(0, { timeout: 20_000 })
    await page.waitForTimeout(8000)
    await expect(error).toHaveCount(1)
    await error.getByTestId('toast-dismiss').click()
    await expect(error).toHaveCount(0)
  })
})
