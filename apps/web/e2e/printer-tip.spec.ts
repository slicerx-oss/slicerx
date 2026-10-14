// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The printer button's tip in the Slice sidebar: it opens below the machine card, never over the viewport toolbar
// (design spec 8, Motion and stability), shows on hover and on Tab, and does not come back when the keyboard closes
// the printer popover and focus returns to the button.
import { expect, openSheet, plateReady, test } from './fixtures'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  await openSheet(page)
  await expect(page.getByTestId('slice-machine-card')).toBeVisible()
})

const tip = (page: import('@playwright/test').Page) => page.locator('.sx-tip[data-ready]')

// A tip that opens while another is showing (warm) slides from the old spot to the new one over 120 ms, so a position
// read right after it shows can still be the previous control's. The position is polled until the slide ends.
const tipBelowCard = (page: import('@playwright/test').Page) =>
  expect
    .poll(async () => {
      const t = await tip(page).boundingBox()
      const card = await page.getByTestId('slice-machine-card').boundingBox()
      return t && card ? t.y - (card.y + card.height) : -1
    })
    .toBeGreaterThanOrEqual(0)

test('the tip shows on hover, below the card and clear of the plate toolbar', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'hover tips are a desktop pointer feature')
  await page.getByTestId('slice-machine-printer').hover()
  await expect(tip(page)).toContainText('Pick another printer, or add one.')
  await tipBelowCard(page)
  const t = (await tip(page).boundingBox())!
  const bar = await page.locator('.plate-tools').boundingBox()
  if (bar) expect(t.y >= bar.y + bar.height || t.x + t.width <= bar.x || t.x >= bar.x + bar.width).toBe(true)
})

test('the tip shows when Tab focuses the button, below the card', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'Tab focus tips are a desktop keyboard feature')
  const printer = page.getByTestId('slice-machine-printer')
  await page.mouse.move(700, 500)
  for (let i = 0; i < 40 && !(await printer.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(printer).toBeFocused()
  await expect(tip(page)).toContainText('Pick another printer, or add one.')
  await tipBelowCard(page)
})

test('closing the printer popover with the keyboard does not bring the tip back', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'keyboard flow')
  const printer = page.getByTestId('slice-machine-printer')
  await page.mouse.move(700, 500)
  await printer.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('slice-machine-printer-add')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('slice-machine-printer-add')).toHaveCount(0)
  await expect(printer).toBeFocused()
  await page.waitForTimeout(900)
  await expect(tip(page)).toHaveCount(0)
})
