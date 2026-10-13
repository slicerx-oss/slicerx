// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The design timeline: every body's steps in one strip, and a marker that rolls the whole design back. Rolled back,
// Slice says it slices that state, with Move to the end beside it; undo brings the marker back.
import { test, expect } from './fixtures'
import { command, freshBox, height, openStudio, pushTop } from './cad-helpers'

type Sx = { __sx: { getState(): { plate: { id: string }[]; timeline: { marker: number; items: unknown[] } } } }
const ids = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as Sx).__sx.getState().plate.map((e) => e.id))
const marker = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as Sx).__sx.getState().timeline.marker)

test('the marker rolls every body back, Slice says so, and Move to the end and undo bring it back', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await openStudio(page)
  const a = await freshBox(page)
  await page.locator('.sx-tab[data-mode="design"]').click()
  await pushTop(page, a, 5)
  await command(page, 'Add a box')
  await expect.poll(async () => (await ids(page)).length).toBe(2)
  const b = (await ids(page)).find((x) => x !== a)!
  await pushTop(page, b, 3)
  await expect.poll(() => height(page, a)).toBeCloseTo(25, 3)
  await expect.poll(() => height(page, b)).toBeCloseTo(23, 3)

  await page.getByRole('button', { name: 'Open Timeline' }).click()
  const chips = page.locator('.tl-chip')
  await expect(chips).toHaveCount(2)
  await expect(chips.nth(0)).toHaveAttribute('aria-label', /Pull 5 mm, on Box/)
  await expect(chips.nth(1)).toHaveAttribute('aria-label', /Pull 3 mm, on Box/)

  // one back: the second box loses its pull, the first keeps its own
  await page.getByTestId('tl-marker').focus()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('tl-rolled')).toHaveText('Rolled back to 1 of 2')
  await expect.poll(() => height(page, b)).toBeCloseTo(20, 3)
  await expect.poll(() => height(page, a)).toBeCloseTo(25, 3)
  await expect(chips.nth(1)).toHaveAttribute('data-later', 'true')

  // Slice says what it slices
  await page.getByTestId('tab-prepare').click()
  const note = page.getByTestId('rolled-back')
  await expect(note).toContainText('The timeline is rolled back to step 1. Slicing uses this state.')
  await note.getByRole('button', { name: 'Move to the end' }).click()
  await expect(note).toHaveCount(0)
  await expect.poll(() => height(page, b)).toBeCloseTo(23, 3)

  // undo puts the marker back where it was, then back at the end
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => marker(page)).toBe(1)
  await expect.poll(() => height(page, b)).toBeCloseTo(20, 3)
  await expect(page.getByTestId('rolled-back')).toBeVisible()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => marker(page)).toBe(2)
  await expect.poll(() => height(page, b)).toBeCloseTo(23, 3)
})
