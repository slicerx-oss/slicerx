// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Preview: the layer and move sliders change what the viewport draws.
import { type Page } from '@playwright/test'
import { expect, plateReady, test } from './fixtures'

async function sliced(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced' }))
  })
  await page.goto('./')
  await plateReady(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(page.getByRole('group', { name: 'Layers and moves' })).toBeVisible({ timeout: 40_000 })
}

/** The segment range the viewport draws right now, read from the toolpath layer. */
const drawn = (page: Page) =>
  page.evaluate(() => {
    const tp = (window as unknown as { __vp: { toolpaths: { visibleRange(): [number, number]; hi: number } } }).__vp.toolpaths
    const [from, to] = tp.visibleRange()
    return { from, to, hi: tp.hi }
  })

test('the layer slider moves the top drawn layer', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop layout')
  await sliced(page)
  const layer = page.locator('#pv-layer')
  const full = await drawn(page)
  await layer.focus()
  await page.keyboard.press('Home')
  await expect.poll(async () => (await drawn(page)).hi).toBe(0)
  const first = await drawn(page)
  expect(first.to).toBeLessThan(full.to)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await drawn(page)).hi).toBe(2)
  await page.keyboard.press('End')
  await expect.poll(async () => (await drawn(page)).to).toBe(full.to)
})

test('the move slider cuts the top layer and shows the nozzle there', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop layout')
  await sliced(page)
  await page.locator('#pv-layer').focus()
  await page.keyboard.press('ArrowLeft')
  const layerEnd = (await drawn(page)).to
  const moves = page.locator('#pv-moves')
  await moves.focus()
  await page.keyboard.press('Home')
  await expect.poll(async () => (await drawn(page)).to).toBeLessThan(layerEnd)
  const start = (await drawn(page)).to
  await page.keyboard.press('PageUp')
  await expect.poll(async () => (await drawn(page)).to).toBeGreaterThan(start)
})

test('dragging the sliders with the mouse scrubs layers and moves', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop layout')
  await sliced(page)
  const layer = page.locator('#pv-layer')
  const n = Number(await layer.getAttribute('max'))
  // The dock can still be settling after the slice (under load the side pane lands late), so each press goes
  // through the locator, which waits for the slider to be stable and uncovered, and each drag measures it again.
  const at = async (slider: typeof layer, share: number) => {
    const b = (await slider.boundingBox())!
    return { x: b.width * share, y: b.height / 2, abs: [b.x + b.width * share, b.y + b.height / 2] as const }
  }
  // Grab the thumb at the right end and drag to the middle.
  const end = await at(layer, 1)
  await layer.hover({ position: { x: end.x - 4, y: end.y } })
  await page.mouse.down()
  const mid = await at(layer, 0.5)
  await page.mouse.move(...mid.abs, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => Math.abs((await drawn(page)).hi + 1 - n / 2), { timeout: 10_000 }).toBeLessThan(n * 0.12)
  // Clicking the track jumps there.
  const quarter = await at(layer, 0.25)
  await layer.click({ position: { x: quarter.x, y: quarter.y } })
  await expect.poll(async () => Math.abs((await drawn(page)).hi + 1 - n / 4), { timeout: 10_000 }).toBeLessThan(n * 0.12)
  const moves = page.locator('#pv-moves')
  const half = await at(moves, 0.5)
  await moves.click({ position: { x: half.x, y: half.y } })
  const before = (await drawn(page)).to
  await moves.hover({ position: { x: half.x, y: half.y } })
  await page.mouse.down()
  const far = await at(moves, 0.85)
  await page.mouse.move(...far.abs, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => (await drawn(page)).to, { timeout: 10_000 }).toBeGreaterThan(before)
})

test('the playback bar plays, pauses and scrubs by time', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop layout')
  await sliced(page)
  const dock = page.getByRole('group', { name: 'Layers and moves' })
  const time = page.locator('#pv-time')
  const total = Number(await time.getAttribute('max'))
  expect(total).toBeGreaterThan(60)
  // Scrubbing the time slider lands on a matching layer and puts the toolhead at the cut.
  await time.focus()
  await page.keyboard.press('Home')
  await expect.poll(async () => (await drawn(page)).hi).toBe(0)
  // Tool changes get a set share of the track (CHANGE_SHARE), so half the print time is not half the track: the
  // reference plate's filament change would put half the track a few layers past it. Ask the app where half the time sits.
  const half = await page.evaluate((t) => (window as unknown as { __pv: { track(time: number): number } }).__pv.track(t / 2), total)
  await page.locator('#pv-time').evaluate((el: HTMLInputElement, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(el, String(v))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, Math.round(half))
  await expect.poll(async () => (await drawn(page)).hi).toBeGreaterThan(50)
  const mid = await page.evaluate(() => (window as unknown as { __vp: { toolpaths: { head: { visible: boolean } } } }).__vp.toolpaths.head.visible)
  expect(mid).toBe(true)
  // Play from the start, see it advance, then pause. 100 times, the fastest speed, passes the first layers within a few
  // seconds and leaves the end far off, so the pause always lands mid-print.
  await dock.getByRole('radio', { name: '100 times real time' }).click()
  await time.focus()
  await page.keyboard.press('Home')
  await dock.getByRole('button', { name: 'Play print' }).click()
  await expect(dock.getByRole('button', { name: 'Pause playback' })).toBeVisible()
  await expect.poll(async () => (await drawn(page)).hi, { timeout: 20_000 }).toBeGreaterThan(3)
  await dock.getByRole('button', { name: 'Pause playback' }).click()
  // Pause stops the playback at once: the time slider holds its value. (Measured alone, the drawn range holds from the first
  // frame too; under a full parallel run with software WebGL one render can take longer than a poll.)
  const held = await time.inputValue()
  await page.waitForTimeout(800)
  expect(await time.inputValue()).toBe(held)
  // The viewport then settles on the paused range: it stops changing across three polls in a row.
  let last = (await drawn(page)).to
  let still = 0
  await expect
    .poll(async () => {
      const now = (await drawn(page)).to
      still = now === last ? still + 1 : 0
      last = now
      return still >= 3
    }, { intervals: [300], timeout: 15_000 })
    .toBe(true)
  await expect(dock.getByRole('button', { name: 'Play print' })).toBeVisible()
})

test('the layer strip is a vertical slider with two handles', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop layout')
  await sliced(page)
  const top = page.getByRole('slider', { name: 'Top layer' })
  const bottom = page.getByRole('slider', { name: 'Bottom layer' })
  const n = Number(await top.getAttribute('aria-valuemax'))
  await expect(top).toHaveAttribute('aria-valuenow', String(n))
  await top.focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('PageDown')
  await expect(top).toHaveAttribute('aria-valuenow', String(n - 11))
  await expect.poll(async () => (await drawn(page)).hi).toBe(n - 12)
  // The bottom handle hides the lower layers.
  await bottom.focus()
  await page.keyboard.press('PageUp')
  await expect(bottom).toHaveAttribute('aria-valuenow', '11')
  await expect.poll(async () => (await drawn(page)).from).toBeGreaterThan(0)
  // Dragging the top handle to the middle of the track lands near the middle layer.
  const box = (await page.locator('.ltrack').boundingBox())!
  const hb = (await top.boundingBox())!
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.5, { steps: 6 })
  await page.mouse.up()
  const mid = Number(await top.getAttribute('aria-valuenow'))
  expect(Math.abs(mid - n / 2)).toBeLessThan(n * 0.15)
  // Clicking the track jumps the nearest handle.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.1)
  expect(Number(await top.getAttribute('aria-valuenow'))).toBeGreaterThan(n * 0.8)
})
