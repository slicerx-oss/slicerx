// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One layer mode following the arrows, and the layer actions in the command bar.
import { type Page } from '@playwright/test'
import { expect, plateReady, test } from './fixtures'

type Sx = { getState(): { layerHi: number; layerLo: number; legendHidden: boolean } }
const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())
const handles = async (page: Page) => {
  const s = await state(page)
  return [s.layerHi, s.layerLo]
}
const dockLayer = (page: Page) => page.getByRole('group', { name: 'Layers and moves' }).locator('.dock-jump-num')

async function sliced(page: Page): Promise<number> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, lookAndFeel: { id: 'slicerx' } }))
  })
  await page.goto('./')
  await plateReady(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(page.getByRole('group', { name: 'Layers and moves' })).toBeVisible({ timeout: 40_000 })
  const n = Number(await page.locator('#pv-layer').getAttribute('max'))
  expect(n).toBeGreaterThan(3)
  // A focused button keeps its own keys; the layer keys act once nothing has focus.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect(dockLayer(page)).toHaveText(String(n))
  return n
}

async function command(page: Page, title: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible()
  await page.keyboard.type(title)
  await page.locator('.sx-palette-item', { hasText: title }).first().click()
  await expect(page.getByRole('dialog', { name: 'Commands' })).toHaveCount(0)
}

test('one layer mode follows the arrows, and Shift+L again brings back every layer below', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Keyboard at desktop widths')
  const n = await sliced(page)

  // Shift+L shows one layer; the bottom handle then travels with every step.
  await page.keyboard.press('Shift+L')
  await expect.poll(() => handles(page)).toEqual([n, n])
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => handles(page)).toEqual([n - 2, n - 2])
  await expect(dockLayer(page)).toHaveText(String(n - 2))
  await page.keyboard.press('Shift+L')
  await expect.poll(() => handles(page)).toEqual([n - 2, 1])
})

test('the command bar steps the layers, shows one layer and hides the legend', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The legend is not drawn at phone widths')
  const n = await sliced(page)
  const legend = page.getByRole('list', { name: 'Toolpath legend' })
  await expect(legend).toBeVisible()

  await command(page, 'Layer down')
  await expect(dockLayer(page)).toHaveText(String(n - 1))
  await command(page, 'Layer up')
  await expect(dockLayer(page)).toHaveText(String(n))
  await command(page, 'One layer mode')
  await expect.poll(() => handles(page)).toEqual([n, n])
  await command(page, 'One layer mode')
  await expect.poll(() => handles(page)).toEqual([n, 1])
  await command(page, 'Show or hide the legend')
  await expect(legend).toHaveCount(0)
  await command(page, 'Show or hide the legend')
  await expect(legend).toBeVisible()
})
