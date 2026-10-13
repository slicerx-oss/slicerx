// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The CAD-only browser build (web_slicing off): search has no slicing, Model has a visible Export, nothing ever
// slices, and the pre-alpha agreement talks about models only. slicerx.e2e.cadOnly turns a test build into that host.
import { type Page } from '@playwright/test'
import { command } from './cad-helpers'
import { appReady, expect, test } from './fixtures'

type Sx = { getState(): { plate: unknown[]; slice: { status: string } }; setState(p: unknown): void }
const setState = (page: Page, patch: Record<string, unknown>) => page.evaluate((p) => (window as unknown as { __sx: Sx }).__sx.setState(p), patch)
const plateCount = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate.length)
const sliceStatus = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().slice.status)

async function openCadOnly(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.e2e.cadOnly', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await appReady(page)
  // the example plate, in Model's tree (the Slice objects list never shows here)
  await expect(page.locator('.dtree-name', { hasText: 'Layered X' })).toBeVisible()
}

async function search(page: Page, text: string) {
  const bar = page.getByRole('dialog', { name: 'Commands' })
  if (!(await bar.isVisible())) await page.keyboard.press('ControlOrMeta+k')
  await expect(bar).toBeVisible()
  await bar.getByRole('combobox').fill(text)
  return bar
}

test.describe('the CAD-only browser build', () => {
  test.skip(({ isMobile }) => isMobile, 'the web phone layout is parked')

  test('search has no slicing, printers or presets', async ({ page }) => {
    await openCadOnly(page)
    let bar = await search(page, 'export')
    await expect(bar.getByRole('option', { name: /STL/ }).first()).toBeVisible()
    await expect(bar.getByRole('option', { name: /gcode|\.3mf print|print file/i })).toHaveCount(0)
    bar = await search(page, 'presets')
    await expect(bar.getByRole('option', { name: /preset/i })).toHaveCount(0)
    bar = await search(page, 'printer')
    await expect(bar.getByRole('option', { name: /printer/i })).toHaveCount(0)
    bar = await search(page, 'brim')
    await expect(bar.getByRole('group', { name: 'Settings' })).toHaveCount(0)
    await expect(bar.getByRole('option', { name: /brim/i })).toHaveCount(0)
  })

  test('Model has an Export menu for STL, OBJ and the project file', async ({ page }) => {
    await openCadOnly(page)
    await setState(page, { plate: [], selection: null, selectedIds: [] })
    await command(page, 'Add a box')
    await expect.poll(() => plateCount(page)).toBe(1)
    await page.getByTestId('model-export').click()
    const menu = page.getByRole('menu', { name: 'Export' })
    await expect(menu).toBeVisible()
    for (const name of ['Whole model as STL', 'Whole model as OBJ', 'Project file (.sx3mf)']) await expect(menu.getByRole('menuitem', { name })).toBeEnabled()
    const [download] = await Promise.all([page.waitForEvent('download'), menu.getByRole('menuitem', { name: 'Whole model as STL' }).click()])
    expect(download.suggestedFilename()).toMatch(/\.stl$/)
  })

  test('nothing slices, so the status bar never says Slicing', async ({ page }) => {
    await openCadOnly(page)
    await setState(page, { plate: [], selection: null, selectedIds: [] })
    await command(page, 'Add a box')
    await expect.poll(() => plateCount(page)).toBe(1)
    // auto slice would have started by now on a host that slices
    for (let i = 0; i < 10; i++) {
      expect(await sliceStatus(page)).not.toBe('running')
      await expect(page.locator('footer.sx-status')).not.toContainText('Slicing')
      await page.waitForTimeout(200)
    }
  })

  test('the agreement talks about models, not toolpaths or printers', async ({ page }) => {
    await openCadOnly(page)
    await setState(page, { agreement: null, agreementOpen: true })
    const dialog = page.getByTestId('agreement')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('export anything you want to keep')
    await expect(dialog).toContainText('Agreement version 2')
    await expect(dialog).not.toContainText(/toolpath|printer|nozzle|temperature/i)
  })
})
