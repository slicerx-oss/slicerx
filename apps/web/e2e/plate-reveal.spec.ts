// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate reveal plays on a window's first plate: the outline traced from the front, a wash, then the grid laid back
// to front. It must end on the plate as it is always drawn, play once per window (a view rebuilt in the same window
// draws the plate at once) and draw at once under reduced motion. The other specs turn it off (fixtures.ts); these turn
// it back on, with `always` so it plays on the runners' software graphics too.
import type { Page } from '@playwright/test'
import { expect, tab, test, viewportReady } from './fixtures'
import { alike, cellsIn, diff, recordFrames, type Frame } from './frames'

/** Past setup, on the plate, with the reveal on; `motion` is the app's own Motion setting. */
const playReveal = (page: Page, motion?: 'reduced') =>
  page.addInitScript((motion) => {
    sessionStorage.setItem('sx-reveal', 'always')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' }, ...(motion ? { motion } : {}) }))
  }, motion)

/** The picture on screen now: a recording starts with it, so a short one is a snapshot. */
async function snapshot(page: Page): Promise<Frame> {
  const stop = await recordFrames(page)
  await page.waitForTimeout(300)
  return (await stop()).at(-1)!
}

test('the plate reveal plays once and ends on the fully drawn plate', async ({ page }, info) => {
  test.slow()
  await playReveal(page)
  await page.goto('./')
  await viewportReady(page)
  const canvas = page.locator('.vp-canvas')
  const stop = await recordFrames(page)
  // It plays: the overlay with the crackles is up while the outline is traced, and gone once the reveal ends.
  await expect(canvas).toHaveAttribute('data-reveal', /waiting|playing|done/)
  await expect(canvas).toHaveAttribute('data-reveal', 'done', { timeout: 20_000 })
  await expect(page.locator('canvas[data-reveal="overlay"]')).toHaveCount(0)
  await page.waitForTimeout(500)
  const frames = await stop()
  const settled = await snapshot(page)
  const view = (await page.locator('.vp').boundingBox())!
  const cells = cellsIn(view, page.viewportSize()!)
  // Some frame during the reveal showed the plate not yet drawn, so it really played.
  const furthest = Math.max(...frames.map((f) => diff(f, settled, cells)))
  expect(furthest, 'the reveal changed the picture before it settled').toBeGreaterThan(1)

  // A later view in the same window (Vault and back builds a new one) draws the plate at once, with no reveal.
  await tab(page, 'feed').click()
  await expect(page.locator('.vp-canvas')).toHaveCount(0)
  await tab(page, 'prepare').click()
  await expect(page.locator('.vp-canvas')).toHaveAttribute('data-reveal', 'off')
  await page.waitForTimeout(2500)
  const again = await snapshot(page)
  await expect(page.locator('canvas[data-reveal="overlay"]')).toHaveCount(0)
  await info.attach('settled', { body: Buffer.from(settled.jpeg, 'base64'), contentType: 'image/jpeg' })
  await info.attach('remounted', { body: Buffer.from(again.jpeg, 'base64'), contentType: 'image/jpeg' })
  // The reveal ends on exactly the plate a view without it draws: outline, grid and no wash left over.
  expect(alike(settled, again, cells), 'the plate after the reveal looks like the plate without it').toBeGreaterThan(0.97)
  expect(diff(settled, again, cells), 'mean gray difference after the reveal').toBeLessThan(3)
})

test('under reduced motion the plate draws at once', async ({ page, isMobile }) => {
  // Settings > Appearance > Motion: Reduced. It also follows the system setting when set to Follow system.
  await playReveal(page, 'reduced')
  await page.goto('./')
  await viewportReady(page)
  await expect(page.locator('.vp-canvas')).toHaveAttribute('data-reveal', 'off')
  // A toast (such as the software graphics note) may arrive in these seconds over the view; it is not the plate.
  await page.addStyleTag({ content: '.sx-toasts { visibility: hidden !important; }' })
  // The plate a moment after the view came up is the plate a few seconds later: nothing was still to draw.
  const first = await snapshot(page)
  await page.waitForTimeout(2500)
  const later = await snapshot(page)
  await expect(page.locator('canvas[data-reveal="overlay"]')).toHaveCount(0)
  // A phone's panels and notes still settle around the view in these seconds, so the picture is compared at desktop width.
  if (isMobile) return
  const cells = cellsIn((await page.locator('.vp').boundingBox())!, page.viewportSize()!)
  expect(alike(first, later, cells), 'the plate is drawn from the start').toBeGreaterThan(0.97)
})
