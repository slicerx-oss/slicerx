// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Slice tab as people first see it: the playback bar starts shut to its transport row and opens from its ^ tab (or
// the bottom panel key), Show toolhead starts on and Show gantry off, the plate toolbar drags anywhere in the view and
// starts at the top again in a new session, and the view shows a quiet edge for focus only when Tab brought it there.
import { type Page } from '@playwright/test'
import { expect, sliceCount, sliced, test, viewSized } from './fixtures'

type Sx = { getState(): { plate: { name: string }[]; showToolhead: boolean; showGantry: boolean }; setState(p: unknown): void }

/**
 * Opens the app with the playback bar shut, as people get it. `rightPane` 'open' starts Slice's right pane open, as the
 * other specs do, for a test that slices but is not about that pane: a finished slice opens a shut pane, and on software
 * graphics the view's resize that comes with it holds the page for seconds.
 */
async function open(page: Page, rightPane: 'shut' | 'open' = 'shut'): Promise<void> {
  await page.addInitScript((pane) => {
    if (pane === 'shut') sessionStorage.setItem('sx-right-pane', 'shut')
    sessionStorage.setItem('sx-preview-drawer', 'shut')
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', pilot: { mode: 'off' }, printerId: 'bay-1' }))
  }, rightPane)
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
    await open(page, 'open')
    await slice(page)
    const dock = page.getByTestId('preview-drawer')
    const tab = dock.getByTestId('edge-tab-bottom')
    await expect(dock).toHaveAttribute('data-mode', 'slim')
    await expect(tab).toHaveAttribute('aria-expanded', 'false')
    await expect(dock.getByRole('button', { name: 'Play print' })).toBeVisible()
    await expect(dock.getByLabel('Time', { exact: true })).toBeHidden()
    // The tab sits on the bar's top edge, near its right end, and is big enough to hit.
    const t = (await tab.boundingBox())!
    const d = (await dock.boundingBox())!
    expect(Math.abs(t.y + t.height - d.y)).toBeLessThan(1.5)
    expect(Math.abs(d.x + d.width - (t.x + t.width) - 24)).toBeLessThan(1.5)
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

  test('the bar keeps its controls on one row while it is folded, or transport and speed over the view checks and readout when wide, and its tab never meets the plate chip', async ({ page }) => {
    for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(size)
      if (size.width === 1440) {
        // Both panes open: the narrowest view at this width.
        await open(page, 'open')
        await slice(page)
        await expect(page.getByTestId('edge-tab-right')).toHaveAttribute('aria-expanded', 'true')
      }
      const dock = page.getByTestId('preview-drawer')
      const tab = dock.getByTestId('edge-tab-bottom')
      for (const want of ['slim', 'full'] as const) {
        if ((await dock.getAttribute('data-mode')) !== want) await tab.click()
        await expect(dock).toHaveAttribute('data-mode', want)
        await page.waitForTimeout(250)
        const mid = async (sel: string) => { const b = (await dock.locator(sel).first().boundingBox())!; return b.y + b.height / 2 }
        // under 1000 px (both side panes open) the bar folds to one row: the speed as one button, the checks as icons
        const folded = (await dock.getAttribute('data-narrow')) !== null
        const play = await mid('button[aria-label="Play print"]')
        const speed = await mid(folded ? '.dock-speed-btn' : '[role="radiogroup"]')
        const head = await mid('[data-testid="pv-show-toolhead"]')
        const gantry = await mid('[data-testid="pv-show-gantry"]')
        const follow = await mid('label:has-text("Follow nozzle") input, input[aria-label="Follow nozzle"]')
        const read = await mid('.dock-read')
        const where = `${size.width} ${want}${folded ? ' folded' : ''}`
        expect(Math.abs(play - speed), where).toBeLessThan(4)
        expect(Math.abs(head - gantry), where).toBeLessThan(2)
        expect(Math.abs(head - follow), where).toBeLessThan(2)
        expect(Math.abs(head - read), where).toBeLessThan(4)
        if (folded) expect(Math.abs(head - play), where).toBeLessThan(4)
        else expect(head - play, where).toBeGreaterThan(16)
        // The tab and the plate chips never meet.
        const t = (await tab.boundingBox())!
        for (const chip of await page.locator('.vp > .hud-bl > *').all()) {
          const c = await chip.boundingBox()
          if (!c) continue
          const apart = c.x + c.width + 8 <= t.x || t.x + t.width + 8 <= c.x || c.y + c.height + 8 <= t.y || t.y + t.height + 8 <= c.y
          expect(apart, `${where}: chip ${JSON.stringify(c)} tab ${JSON.stringify(t)}`).toBe(true)
        }
      }
      // The slider tracks run to the readout column: no more than the readout's own column and gaps after them.
      const time = (await dock.locator('#pv-time').boundingBox())!
      const out = (await dock.locator('output[for="pv-time"]').boundingBox())!
      expect(out.x - (time.x + time.width), `${size.width}`).toBeLessThan(24)
    }
  })

  test('printer and filament controls stay reachable at shorter window heights', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await open(page, 'open')
    await slice(page)
    const pane = page.locator('aside.pane[data-side="left"]')
    const body = pane.locator('.sx-rail-body')
    const footer = pane.locator('.sx-rail-foot')
    for (const size of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 1440, height: 700 }]) {
      await page.setViewportSize(size)
      await viewSized(page)
      const footerBefore = await footer.boundingBox()
      for (const control of [page.getByTestId('slice-machine-plate'), page.getByTestId('slice-filament-slot').last(), page.getByRole('radiogroup', { name: 'Supports' })]) {
        await control.scrollIntoViewIfNeeded()
        await expect(control).toBeInViewport()
        expect(await footer.boundingBox()).toEqual(footerBefore)
      }
      await body.evaluate((el) => el.scrollTo(0, 0))
      await expect(page.getByTestId('slice-machine-card')).toBeInViewport()
      await expect(footer).toBeInViewport()
    }
  })

  test('Show toolhead starts on and Show gantry off, each its own switch', async ({ page }) => {
    await open(page, 'open')
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
