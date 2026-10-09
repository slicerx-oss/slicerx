// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opening a model over the one on the plate never shows an empty plate in between: the 3D view keeps the old scene
// until the new model's first frame and crossfades to it, and the panes keep their place.
import { fileURLToPath } from 'node:url'
import { type FileChooser } from '@playwright/test'
import { expect, plateReady, test, viewportReady } from './fixtures'

type Vp = { objects: Map<string, unknown> }

test('opening a model over the example plate never draws an empty plate', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop open')
  const seen: FileChooser[] = []
  page.on('filechooser', (c) => seen.push(c))
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  await viewportReady(page)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __vp: Vp }).__vp.objects.size)).toBeGreaterThan(0)
  // Every frame from now on: how many objects the view holds, and where the right pane is.
  await page.evaluate(() => {
    const w = window as unknown as { __vp: Vp; __seen: { n: number; pane: number }[] }
    w.__seen = []
    const pane = () => document.querySelector('.pane[data-side="right"]')?.getBoundingClientRect().left ?? -1
    const tick = () => {
      w.__seen.push({ n: w.__vp.objects.size, pane: Math.round(pane()) })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  for (let i = 0; i < 10 && seen.length === 0; i++) {
    await page.keyboard.press('ControlOrMeta+o')
    await page.waitForTimeout(500)
  }
  await seen[0]!.setFiles(fileURLToPath(new URL('../../../packages/core/bench/models/x-mark.stl', import.meta.url)))
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { plateLoading: boolean; plate: { name: string }[] } } }).__sx.getState()).then((s) => !s.plateLoading && s.plate.some((p) => /x-mark/i.test(p.name))), { timeout: 60_000 }).toBe(true)
  await page.waitForTimeout(500)
  const frames = await page.evaluate(() => (window as unknown as { __seen: { n: number; pane: number }[] }).__seen)
  expect(frames.length).toBeGreaterThan(10)
  // the view always held a model: the old one until the new one swapped in
  expect(Math.min(...frames.map((f) => f.n))).toBeGreaterThan(0)
  // the right pane never moved
  expect(new Set(frames.map((f) => f.pane)).size).toBe(1)
})
