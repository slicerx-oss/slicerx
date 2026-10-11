// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The selection in Slice: Shift ranges and Mod toggles in the object list, Esc to clear, the selection bar under the
// list with its actions and menu, the same items in the context menus on a row and in the view, and Transform's popover.
import { type Page } from '@playwright/test'
import { closeSheet, expect, openSheet, openTransform, plateReady, test } from './fixtures'

type Sx = { getState(): { selection: string | null; selectedIds: string[]; plate: { id: string; printable?: boolean; locked?: boolean }[] } }
const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())

async function open(page: Page, mode: 'simple' | 'advanced' = 'simple'): Promise<void> {
  await page.addInitScript((m) => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: m, printerId: 'bay-1', pilot: { mode: 'off' }, cadTools: true }))
  }, mode)
  await page.goto('./')
  await plateReady(page)
  await openSheet(page)
}

const rows = (page: Page) => page.getByTestId('object-row')
const bar = (page: Page) => page.getByTestId('slice-selection-bar')
const select = (page: Page, i: number, modifiers: ('Shift' | 'ControlOrMeta')[] = []) => rows(page).nth(i).getByTestId('object-select').click({ modifiers })

/** Three objects on the plate, the first one selected. */
async function three(page: Page): Promise<void> {
  await select(page, 0)
  await page.keyboard.press('ControlOrMeta+d')
  await expect(rows(page)).toHaveCount(2)
  await select(page, 0)
  await page.keyboard.press('ControlOrMeta+d')
  await expect(rows(page)).toHaveCount(3)
}

test('Shift selects a range, Mod toggles, and Esc clears the selection and hides the bar', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modifier keys need a keyboard')
  await open(page)
  await three(page)
  await select(page, 0)
  await expect(page.getByTestId('slice-selection-count')).toHaveText('1 selected')
  await select(page, 2, ['Shift'])
  await expect(page.getByTestId('slice-selection-count')).toHaveText('3 selected')
  await select(page, 1, ['ControlOrMeta'])
  await expect(page.getByTestId('slice-selection-count')).toHaveText('2 selected')
  // A range starts from the last plain or Mod click.
  await select(page, 0, ['Shift'])
  await expect(page.getByTestId('slice-selection-count')).toHaveText('2 selected')
  expect((await state(page)).selectedIds).toHaveLength(2)
  await page.mouse.move(5, 5)
  await page.keyboard.press('Escape')
  await expect(bar(page)).toHaveCount(0)
  expect((await state(page)).selection).toBeNull()
  // Simple's Actions menu does the same.
  await select(page, 1)
  await page.getByTestId('slice-selection-more').click()
  await page.getByTestId('slice-ctx-clear').click()
  await expect(bar(page)).toHaveCount(0)
})

test('Simple keeps the bar to its count and its menu, with every verb and Clear selection in the menu', async ({ page }) => {
  await open(page)
  await select(page, 0)
  await expect(bar(page).getByRole('button')).toHaveCount(1)
  await page.getByTestId('slice-selection-more').click()
  const menu = page.getByTestId('slice-selection-menu')
  await expect(menu.getByRole('menuitem')).toHaveText(['Skip', 'Lock', 'Arrange', 'Transform', 'Center', 'Drop to bed', /^Duplicate/, 'Volumes', /^Clear selection/, /^Delete/])
  await menu.getByTestId('slice-ctx-skip').click()
  expect((await state(page)).plate[0]!.printable).toBe(false)
  // The object's volumes, Simple's More for it.
  await page.getByTestId('slice-selection-more').click()
  await menu.getByTestId('slice-ctx-more').click()
  await page.getByTestId('slice-selection-more').click()
  await expect(menu.getByTestId('slice-ctx-more')).toHaveText('Hide volumes')
})

test('the bar skips, locks and deletes the selection, and Undo in the toast brings it back', async ({ page }) => {
  await open(page, 'advanced')
  await select(page, 0)
  await expect(bar(page)).toBeVisible()
  // One plate: no Move to plate.
  await expect(page.getByTestId('slice-selection-move-plate')).toHaveCount(0)
  const skip = page.getByTestId('slice-selection-skip')
  await expect(skip).toHaveAttribute('aria-label', 'Skip')
  await skip.click()
  await expect(skip).toHaveAttribute('aria-label', 'Print')
  expect((await state(page)).plate[0]!.printable).toBe(false)
  await skip.click()
  await expect(skip).toHaveAttribute('aria-label', 'Skip')
  const lock = page.getByTestId('slice-selection-lock')
  await lock.click()
  await expect(lock).toHaveAttribute('aria-label', 'Unlock')
  expect((await state(page)).plate[0]!.locked).toBe(true)
  await lock.click()
  await expect(lock).toHaveAttribute('aria-label', 'Lock')
  // Advanced has Arrange and Transform on the bar; the menu holds the rest, with Delete last.
  await page.getByTestId('slice-selection-more').click()
  const menu = page.getByTestId('slice-selection-menu')
  await expect(menu.getByRole('menuitem')).toHaveText(['Center', 'Drop to bed', /^Duplicate/, /^Delete/])
  await menu.getByTestId('danger-slice-ctx-delete').click()
  await expect(rows(page)).toHaveCount(0)
  const toast = page.locator('.sx-toast', { hasText: 'Deleted Layered X.' })
  await expect(toast).toBeVisible()
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(rows(page)).toHaveCount(1)
})

test('Advanced shows Arrange and Transform on the bar, and Transform opens the number rows in a popover', async ({ page }) => {
  await open(page, 'advanced')
  await select(page, 0)
  await expect(page.getByTestId('slice-selection-arrange')).toBeVisible()
  // The number rows live in the popover now, not under the list.
  await expect(page.locator('[data-section="objects"] [data-section="transform"]')).toHaveCount(0)
  // Opening it moves nothing in the pane: its first field takes focus without scrolling the pane.
  const card = page.locator('[data-section="objects"]')
  const before = (await card.boundingBox())!.y
  await openTransform(page)
  const pop = page.locator('.selbar-transform')
  await expect(pop.locator(':focus')).toHaveCount(1)
  expect(Math.abs((await card.boundingBox())!.y - before)).toBeLessThanOrEqual(0.5)
  await expect(pop.getByRole('group', { name: 'Position' })).toBeVisible()
  await expect(pop.getByRole('group', { name: 'Size' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(pop).toHaveCount(0)
  // Esc closed the popover, not the selection.
  await expect(bar(page)).toBeVisible()
})

test('a row\'s context menu opens by keyboard, selects the row first, and has the bar\'s items', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Shift+F10 needs a keyboard')
  await open(page)
  await three(page)
  await select(page, 0)
  await rows(page).nth(2).getByTestId('object-select').focus()
  await page.keyboard.press('Shift+F10')
  const ctx = page.getByTestId('slice-ctx')
  await expect(ctx).toBeVisible()
  expect((await state(page)).selection).toBe(await rows(page).nth(2).getAttribute('data-object-id'))
  await expect(ctx.getByRole('menuitem')).toHaveText(['Arrange', 'Transform', 'Skip', 'Lock', 'Center', 'Drop to bed', /^Duplicate/, /^Delete/])
  await ctx.getByTestId('slice-ctx-duplicate').click()
  await expect(rows(page)).toHaveCount(4)
})

test('a right click on an object in the view opens the same menu there', async ({ page, isMobile }) => {
  test.skip(isMobile, 'A right click needs a mouse')
  await open(page)
  await select(page, 0)
  // Frame the object so the middle of the view is on it.
  await page.mouse.move(700, 450)
  await page.keyboard.press('z')
  await page.waitForTimeout(600)
  const box = (await page.locator('.vp-canvas').first().boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  const ctx = page.getByTestId('slice-ctx')
  await expect(ctx).toBeVisible()
  await ctx.getByTestId('slice-ctx-skip').click()
  expect((await state(page)).plate[0]!.printable).toBe(false)
})

test('on a phone the bar fits the sheet', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Phone only')
  await open(page, 'advanced')
  await select(page, 0)
  await expect(bar(page)).toBeVisible()
  const b = (await bar(page).boundingBox())!
  expect(b.x).toBeGreaterThanOrEqual(0)
  expect(b.x + b.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  await page.getByTestId('slice-selection-skip').click()
  await expect(page.getByTestId('slice-selection-skip')).toHaveAttribute('aria-label', 'Print')
  await closeSheet(page)
})
