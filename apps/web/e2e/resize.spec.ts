// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Pane edges: drag to resize, keys, collapse by drag and double-click, sizes kept per look.
import { type Page } from '@playwright/test'
import { expect, plateReady, test } from './fixtures'

async function prepare(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
}

const width = (page: Page) => page.locator('aside.pane').first().evaluate((el) => Math.round(el.getBoundingClientRect().width))

test.describe('resizable panes', () => {
  test.skip(({ isMobile }) => isMobile, 'Panes stack on a phone')

  test('the sidebar edge drags, responds to keys, collapses and reopens', async ({ page }) => {
    await prepare(page)
    const edge = page.getByRole('separator', { name: /Resize printer and settings/i })
    await expect(edge).toHaveAttribute('aria-orientation', 'vertical')
    const w0 = await width(page)
    const box = (await edge.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + 200)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + 200, { steps: 6 })
    await page.mouse.up()
    await expect.poll(() => width(page)).toBeGreaterThan(w0 + 60)
    // Keys: Home goes to the minimum, End to the maximum.
    await edge.focus()
    await page.keyboard.press('End')
    await expect.poll(() => width(page)).toBeGreaterThanOrEqual(540)
    await page.keyboard.press('Home')
    await expect.poll(() => width(page)).toBeLessThanOrEqual(250)
    // Dragging well past the minimum collapses to the rail, and a double-click opens it again.
    const b2 = (await edge.boundingBox())!
    await page.mouse.move(b2.x + b2.width / 2, b2.y + 200)
    await page.mouse.down()
    await page.mouse.move(b2.x - 150, b2.y + 200, { steps: 8 })
    await page.mouse.up()
    await expect.poll(() => width(page)).toBeLessThan(80)
    await page.getByRole('separator', { name: /Resize printer and settings/i }).dblclick()
    await expect.poll(() => width(page)).toBeGreaterThan(200)
  })

  test('the edge has a tip, and the size survives a reload', async ({ page }) => {
    await prepare(page)
    const edge = page.getByRole('separator', { name: /Resize printer and settings/i })
    await edge.focus()
    await page.keyboard.press('End')
    await expect.poll(() => width(page)).toBeGreaterThanOrEqual(540)
    // The width animates (a CSS transition on the rail); read it once it has stopped, not partway there.
    let wide = 0
    await expect
      .poll(async () => {
        const w = await width(page)
        const settled = w === wide
        wide = w
        return settled
      }, { intervals: [150] })
      .toBe(true)
    await page.reload()
    await plateReady(page)
    // The saved width is a fraction of the window and rounds to a pixel either way.
    expect(Math.abs((await width(page)) - wide)).toBeLessThanOrEqual(1)
    await page.getByRole('separator', { name: /Resize printer and settings/i }).hover()
    await expect(page.locator('#sx-tip')).toContainText('Drag to resize. Double-click to collapse.')
  })
})

test.describe('playback bar edge', () => {
  test.skip(({ isMobile }) => isMobile, 'Panes stack on a phone')

  test('dragging the playback bar shorter hides its sliders, and a double-click brings them back', async ({ page }) => {
    test.slow()
    await prepare(page)
    await page.getByRole('button', { name: 'Slice plate' }).click()
    await expect(page.locator('.sx-tab[aria-current=page]')).toContainText('Preview', { timeout: 120_000 })
    const dock = page.getByRole('group', { name: 'Layers and moves' })
    await expect(dock).toHaveAttribute('data-mode', 'full')
    const edge = page.getByRole('separator', { name: /Resize the playback bar/i })
    await edge.focus()
    await page.keyboard.press('Home')
    await expect(dock).toHaveAttribute('data-mode', 'compact')
    // One more step down at the minimum collapses it to the slim bar.
    await page.keyboard.press('ArrowDown')
    await expect(dock).toHaveAttribute('data-mode', 'slim')
    await expect(dock.getByLabel('Layer', { exact: true })).toBeHidden()
    await edge.dblclick()
    await expect(dock).toHaveAttribute('data-mode', 'full')
  })
})
