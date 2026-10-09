// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The first launch draws the plate as soon as setup closes: after Skip, use defaults, the 3D view shows the bed and the
// example plate within a moment and stays drawn while the first background slice runs. Every composited frame is
// checked (e2e/frames.ts): the plate must show within a few seconds of the view coming up and never go empty again.
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { cellsIn, GL_SLOW, recordFrames, spread } from './frames'

test('the plate is drawn right after setup is skipped on a fresh install', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await page.goto('./')
  // Setup opens on its first step, the theme; Skip, use defaults closes it from there.
  await expect(page.getByRole('heading', { name: 'Pick a theme' })).toBeVisible({ timeout: 120_000 })
  const stop = await recordFrames(page)
  await page.getByRole('button', { name: 'Skip, use defaults' }).click()
  await expect(page.locator('.obj-name', { hasText: 'Layered X' })).toBeVisible({ timeout: 60_000 })
  // The 3D view is up from here (the app's own ready mark). The screencast stamps frames with the browser's clock, so
  // this is timed on it too. A slow shared runner takes its time to get here; nothing below counts that time.
  await page.locator('html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: 120_000 })
  const up = await page.evaluate(() => (performance.timeOrigin + performance.now()) / 1000)
  // Long enough for the first frames and the first background slice to start and land (longer where drawing is slow).
  const watchS = 8 * GL_SLOW
  await page.waitForTimeout(watchS * 1000)
  const view = await page.locator('.vp').boundingBox()
  const frames = await stop()
  expect(view, 'the 3D view is on screen').not.toBeNull()
  const cells = cellsIn(view!, page.viewportSize()!)
  // The plate drawn: the bed grid and the model, far from one flat color. It must show within a few seconds of the view
  // coming up (on the Mac it stayed empty until Fit), and once shown it must not go empty again.
  // The screencast sends a frame only when the picture changes, so the picture at the moment the view came up is the
  // last frame before it.
  const before = [...frames].reverse().find((f) => f.t < up)
  const pool = [...(before ? [before] : []), ...frames.filter((f) => f.t >= up)]
  const shown = pool.find((f) => spread(f, cells) > 8)
  expect(shown, `the plate never showed in the ${watchS} s after the view came up (last spread ${spread(frames.at(-1)!, cells).toFixed(1)})`).toBeTruthy()
  expect(Math.max(0, shown!.t - up), 'seconds from the view coming up to the plate showing').toBeLessThan(5 * GL_SLOW)
  const drawn = spread(shown!, cells)
  const empty = frames.filter((f) => f.t > shown!.t && spread(f, cells) < drawn * 0.35)
  expect(empty.map((f) => `${(f.t - up).toFixed(2)} s after the view came up: spread ${spread(f, cells).toFixed(1)}`), `the view went empty after it showed the plate (drawn ${drawn.toFixed(1)})`).toEqual([])
})

type Sx = { getState(): { slice: { status: string; stale?: boolean }; preview: unknown; plate: { name: string }[]; workspace: string; modelMode: string; sliceLook: string } }
type Vp = { stats(): { segments: number } }

test('a model sliced while setup is open shows its toolpaths in place after setup closes', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await page.addInitScript(() => localStorage.setItem('slicerx.debug', '1'))
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Pick a theme' })).toBeVisible({ timeout: 120_000 })
  // With setup still open: open a model through the command bar; the background slice runs behind setup.
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('Open a model file')
  const chooser = page.waitForEvent('filechooser')
  await page.keyboard.press('Enter')
  await (await chooser).setFiles(fileURLToPath(new URL('../../../packages/core/bench/models/x-mark.stl', import.meta.url)))
  await expect
    .poll(() => page.evaluate(() => { const s = (window as unknown as { __sx?: Sx }).__sx?.getState(); return !!s && s.plate.some((o) => /x-mark/i.test(o.name)) && s.slice.status === 'done' && !s.slice.stale && s.preview !== null }), { timeout: 120_000 })
    .toBe(true)
  await page.getByRole('button', { name: 'Skip, use defaults' }).click()
  // The 3D view mounts only now, with the slice already done. Slice shows the toolpaths in place.
  await page.locator('html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: 120_000 })
  const look = await page.evaluate(() => { const s = (window as unknown as { __sx: Sx }).__sx.getState(); return `${s.workspace} ${s.modelMode} ${s.sliceLook}` })
  expect(look, 'the plate opens in Slice with the toolpaths look').toBe('prepare slice toolpaths')
  // The bug: the shader warm-up swapped its own bead in over the slice set before the first frame, then cleared it,
  // so the view showed only the bed until the next slice. The toolpaths must still be in the view once it settles.
  await page.waitForTimeout(2000)
  const segments = await page.evaluate(() => (window as unknown as { __vp?: Vp }).__vp?.stats().segments ?? -1)
  // The picture goes with the run, to look at.
  await page.locator('.vp').screenshot({ path: info.outputPath('after-setup.png') })
  expect(segments, 'toolpath segments in the view after setup closes').toBeGreaterThan(0)
})
