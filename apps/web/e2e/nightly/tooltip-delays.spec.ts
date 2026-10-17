// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Feature tooltips and their timing (moved from plate.spec.ts): a tip shows with its key after the 450 ms delay, hands
// over to a neighbor's quickly, explains a disabled tool, and stays off in Settings until ? pins it. The delay is
// measured in the page, so a loaded runner can skew it: this runs at night only.
import { expect, plateReady, test } from '../fixtures'

test('feature tooltips show with their key, hand over quickly, explain a disabled tool, and switch off in Settings', { tag: '@nightly' }, async ({ page, isMobile }) => {
  test.skip(isMobile, 'Touch uses long press')
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', cadTools: true }))
  })
  await page.goto('./')
  await plateReady(page)
  const tip = page.locator('#sx-tip')
  const move = page.getByRole('toolbar', { name: 'Plate tools' }).getByRole('button', { name: 'Move' })
  const rotate = page.getByRole('toolbar', { name: 'Plate tools' }).getByRole('button', { name: 'Rotate' })
  // Time from the pointer arriving to the tip existing, measured in the page.
  await page.evaluate(() => {
    const w = window as unknown as { __tip: { over: number; shown: number } }
    w.__tip = { over: 0, shown: 0 }
    document.addEventListener('pointerover', () => { if (!w.__tip.over) w.__tip.over = performance.now() }, true)
    new MutationObserver(() => {
      if (document.getElementById('sx-tip') && !w.__tip.shown) w.__tip.shown = performance.now()
    }).observe(document.body, { childList: true, subtree: true })
  })
  const delay = () => page.evaluate(() => { const t = (window as unknown as { __tip: { over: number; shown: number } }).__tip; return t.shown - t.over })
  await move.hover()
  await expect(tip).toBeVisible()
  await expect(tip).toContainText('Drag the model across the plate.')
  await expect(tip.locator('.sx-tip-key')).toHaveText('M')
  // Never earlier than the spec's 450 ms. A loaded machine can be much later, so there is no upper bound here.
  const cold = await delay()
  expect(cold).toBeGreaterThanOrEqual(430)
  // A neighbor right after takes the quick hand over. Its 60 ms is checked in the unit test with a fake clock: here a
  // frame of the software-drawn 3D view can hold the page for a second or more, longer than either delay.
  await rotate.hover()
  await expect(tip).toContainText('Drag a ring to turn the model around that axis.')
  await expect(tip).toHaveAttribute('data-warm', 'true')
  await page.keyboard.press('Escape')
  await expect(tip).toHaveCount(0)
  // A disabled tool still explains itself.
  const drop = page.getByRole('toolbar', { name: 'Plate tools' }).getByRole('button', { name: 'Undo' })
  await expect(drop).toHaveAttribute('aria-disabled', 'true')
  await drop.hover()
  await expect(tip).toContainText('Nothing to undo.')
  // ? pins the tip under the pointer even when tips are off.
  await page.mouse.move(5, 5)
  await expect(tip).toHaveCount(0)
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('slicerx.prefs.v1') ?? '{}') as Record<string, unknown>
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ ...raw, tooltips: { enabled: false, media: true } }))
  })
  // The tip text arrives late, as on a busy machine: with tips off it still loads after startup, so ? finds it.
  await page.route(/\/tips-[^/]+\.js$/, async (route) => {
    await new Promise((done) => setTimeout(done, 600))
    await route.continue()
  })
  await page.reload()
  await expect(move).toBeVisible()
  await move.hover()
  await page.waitForTimeout(700)
  await expect(tip).toHaveCount(0)
  await page.keyboard.press('Shift+?')
  await expect(tip).toContainText('Move')
})
