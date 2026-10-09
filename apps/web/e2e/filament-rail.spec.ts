// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The filament rail in the Slice sidebar: hovering a slot picks its filament out in the viewport, Alt-click selects
// the objects on it, a slot that differs from the printer's carries a dot and a way back, the rail scrolls inside the
// card when it overflows, and it fits a phone.
import { type Page } from '@playwright/test'
import { expect, openSheet, plateReady, test } from './fixtures'

type Sx = { getState(): { selectedIds: string[]; plate: { id: string }[]; hoverSlot: number | null }; setState(p: unknown): void }
const sx = (page: Page, p: unknown) => page.evaluate((x) => (window as unknown as { __sx: Sx }).__sx.setState(x), p)

async function open(page: Page, prefs: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((p) => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', printerId: 'bay-1', pilot: { mode: 'off' }, ...p }))
  }, prefs)
  await page.goto('./')
  await plateReady(page)
  // On a phone the sidebar is a sheet.
  await openSheet(page)
  await expect(page.getByTestId('slice-filament-rail')).toBeVisible()
}

const slot = (page: Page, n: number) => page.locator(`[data-testid="slice-filament-slot"][data-slot="${n}"]`)

test('hovering or focusing a slot picks its filament out in the viewport, and leaving clears it', async ({ page, isMobile }) => {
  await open(page)
  const host = page.locator('.vp-stage')
  await expect(host).not.toHaveAttribute('data-highlight', /./)
  if (!isMobile) {
    await slot(page, 2).hover()
    await expect(host).toHaveAttribute('data-highlight', '2')
    await expect(page.getByTestId('slice-filament-slot-line')).toContainText(/^PLA /)
    await page.mouse.move(700, 450)
    await expect(host).not.toHaveAttribute('data-highlight', /./)
  }
  await slot(page, 1).focus()
  await expect(host).toHaveAttribute('data-highlight', '1')
  await slot(page, 1).blur()
  await expect(host).not.toHaveAttribute('data-highlight', /./)
})

test('Alt-click selects every object on that filament and says so', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Alt needs a keyboard')
  await open(page)
  await sx(page, { selection: null, selectedIds: [] })
  await slot(page, 1).click({ modifiers: ['Alt'] })
  await expect(page.getByTestId('toast').filter({ hasText: /^Selected 1 object on PLA / })).toBeVisible()
  const picked = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().selectedIds)
  expect(picked).toHaveLength(1)
  // A plain click edits the slot.
  await slot(page, 1).click()
  await expect(page.getByRole('dialog', { name: /Filament 1/ })).toBeVisible()
})

test('a slot set to another filament than the printer holds shows a dot, says why, and goes back to the printer', async ({ page }) => {
  await open(page)
  await sx(page, { slotSetup: { 1: { type: 'PETG', brand: '', color: '#ffffff' } } })
  await expect(slot(page, 1)).toHaveAttribute('data-mismatch', 'true')
  await expect(slot(page, 1)).toHaveAttribute('data-tip-body', /^The printer has \w+ \w+ in slot 1\. The project uses PETG White\.$/)
  await slot(page, 1).focus()
  const fix = page.getByTestId('slice-filament-slot-line').getByTestId('slice-filament-use-printer')
  await expect(fix).toHaveText("Use printer's filament")
  await fix.click()
  await expect(slot(page, 1)).not.toHaveAttribute('data-mismatch', 'true')
})

test('the context menu offers the printer filament, by mouse and by keyboard', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Context menu by mouse and keys')
  await open(page)
  await sx(page, { slotSetup: { 2: { type: 'PETG', brand: '', color: '#ffffff' } } })
  await slot(page, 2).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Filament slot' })
  await expect(menu.getByTestId('slice-filament-use-printer')).toBeVisible()
  await page.keyboard.press('Escape')
  await slot(page, 2).focus()
  await page.keyboard.press('Shift+F10')
  await expect(menu).toBeVisible()
  await menu.getByTestId('slice-filament-use-printer').click()
  await expect(slot(page, 2)).not.toHaveAttribute('data-mismatch', 'true')
})

test('the menu holds Calibrate, Flush volumes, Swap colors, Reset to printer and Show unused slots', async ({ page }) => {
  await open(page)
  const all = await page.getByTestId('slice-filament-slot').count()
  await page.getByTestId('slice-filament-menu').click()
  await expect(page.getByTestId('slice-filament-calibrate')).toBeVisible()
  await expect(page.getByTestId('slice-filament-flush')).toBeVisible()
  await expect(page.getByTestId('slice-filament-swap')).toBeVisible()
  // Nothing edited: no reset.
  await expect(page.getByTestId('slice-filament-reset')).toHaveCount(0)
  await page.getByRole('menuitemcheckbox', { name: 'Show unused slots' }).click()
  await expect.poll(() => page.getByTestId('slice-filament-slot').count()).toBeGreaterThan(all)
  await expect(page.locator('[data-testid="slice-filament-slot"][data-used="false"]').first()).toBeVisible()
})

test('Swap colors opens from the menu and swaps the two filaments on the plate', async ({ page }) => {
  await open(page)
  await page.getByTestId('slice-filament-menu').click()
  await page.getByTestId('slice-filament-swap').click()
  const swap = page.getByRole('group', { name: 'Swap colors on this plate' })
  await expect(swap).toBeVisible()
  await swap.getByRole('button', { name: 'Swap', exact: true }).click()
  await expect(swap).toContainText('prints as')
  await swap.getByRole('button', { name: 'Undo swaps' }).click()
  await expect(swap).not.toContainText('prints as')
})

test('a full rail scrolls inside the card, never the page, at any width', async ({ page }) => {
  await open(page, { printerId: null })
  const setup = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i + 1, { type: 'PLA', brand: '', color: ['#ff0000', '#00ff00', '#0000ff', '#ffffff'][i % 4] }]))
  await sx(page, { slotSetup: setup, showUnusedSlots: true })
  await expect(page.getByTestId('slice-filament-slot')).toHaveCount(16)
  const rail = page.getByTestId('slice-filament-rail')
  const box = await rail.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
  expect(box.scroll).toBeGreaterThan(box.client)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  // The last ring is reached by scrolling the rail.
  await slot(page, 16).scrollIntoViewIfNeeded()
  await expect(slot(page, 16)).toBeInViewport()
})

// Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
test('shots: the rail, a slot picked out in the view, its menu and a mismatch, light and dark', async ({ page, isMobile }, info) => {
  test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
  test.slow()
  const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
  const width = page.viewportSize()?.width ?? 0
  await open(page)
  const rail = page.getByTestId('slice-filament-rail')
  for (const scheme of ['light', 'dark'] as const) {
    await sx(page, { scheme, themeFollowsSystem: false, slotSetup: {}, hoverSlot: null })
    await expect(page.locator('html')).toHaveAttribute('data-sx-theme', new RegExp(scheme))
    await rail.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.mouse.move(0, 0)
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${dir}/rail-${scheme}-${width}.png` })
    if (!isMobile) await slot(page, 2).hover()
    else await slot(page, 2).focus()
    await page.waitForTimeout(700)
    await page.screenshot({ path: `${dir}/rail-highlight-${scheme}-${width}.png` })
    await page.mouse.move(0, 0)
    await page.getByTestId('slice-filament-menu').click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${dir}/rail-menu-${scheme}-${width}.png` })
    await page.keyboard.press('Escape')
    await sx(page, { slotSetup: { 1: { type: 'PETG', brand: '', color: '#ffffff' } } })
    await slot(page, 1).focus()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${dir}/rail-mismatch-${scheme}-${width}.png` })
    await slot(page, 1).blur()
  }
})
