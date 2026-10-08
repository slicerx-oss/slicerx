// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The first launch draws the plate as soon as setup closes: after Skip, use defaults, the 3D view shows the bed and the
// example plate within a moment and stays drawn while the first background slice runs. Every composited frame is
// checked (e2e/frames.ts); a view still empty a second after the plate loaded fails.
import { expect, test } from '@playwright/test'
import { cellsIn, recordFrames, spread } from './frames'

test('the plate is drawn right after setup is skipped on a fresh install', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Find your printer' })).toBeVisible({ timeout: 120_000 })
  const stop = await recordFrames(page)
  await page.getByRole('button', { name: 'Skip, use defaults' }).click()
  await expect(page.locator('.obj-name', { hasText: 'Layered X' })).toBeVisible({ timeout: 60_000 })
  // The plate is loaded from here. The screencast stamps frames with the browser's clock, so this is timed on it too.
  const loaded = await page.evaluate(() => (performance.timeOrigin + performance.now()) / 1000)
  // Long enough for the first background slice to start and land.
  await page.waitForTimeout(6000)
  const view = await page.locator('.vp').boundingBox()
  const frames = await stop()
  expect(view, 'the 3D view is on screen').not.toBeNull()
  const cells = cellsIn(view!, page.viewportSize()!)
  // The finished picture has the bed grid and the model: far from one flat color.
  const drawn = spread(frames.at(-1)!, cells)
  expect(drawn).toBeGreaterThan(8)
  const late = frames.filter((f) => f.t > loaded + 1 && spread(f, cells) < drawn * 0.35)
  expect(late.map((f) => `${(f.t - loaded).toFixed(2)} s after the plate loaded: spread ${spread(f, cells).toFixed(1)}`), `the view was empty with the plate loaded (drawn ${drawn.toFixed(1)})`).toEqual([])
})
