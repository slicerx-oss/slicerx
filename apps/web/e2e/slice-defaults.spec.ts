// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Slice tab as people first see it: the playback bar starts shut to its transport row and opens from its ^ tab (or
// the bottom panel key), Show toolhead starts on and Show gantry off, the plate toolbar drags anywhere in the view and
// starts at the top again in a new session, and the view shows a quiet edge for focus only when Tab brought it there.
import { type Page } from '@playwright/test'
import { expect, sliceCount, sliced, test } from './fixtures'

type Sx = { getState(): { plate: { name: string }[]; showToolhead: boolean; showGantry: boolean }; setState(p: unknown): void }

async function open(page: Page): Promise<void> {
  await page.addInitScript(() => {
    sessionStorage.setItem('sx-right-pane', 'shut')
    sessionStorage.setItem('sx-preview-drawer', 'shut')
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', pilot: { mode: 'off' }, printerId: 'bay-1' }))
  })
  await page.goto('./')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx?: Sx }).__sx?.getState().plate.some((p) => p.name.includes('Layered X')) ?? false), { timeout: 120_000 }).toBe(true)
  await page.locator('html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: 120_000 })
}

async function slice(page: Page): Promise<void> {
  const n = await sliceCount(page)
  await page.mouse.click(700, 450)
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(sliced(page, n)).toBeVisible({ timeout: 120_000 })
}

/** After a reload: the plate is back and the view is up. */
async function reloaded(page: Page): Promise<void> {
  await page.reload()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx?: Sx }).__sx?.getState().plate.some((p) => p.name.includes('Layered X')) ?? false), { timeout: 120_000 }).toBe(true)
  await page.locator('html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: 120_000 })
}

const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())

test.describe('Slice tab defaults', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop width: on a phone the bar opens from its own row and the toolbar is off')

  test('the playback bar starts shut to its transport row and opens from its tab and its key', async ({ page }) => {
    await open(page)
    await slice(page)
    const dock = page.getByTestId('preview-drawer')
    const tab = dock.getByTestId('edge-tab-bottom')
    await expect(dock).toHaveAttribute('data-mode', 'slim')
    await expect(tab).toHaveAttribute('aria-expanded', 'false')
    await expect(dock.getByRole('button', { name: 'Play print' })).toBeVisible()
    await expect(dock.getByLabel('Time', { exact: true })).toBeHidden()
    // The tab sits on the bar's top edge, in the middle, and is big enough to hit.
    const t = (await tab.boundingBox())!
    const d = (await dock.boundingBox())!
    expect(Math.abs(t.y + t.height - d.y)).toBeLessThan(1.5)
    expect(Math.abs(t.x + t.width / 2 - (d.x + d.width / 2))).toBeLessThan(1.5)
    expect(t.width).toBeGreaterThanOrEqual(72)
    expect(t.height).toBeGreaterThanOrEqual(22)
    await tab.click()
    await expect(dock).toHaveAttribute('data-mode', 'full')
    await expect(tab).toHaveAttribute('aria-expanded', 'true')
    await expect(dock.getByLabel('Time', { exact: true })).toBeVisible()
    await page.mouse.move(700, 300)
    await page.keyboard.press('ControlOrMeta+j')
    await expect(dock).toHaveAttribute('data-mode', 'slim')
    await page.keyboard.press('ControlOrMeta+j')
    await expect(dock).toHaveAttribute('data-mode', 'full')
    // The person's choice is kept.
    await reloaded(page)
    await slice(page)
    await expect(page.getByTestId('preview-drawer')).toHaveAttribute('data-mode', 'full')
  })

  test('Show toolhead starts on and Show gantry off, each its own switch', async ({ page }) => {
    await open(page)
    await slice(page)
    const head = page.getByTestId('pv-show-toolhead')
    const gantry = page.getByTestId('pv-show-gantry')
    await expect(head).toBeChecked()
    await expect(gantry).not.toBeChecked()
    expect(await state(page)).toMatchObject({ showToolhead: true, showGantry: false })
    await gantry.check()
    expect(await state(page)).toMatchObject({ showToolhead: true, showGantry: true })
    await head.uncheck()
    expect(await state(page)).toMatchObject({ showToolhead: false, showGantry: true })
    await reloaded(page)
    await slice(page)
    await expect(page.getByTestId('pv-show-toolhead')).not.toBeChecked()
    await expect(page.getByTestId('pv-show-gantry')).toBeChecked()
  })

  test('the plate toolbar drags anywhere in the view, stays inside it, and starts at the top in a new session', async ({ page }) => {
    await open(page)
    const group = page.getByTestId('plate-tools-group')
    const grip = page.getByTestId('plate-tools-grip')
    const vp = (await page.locator('.vp').boundingBox())!
    const start = (await group.boundingBox())!
    // Level with the corner buttons, near the top of the view.
    expect(start.y - vp.y).toBeLessThanOrEqual(14)
    await group.hover()
    const g = (await grip.boundingBox())!
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
    await page.mouse.down()
    await page.mouse.move(g.x + g.width / 2 - 150, g.y + g.height / 2 + 200, { steps: 6 })
    await page.mouse.up()
    const moved = (await group.boundingBox())!
    expect(moved.x - start.x).toBeCloseTo(-150, 0)
    expect(moved.y - start.y).toBeCloseTo(200, 0)
    await expect(group).toHaveAttribute('data-moved', 'true')
    // Far past the view's corner: it stops inside, 8 px from the edges.
    const g2 = (await grip.boundingBox())!
    await page.mouse.move(g2.x + g2.width / 2, g2.y + g2.height / 2)
    await page.mouse.down()
    await page.mouse.move(g2.x + 3000, g2.y + 3000, { steps: 6 })
    await page.mouse.up()
    const end = (await group.boundingBox())!
    expect(end.x + end.width).toBeLessThanOrEqual(vp.x + vp.width - 7.5)
    expect(end.y + end.height).toBeLessThanOrEqual(vp.y + vp.height - 7.5)
    // The arrow keys move it too, from the grip.
    await grip.focus()
    await page.keyboard.press('ArrowLeft')
    expect((await group.boundingBox())!.x).toBeCloseTo(end.x - 16, 0)
    // Not kept: a new session starts it at the top.
    await reloaded(page)
    await expect(page.getByTestId('plate-tools-group')).not.toHaveAttribute('data-moved', /.*/)
    expect((await page.getByTestId('plate-tools-group').boundingBox())!.y).toBeCloseTo(start.y, 0)
  })

  test('the view shows no focus ring after a click and a key, and a quiet edge when Tab brings focus to it', async ({ page }) => {
    await open(page)
    const canvas = page.locator('.vp-canvas')
    await page.mouse.click(700, 450)
    await page.keyboard.press('ArrowDown')
    await expect(canvas).toBeFocused()
    expect(await canvas.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none')
    await canvas.evaluate((el) => (el as HTMLElement).blur())
    // Tab from the element just before the view lands on it.
    await canvas.evaluate((el) => {
      const before = document.createElement('button')
      before.id = 'e2e-before-view'
      el.parentElement!.insertBefore(before, el)
      before.focus()
    })
    await page.keyboard.press('Tab')
    await expect(canvas).toBeFocused()
    await expect(canvas).toHaveAttribute('data-tab-focus', '')
    expect(await canvas.evaluate((el) => ({ style: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth }))).toEqual({ style: 'solid', width: '1px' })
  })
})
