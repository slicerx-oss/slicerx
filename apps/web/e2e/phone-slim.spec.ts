// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A phone views and prints (docs/redesign/mobile-plan.md, P1): Slice with Simple settings, the objects as a list, the
// estimate and Print, the Vault and the printers. Modeling, the deeper settings and the plate tools wait for the
// desktop, and nothing on the plate moves under a finger. A narrow desktop window, with a mouse, keeps everything.
import { type Page } from '@playwright/test'
import { addMenu, expect, goTab, openSheet, plateReady, tab, test } from './fixtures'

type Sx = { getState(): { plate: { id: string; transform: number[] }[]; selection: string | null } }

async function open(page: Page, prefs: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((p) => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' }, ...p }))
  }, prefs)
  await page.goto('./')
  await plateReady(page)
}

const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())

test.describe('the slim studio on a phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'Phone only')

  test('Slice shows Simple settings and the objects as a list, with no modeling or plate tools', async ({ page }) => {
    // saved as if the person had used Model and Expert on a desktop: the phone still opens Slice in Simple
    await open(page, { modelModeDefault: 'design', settingsMode: 'expert' })
    await expect(tab(page, 'prepare')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('tab-model')).toHaveCount(0)
    await openSheet(page)
    const sheet = page.getByTestId('slice-sidebar')
    await expect(sheet.getByText('Print settings')).toBeVisible()
    await expect(page.locator('#expert-toggle')).toHaveCount(0)
    await expect(page.locator('.mode-chip')).toHaveCount(0)
    await expect(page.locator('.settings-tabs, [role="tablist"][aria-label="Settings"]')).toHaveCount(0)
    // the objects: a row and its print toggle; no lock, parts, transform fields or tool panels
    const row = page.getByTestId('object-row').first()
    await expect(row.getByTestId('object-printable')).toBeVisible()
    await expect(row.getByTestId('object-lock')).toHaveCount(0)
    await expect(row.getByTestId('slice-object-expand')).toHaveCount(0)
    await row.getByTestId('object-select').click()
    await expect(page.locator('.tf-row')).toHaveCount(0)
    // no selection bar or its menu: those verbs are edits
    await expect(page.getByTestId('slice-selection-bar')).toHaveCount(0)
    // and no scope pill: a phone's settings are the plate's
    await expect(page.getByTestId('slice-scope-object')).toHaveCount(0)
    // the plate toolbar isn't there at all
    await expect(page.locator('.plate-tools')).toHaveCount(0)
    // the settings that stay are still the person's to change: the saved mode is kept for their desktop
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('slicerx.prefs.v1') ?? '{}').settingsMode)).toBe('expert')
  })

  test('the Add menu offers files, the Vault and printer exports only', async ({ page }) => {
    await open(page)
    await openSheet(page)
    await page.getByTestId('slice-objects-add-menu').click()
    const menu = page.getByRole('menu', { name: 'Add' })
    await expect(menu.getByRole('menuitem', { name: 'From the Vault', exact: true })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Export', exact: true })).toBeVisible()
    for (const gone of ['Add shape', 'Tools', 'Object']) await expect(menu.getByRole('menuitem', { name: gone, exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await addMenu(page, 'Export')
    const exp = page.getByRole('menu', { name: 'Export' })
    await expect(exp.getByTestId('export-gcode-3mf')).toBeVisible()
    await expect(exp.getByTestId('export-save-project')).toHaveCount(0)
    await expect(exp.getByTestId('export-locked-project')).toHaveCount(0)
  })

  test('a finger on the model selects it or turns the view, and never moves it', async ({ page }) => {
    await open(page)
    const before = (await state(page)).plate.map((p) => p.transform.join(','))
    const box = (await page.locator('.vp-canvas').boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    // a tap, then a press and drag starting on the model
    await page.touchscreen.tap(x, y)
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 60, y + 20, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    expect((await state(page)).plate.map((p) => p.transform.join(','))).toEqual(before)
  })

  test('the Vault and the printers are a tap away', async ({ page }) => {
    await open(page)
    await goTab(page, 'printers')
    await expect(page.locator('.app[data-workspace="printers"]')).toBeVisible()
    await goTab(page, 'feed').catch(() => goTab(page, 'library'))
    await expect(page.locator('.app[data-workspace="library"], .app[data-workspace="feed"]')).toBeVisible()
  })
})

test('a narrow desktop window with a mouse keeps the full layout', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop only')
  await page.setViewportSize({ width: 800, height: 900 })
  await open(page)
  await expect(page.locator('html')).not.toHaveAttribute('data-phone')
  await expect(page.getByTestId('tab-model')).toHaveCount(1)
  await expect(page.locator('.plate-tools')).toHaveCount(1)
})
