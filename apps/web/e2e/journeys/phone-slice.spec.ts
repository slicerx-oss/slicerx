// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey (phone project): the phone legs of the slice journeys. The layer pins on the playback bar by finger (each pin
// its own tap, close ones open a list, the pins over the Layer track in the opened bar, a tip that covers no control),
// the plate picker naming the plate only, the Print tip clear of the estimate, and the live view of one printer. The desktop legs are in
// slicing-preview.spec.ts and printer-bridge.spec.ts.
// A phone page is shared by a worker's tests (journey.ts); the box is sliced once and each test puts the bar back.
import { type Page } from '@playwright/test'
import { expect, journey as test } from '../journey'
import { calm, center, clear, debugHooks, layeredX, layerCount, layerHi, marks, nameFleet, patch, pin, printerHud, sliceLayered, state, tapFor, thumbX, tipCovers, transport } from './lib/slice'

test.skip(({ isMobile }) => !isMobile, 'Phone layout')

test.beforeAll(async ({ app }) => {
  await debugHooks(app)
})

/** The sliced example plate (Layered X, a tall model with many layers) with the playback bar as a test starts it: the extra controls shut, and the first touch woken. */
async function pinned(page: Page): Promise<void> {
  await sliceLayered(page)
  // Chromium's touch hit test wakes on the page's first mouse event
  await page.mouse.click(1, 1)
  const fewer = page.getByRole('button', { name: 'Fewer playback controls' })
  if (await fewer.isVisible()) await fewer.click()
  await expect(page.getByRole('button', { name: 'More playback controls' })).toBeVisible()
}

test('on a phone each pin is its own tap, close ones open a list, and More and the slider keep their taps', async ({ page }) => {
  test.slow()
  await pinned(page)
  const more = page.getByRole('button', { name: 'More playback controls' })
  await tapFor(page, () => center(more), () => expect(page.getByRole('button', { name: 'Fewer playback controls' })).toBeVisible({ timeout: 2000 }))
  const z = (await state(page)).preview!.layerZ
  const n = await layerCount(page)
  // The same layer the pins were first checked on, where the example plate has plenty of layers.
  const far = 200
  const below = Math.round(((z[19]! - z[18]!) / 2) * 1e4) / 1e4
  await marks(page, [[20, 'pause'], [20, 'color_change', below], [21, 'custom'], [far, 'pause']])
  // each head under a finger is that mark: its layer, its own menu, the pin marked, the menu inside the screen
  for (const [name, layer, item] of [
    [`Pause at layer ${far}`, far, 'Remove pause'],
    ['Color change at layer 20', 20, 'Remove color change'],
    ['Pause at layer 20', 20, 'Remove pause'],
    ['Custom G-code at layer 21', 21, 'Remove custom G-code'],
  ] as const) {
    const p = pin(page, name)
    const menu = page.getByRole('menu', { name })
    await tapFor(page, () => center(p), () => expect(menu, name).toBeVisible({ timeout: 2000 }))
    await expect.poll(() => layerHi(page), name).toBe(layer)
    await expect(menu.getByRole('menuitem', { name: item })).toBeVisible()
    await expect(p).toHaveAttribute('data-selected', 'true')
    const box = (await menu.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(844)
    await page.keyboard.press('Escape')
  }
  // a finger between the two layer 20 heads could mean either: a list of both, and a tap on one opens its menu
  const a = await center(pin(page, 'Pause at layer 20'))
  const b = await center(pin(page, 'Color change at layer 20'))
  const list = page.getByRole('menu', { name: 'Layer actions near layer 20' })
  await tapFor(page, async () => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }), () => expect(list).toBeVisible({ timeout: 2000 }))
  // both layer 20 marks, in layer order (a neighbor near the finger may join them)
  await expect(list.getByRole('menuitem', { name: / at layer / }).first()).toHaveText(/ at layer 20, /)
  await expect(list.getByRole('menuitem', { name: /^Pause at layer 20/ })).toBeVisible()
  await expect(list.getByRole('menuitem', { name: /^Color change at layer 20/ })).toBeVisible()
  await tapFor(page, () => center(list.getByRole('menuitem', { name: /^Color change at layer 20/ })), () => expect(page.getByRole('menu', { name: 'Color change at layer 20' }).getByRole('menuitem', { name: 'Remove color change' })).toBeVisible({ timeout: 2000 }))
  await page.keyboard.press('Escape')
  // a drag on the slider scrubs: no pin takes it and no menu opens
  const track = (await page.locator('#pv-layer').boundingBox())!
  const from = { x: await thumbX(page, await layerHi(page)), y: track.y + track.height / 2 }
  const to = { x: await thumbX(page, Math.round(n * 0.75)), y: from.y }
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] })
  for (let t = 1; t <= 8; t++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + ((to.x - from.x) * t) / 8, y: from.y }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
  await expect.poll(() => layerHi(page)).toBeGreaterThan(Math.round(n * 0.6))
  await expect(page.getByRole('menu')).toHaveCount(0)
  // and More still answers its own tap
  await tapFor(page, () => center(page.getByRole('button', { name: 'Fewer playback controls' })), () => expect(page.getByRole('button', { name: 'More playback controls' })).toBeVisible({ timeout: 2000 }))
})

test('on a phone the pins stand over the Layer track in the opened bar', async ({ page }) => {
  await pinned(page)
  await page.getByRole('button', { name: 'More playback controls' }).click()
  await marks(page, [[20, 'pause'], [21, 'color_change'], [200, 'custom']])
  const time = (await page.locator('#pv-time').boundingBox())!
  const track = (await page.locator('#pv-layer').boundingBox())!
  for (const b of await page.locator('.layer-mark:not(.strike-mark)').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect))) {
    expect(b.y + b.height).toBeLessThanOrEqual(track.y + 0.5)
    expect(b.y).toBeGreaterThanOrEqual(time.y + time.height)
  }
})

test("on a phone a pin's tip covers no control, and opens over the opened bar", async ({ page }) => {
  test.slow()
  await pinned(page)
  const more = page.getByRole('button', { name: 'More playback controls' })
  await tapFor(page, () => center(more), () => expect(page.getByRole('button', { name: 'Fewer playback controls' })).toBeVisible({ timeout: 2000 }))
  const far = 200
  await marks(page, [[20, 'color_change'], [21, 'pause'], [far, 'custom']])
  const dock = page.getByRole('group', { name: 'Layers and moves' })
  for (const [name, text] of [['Color change at layer 20', 'Layer 20, Color change'], [`Custom G-code at layer ${far}`, `Layer ${far}, Custom G-code`]] as const) {
    // a press held past half a second shows the tip above the finger and takes no tap
    const at = await center(pin(page, name))
    const cdp = await page.context().newCDPSession(page)
    const tip = page.getByRole('tooltip').filter({ hasText: text })
    // A page busy past the half second does not see the press as a long one: the finger lifts and presses again.
    await expect(async () => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] })
      try {
        await expect(tip).toBeVisible({ timeout: 4_000 })
      } catch (e) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        throw e
      }
    }).toPass({ timeout: 40_000 })
    expect(await tipCovers(page, tip), text).toEqual([])
    const t = (await tip.boundingBox())!
    const top = Math.min(...(await dock.locator('button, input').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height).map((r) => r.top))))
    expect(t.y + t.height, text).toBeLessThanOrEqual(top)
    expect(t.x, text).toBeGreaterThanOrEqual(0)
    expect(t.x + t.width, text).toBeLessThanOrEqual(390)
    expect(t.y, text).toBeGreaterThanOrEqual(0)
    for (const b of transport(dock)) expect(clear(t, (await b.boundingBox())!), `${text} and ${await b.getAttribute('aria-label')}`).toBe(true)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
    await expect(tip).toBeHidden()
    await page.keyboard.press('Escape')
  }
})

test('on a phone, the plate picker names the plate only, whatever the object is called', async ({ page }) => {
  await calm(page, 'simple')
  await layeredX(page)
  await expect(page.getByTestId('plate-picker-current')).toBeVisible()
  await page.evaluate(() => {
    const sx = (window as unknown as { __sx: { getState(): { plate: { name: string }[] }; setState(p: unknown): void } }).__sx
    const [o, ...rest] = sx.getState().plate
    sx.setState({ plate: [{ ...o, name: `${'Very_long_model_name_from_a_marketplace_download_'.repeat(2)}v2.stl` }, ...rest] })
  })
  await expect(page.getByTestId('plate-picker-current').locator('.pp-no')).toHaveText('Plate 1')
  await expect(page.getByTestId('plate-picker-current')).not.toContainText('Very_long')
  await expect.poll(() => page.getByTestId('plate-picker').evaluate((el) => el.getBoundingClientRect().right <= innerWidth)).toBe(true)
})

test('on a phone a Print tip that only repeats the button is not shown', async ({ page }) => {
  await sliceLayered(page)
  // the estimate and Print float over the view, under the playback bar, while the sheet is shut
  const print = page.getByTestId('danger-slice-print')
  await expect(print).toBeEnabled()
  await page.mouse.move(1, 1)
  await print.hover()
  // the tip would open after 450 ms: a second on, none is up
  await page.waitForTimeout(1000)
  await expect(page.locator('#sx-tip')).toHaveCount(0)
})

test('on a phone a held Print opens its reason above the whole estimate, clear of the figures and the bar', async ({ page }) => {
  await sliceLayered(page)
  const print = page.getByTestId('danger-slice-print')
  const tip = page.locator('#sx-tip')
  const foot = page.getByTestId('slice-estimate')
  // Print held, for a printer with a long name and a reason: the tip is long, and it stays above the estimate.
  await nameFleet(page, 'Workshop enclosure printer with the hardened nozzle, bay 12 A')
  await patch(page, { plateLoading: true })
  try {
    await expect(print).toHaveAttribute('aria-disabled', 'true')
    await page.mouse.move(1, 1)
    await expect(tip).toHaveCount(0)
    await print.hover()
    await expect(tip).toContainText('The model is still loading.')
    expect(await tipCovers(page, tip)).toEqual([])
    const t = (await tip.boundingBox())!
    const f = (await foot.boundingBox())!
    // above the whole footer, and inside the window
    expect(t.y + t.height).toBeLessThanOrEqual(f.y)
    // a gutter of 16 px from either side of the window (the spec's phone gutter)
    expect(t.x).toBeGreaterThanOrEqual(16)
    expect(t.x + t.width).toBeLessThanOrEqual(390 - 16)
    expect(t.y).toBeGreaterThanOrEqual(0)
    for (const spot of [foot.locator('.est-anchor'), foot.locator('.est-fig').first(), foot.locator('.est-fig').last()]) expect(clear(t, (await spot.boundingBox())!)).toBe(true)
    // and clear of the playback bar over the footer
    const dock = page.getByRole('group', { name: 'Layers and moves' })
    await expect(dock).toBeVisible()
    expect(clear(t, (await dock.boundingBox())!)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('held-print-tip.png') })
  } finally {
    await patch(page, { plateLoading: false })
    await nameFleet(page, null)
    await page.mouse.move(1, 1)
  }
})

test('a printer opens in its live view with drawers, and Pause asks first', async ({ page, isMobile }) => {
  await calm(page, 'simple')
  await printerHud(page, isMobile)
})

