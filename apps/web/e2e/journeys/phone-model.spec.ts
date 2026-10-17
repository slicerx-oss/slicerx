// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's phone legs that are not in phone-responsive.spec.ts: Select Other held under a real finger and the plate
// picker on a phone. Two desktop checks of the same build sit here too: a desktop window keeps the ribbon with no phone
// bar, and the slow 3D notice is one short line. The phone bar, its sheets and sketch tools are in phone-responsive.
import { type CDPSession, type Page } from '@playwright/test'
import { closeSheet, expect, sliceCount, sliced, viewSized } from '../fixtures'
import { journey as test } from '../journey'
import { DECK_BOX_27, SMALL_3, addPlateFromPicker, plateSheet, shutPlateSheet } from '../plate-project'
import { current, examplePlate, fitView, next, oneRowClearOfLane, openPlates, pickerBoxes, prev, setState, shown, stackedSpot, twoBoxes, useFileDialogs, useFlags } from './lib/model'

// The model tests run in the browser build that models only (slicerx.e2e.cadOnly, read as the host starts); the plate
// picker's phone legs run in the full build. The flags in each describe are put in place before each of its tests.
const CAD_ONLY = { 'slicerx.e2e.cadOnly': '1' }
test.use({ journeyPrefs: { workspace: 'prepare', pilot: { mode: 'off' } } })
useFileDialogs(true)

type Entry = { id: string; transform: number[] }
type Sx = { getState(): { plate: Entry[]; selection: string | null; objectTool: string | null; subPicks: { kind: string; objectId: string }[]; timeline: { items: unknown[] } }; setState(p: unknown): void }

const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())

/** A step starts on an empty plate with no tool open and no sheet up. */
async function openModel(page: Page): Promise<void> {
  await setState(page, { plate: [], selection: null, selectedIds: [], subPicks: [], objectTool: null })
  await closeSheet(page)
}

/** Empties the plate and adds a box from the bar's Add menu, as a finger would. Returns its id, selected. */
async function addBox(page: Page): Promise<string> {
  await setState(page, { plate: [], selection: null, selectedIds: [] })
  await page.getByTestId('phone-add').tap()
  await page.getByRole('menu', { name: 'Add' }).getByRole('menuitem', { name: 'Box' }).first().tap()
  await expect.poll(async () => (await state(page)).plate.length).toBe(1)
  const id = (await state(page)).plate[0]!.id
  await setState(page, { selection: id, selectedIds: [id] })
  // Model frames a new part and then the selection, each an eased camera move: measure screen points once it stops
  await page.waitForFunction(() => (window as unknown as { __vp: { rig: { move: unknown } } }).__vp.rig.move === null)
  return id
}

/** One finger: down at `from`, through `to` in steps, then up; `hold` ms before moving. */
async function finger(cdp: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }, hold = 0, steps = 10): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] })
  if (hold) await new Promise((r) => setTimeout(r, hold))
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }] })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/**
 * Model's Select Other with a real finger: holding the pointer still on a spot opens a list of everything under it, with
 * 44 px rows, ending with More actions for the ring. Two boxes, one behind the other, put several things under one
 * spot. The mouse and keys are in model-viewport.spec.ts.
 */
test.describe('Select Other on a phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'Phone only')
  useFlags(CAD_ONLY, true)

  /** One finger: down, held for `ms`, then up where it went down. */
  async function hold(cdp: CDPSession, at: { x: number; y: number }, ms: number): Promise<void> {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] })
    await new Promise((r) => setTimeout(r, ms))
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }

  test('a finger held still opens the list with 44 px rows; a row picks it, More actions opens the ring', async ({ page }) => {
    test.slow()
    await openModel(page)
    const list = page.getByTestId('select-other')
    const rows = page.getByTestId('select-other-row')
    const addBox = async () => {
      await page.getByTestId('phone-add').tap()
      await page.getByRole('menu', { name: 'Add' }).getByRole('menuitem', { name: 'Box' }).first().tap()
    }
    await addBox()
    await expect.poll(async () => (await state(page)).plate.length).toBe(1)
    const { front, back } = await twoBoxes(page, addBox)
    await fitView(page, [front, back], false)
    const spot = await stackedSpot(page, front, back)
    const cdp = await page.context().newCDPSession(page)
    try {
      await hold(cdp, spot, 800)
      await expect(list).toBeVisible()
      await expect.poll(() => rows.count()).toBe(4)
      for (const h of await rows.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44)
      const more = page.getByTestId('select-other-more')
      expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      // the held finger picked nothing; a row does
      expect((await state(page)).subPicks).toEqual([])
      await rows.nth(1).tap()
      await expect(list).toBeHidden()
      await expect.poll(async () => (await state(page)).subPicks.map((p) => `${p.kind} ${p.objectId}`)).toEqual([`face ${back}`])
      // More actions: the ring a held finger opened before
      await hold(cdp, spot, 800)
      await expect(list).toBeVisible()
      await more.tap()
      await expect(list).toBeHidden()
      await expect(page.getByTestId('model-ring')).toBeVisible()
    } finally {
      await cdp.detach()
    }
  })
})

test.describe('a desktop window', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop only')
  useFlags(CAD_ONLY)

  test('a desktop window keeps the ribbon and has no phone bar', async ({ page }) => {
    await openModel(page)
    await expect(page.getByTestId('model-shelf')).toHaveCount(1)
    await expect(page.locator('.pbar')).toHaveCount(0)
    await expect(page.getByTestId('phone-handles')).toHaveCount(0)
  })

  test('on a desktop the slow 3D notice is one short line, with the reason behind Details', async ({ page }) => {
    await openModel(page)
    const reason = 'Hardware acceleration looks off in this browser. Turn it on in the browser settings and reload.'
    await page.evaluate((r) => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('degrade', { message: 'The 3D view will be slow here.', details: r }), reason)
    const toast = page.getByTestId('toast').filter({ hasText: 'The 3D view will be slow here.' }).last()
    await expect(toast.locator('.sx-toast-lead')).toHaveText('The 3D view will be slow here.')
    await expect(toast.locator('.sx-toast-more')).toBeHidden()
    await toast.getByTestId('toast-details').click()
    await expect(toast.getByTestId('toast-details')).toHaveAttribute('aria-expanded', 'true')
    await expect(toast.locator('.sx-toast-more')).toBeVisible()
    await expect(toast.locator('.sx-toast-more')).toHaveText(reason)
  })
})

/**
 * The plate picker at a phone's width, in the full build: one row with 1, 3 or 27 plates, the sheet of every plate with
 * its search and Not sliced filter, and nothing moves as plates or slices change. The keys and the 1280 wide check
 * are in plates.spec.ts.
 */
test.describe('the plate picker on a phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'Phone only')
  useFlags({ 'slicerx.e2e.cadOnly': null }, true)
  test.beforeEach(async ({ page }) => {
    await setState(page, { settingsMode: 'advanced' })
  })

  test('one plate: Plate 1 of 1 with both steps off, and Add plate in the sheet moves nothing', async ({ page }) => {
    await examplePlate(page)
    await viewSized(page)
    await expect(current(page).locator('.pp-no')).toHaveText('Plate 1')
    await expect(current(page).locator('.pp-of')).toHaveText('of 1')
    await expect(prev(page)).toBeDisabled()
    await expect(next(page)).toBeDisabled()
    await oneRowClearOfLane(page)
    const before = await pickerBoxes(page)
    const sheet = await plateSheet(page)
    await expect(sheet.locator('.pp-card')).toHaveCount(1)
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

  test('three plates: the buttons step and stop at the ends', async ({ page }) => {
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
    for (let i = 2; i <= 27; i++) {
      await next(page).click()
      await expect(current(page).locator('.pp-no')).toHaveText(`Plate ${i}`)
      await expect.poll(fits, { message: `plate ${i}` }).toBe(true)
      if (i % 9 === 0 || i === 27) expect(await pickerBoxes(page), `plate ${i}`).toEqual(before)
    }
    await expect(next(page)).toBeDisabled()
    await expect(name).toHaveAttribute('data-full', DECK_BOX_27[26]!)
    await oneRowClearOfLane(page)
  })

  test('the sheet finds plates by name or number, and Not sliced leaves out sliced and empty plates', async ({ page }) => {
    await openPlates(page, DECK_BOX_27, [5, 12])
    await viewSized(page)
    const before = await pickerBoxes(page)
    const sheet = await plateSheet(page)
    const cards = sheet.locator('.pp-card')
    await expect(cards).toHaveCount(27)
    await expect(sheet.locator('.pp-card[aria-current="true"]')).toHaveCount(1)
    await expect(sheet.locator('.pp-card[data-state="empty"]')).toHaveCount(2)
    const search = sheet.getByRole('searchbox', { name: 'Find a plate' })
    await expect(search).toBeFocused()
    await search.fill('kart')
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).toHaveAttribute('data-tip-title', `Plate 19: ${DECK_BOX_27[18]}`)
    await search.fill('label plate')
    await expect(cards).toHaveCount(10)
    await search.fill('27')
    await expect(cards).toHaveCount(1)
    await search.press('Enter')
    await expect(sheet).toBeHidden()
    expect(await shown(page)).toBe(27)
    expect(await pickerBoxes(page)).toEqual(before)

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
})
