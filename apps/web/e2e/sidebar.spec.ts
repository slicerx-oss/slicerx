// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Slice sidebar: printer, filament and print settings stand as separate panels, and printer and filament fold to a
// summary line that stays folded after a reload.
import { expect, openSheet, test } from './fixtures'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('slicerx.prefs.v1')) localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', printerId: 'bay-1', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
})

test('each section is its own panel with an icon in its header', async ({ page }) => {
  await page.goto('./')
  await openSheet(page)
  for (const id of ['printer', 'filament', 'settings']) {
    const sec = page.locator(`.pane-body > .sx-block[data-section="${id}"]`)
    await expect(sec).toBeVisible()
    await expect(sec.locator('.sx-block-h .sx-block-icon')).toHaveCount(1)
    const look = await sec.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { radius: parseFloat(cs.borderTopLeftRadius), border: cs.borderTopStyle }
    })
    expect(look.radius).toBeGreaterThan(0)
    expect(look.border).toBe('solid')
  }
  // The panels sit apart on the darker ground.
  const gap = await page.locator('.pane-body').evaluate((el) => parseFloat(getComputedStyle(el).rowGap))
  expect(gap).toBeGreaterThan(0)
})

test('Simple mode keeps the sections open with no fold', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', printerId: 'bay-1', settingsMode: 'simple', pilot: { mode: 'off' } })))
  await page.goto('./')
  await expect(page.locator('.sx-block[data-section="printer"] .printer')).toBeVisible()
  await expect(page.locator('#printer-fold, #filament-fold')).toHaveCount(0)
})

test('printer and filament fold to a summary line and stay folded', async ({ page }) => {
  await page.goto('./')
  await openSheet(page)
  const printer = page.locator('.sx-block[data-section="printer"]')
  await printer.getByRole('button', { name: 'Printer', exact: true }).click()
  await expect(printer).toHaveAttribute('data-collapsed', 'true')
  await expect(printer.locator('.sec-sum')).toContainText('mm')
  const filament = page.locator('.sx-block[data-section="filament"]')
  await filament.getByRole('button', { name: 'Filament', exact: true }).click()
  await expect(filament.locator('.sec-sum')).toContainText('used')
  await page.reload()
  await openSheet(page)
  await expect(page.locator('.sx-block[data-section="printer"]')).toHaveAttribute('data-collapsed', 'true')
  await page.locator('.sx-block[data-section="printer"]').getByRole('button', { name: 'Printer', exact: true }).click()
  await expect(page.locator('.sx-block[data-section="printer"] .printer')).toBeVisible()
})

test('the mode chip in the pane title changes the mode across the app and keeps it after a reload', async ({ page }) => {
  await page.goto('./')
  const chip = page.getByTestId('slice-mode-chip')
  await expect(chip).toHaveText('Advanced')
  // In the pane title, on one line with it.
  const head = page.locator('.pane .sx-rail-head').filter({ has: chip })
  await expect(head).toBeVisible()
  await expect(head.locator('.sx-rail-title')).toHaveText('Printer and settings')
  // Print settings no longer carries its own mode control.
  await expect(page.locator('.sx-block[data-section="settings"]').getByRole('radiogroup', { name: 'Settings mode' })).toHaveCount(0)
  await chip.click()
  const menu = page.getByRole('menu', { name: 'Settings mode' })
  await expect(menu.getByTestId('slice-mode-chip-simple')).toContainText('The few settings most prints need.')
  await expect(menu.getByTestId('slice-mode-chip-advanced')).toHaveAttribute('aria-checked', 'true')
  await menu.getByTestId('slice-mode-chip-simple').click()
  await expect(menu).toHaveCount(0)
  await expect(chip).toHaveText('Simple')
  // Simple keeps the sections open with no fold, and Expert settings go away.
  await expect(page.locator('#printer-fold, #filament-fold')).toHaveCount(0)
  await expect(page.locator('[data-section="expert"]')).toHaveCount(0)
  // By keyboard: open, move down to Expert, choose it.
  await chip.focus()
  await page.keyboard.press('Enter')
  await expect(menu.getByTestId('slice-mode-chip-simple')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(chip).toHaveText('Expert')
  await expect(page.locator('[data-section="expert"]')).toHaveCount(1)
  await page.reload()
  await expect(page.getByTestId('slice-mode-chip')).toHaveText('Expert')
  const prefs = JSON.parse((await page.evaluate(() => localStorage.getItem('slicerx.prefs.v1'))) ?? '{}') as { settingsMode?: string }
  expect(prefs.settingsMode).toBe('expert')
})

test('the Print settings header stays one line at the narrowest sidebar width', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop sidebar width')
  await page.addInitScript(() => localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', printerId: 'bay-1', settingsMode: 'simple', pilot: { mode: 'off' }, paneSizes: { 'slicerx:prepare-left': 288 } })))
  await page.goto('./')
  await expect(page.getByTestId('slice-mode-chip')).toBeVisible()
  const pane = await page.locator('.pane[data-side="left"]').boundingBox()
  expect(Math.round(pane!.width)).toBeLessThanOrEqual(290)
  const header = page.locator('.sx-block[data-section="settings"] .sx-block-h')
  const h = await header.evaluate((el) => el.getBoundingClientRect().height)
  expect(h).toBeLessThan(48)
  const head = await page.locator('.pane .sx-rail-head').first().evaluate((el) => el.getBoundingClientRect().height)
  expect(head).toBe(44)
})

// Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
test('shots: the mode chip in the pane title, closed and open, light and dark', async ({ page }, info) => {
  test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
  const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
  const width = page.viewportSize()?.width ?? 0
  await page.addInitScript(() => localStorage.setItem('slicerx.debug', '1'))
  await page.goto('./')
  const chip = page.getByTestId('slice-mode-chip')
  for (const scheme of ['light', 'dark'] as const) {
    await page.evaluate((s) => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ scheme: s, themeFollowsSystem: false, settingsMode: 'simple' }), scheme)
    await chip.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${dir}/mode-chip-${scheme}-${width}.png` })
    // The pane head close up: the title, the chip and the pane's edge tab.
    const head = page.locator('.pane .sx-rail-head').filter({ has: chip })
    const box = (await head.boundingBox())!
    await page.screenshot({ path: `${dir}/mode-chip-head-${scheme}-${width}.png`, clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(width - Math.max(0, box.x - 8), box.width + 48), height: box.height + 16 } })
    // The whole pane with its edge tab beside it.
    const tab = page.getByTestId('edge-tab-left')
    if (await tab.count()) {
      const pane = (await page.locator('.pane').filter({ has: chip }).boundingBox())!
      const t = (await tab.boundingBox())!
      const right = Math.min(width, Math.max(pane.x + pane.width, t.x + t.width) + 8)
      await page.screenshot({ path: `${dir}/mode-chip-pane-${scheme}-${width}.png`, clip: { x: pane.x, y: pane.y, width: right - pane.x, height: Math.max(box.height, t.y + t.height - pane.y) + 8 } })
    }
    await chip.click()
    await expect(page.getByRole('menu', { name: 'Settings mode' })).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${dir}/mode-chip-menu-${scheme}-${width}.png` })
    await page.keyboard.press('Escape')
  }
})
