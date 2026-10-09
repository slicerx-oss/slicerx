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
  // From now on, on every frame the view draws: how many objects it holds (a slow renderer draws few frames, but each
  // one is seen), and where the right pane is.
  await page.evaluate(() => {
    const w = window as unknown as { __vp: Vp & { renderFrame(...a: unknown[]): unknown }; __least: number; __panes: number[]; __drawn: number }
    const vp = w.__vp
    w.__least = vp.objects.size
    w.__panes = []
    w.__drawn = 0
    const render = vp.renderFrame.bind(vp)
    vp.renderFrame = (...a: unknown[]) => {
      const r = render(...a)
      w.__drawn++
      w.__least = Math.min(w.__least, vp.objects.size)
      w.__panes.push(Math.round(document.querySelector('.pane[data-side="right"]')?.getBoundingClientRect().left ?? -1))
      return r
    }
  })
  for (let i = 0; i < 10 && seen.length === 0; i++) {
    await page.keyboard.press('ControlOrMeta+o')
    await page.waitForTimeout(500)
  }
  await seen[0]!.setFiles(fileURLToPath(new URL('../../../packages/core/bench/models/x-mark.stl', import.meta.url)))
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { plateLoading: boolean; plate: { name: string }[] } } }).__sx.getState()).then((s) => !s.plateLoading && s.plate.some((p) => /x-mark/i.test(p.name))), { timeout: 60_000 }).toBe(true)
  await page.waitForTimeout(500)
  const seenNow = await page.evaluate(() => {
    const w = window as unknown as { __least: number; __panes: number[]; __drawn: number }
    return { least: w.__least, panes: w.__panes, drawn: w.__drawn }
  })
  expect(seenNow.drawn).toBeGreaterThan(0)
  // the view always held a model: the old one until the new one swapped in
  expect(seenNow.least).toBeGreaterThan(0)
  // the right pane never moved
  expect(new Set(seenNow.panes).size).toBeLessThanOrEqual(1)
})

test('ten opens in a row leave no held frame, canvas or texture behind', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop open')
  test.slow()
  const seen: FileChooser[] = []
  page.on('filechooser', (c) => seen.push(c))
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' }, autoSlice: false }))
  })
  await page.goto('./')
  await plateReady(page)
  await viewportReady(page)
  const file = fileURLToPath(new URL('../../../packages/core/bench/models/x-mark.stl', import.meta.url))
  type Mem = { renderer: { info: { memory: { textures: number; geometries: number } } } }
  const memory = () => page.evaluate(() => ({ ...(window as unknown as { __vp: Mem }).__vp.renderer.info.memory, overlays: document.querySelectorAll('canvas[data-crossfade]').length }))
  const open = async () => {
    const before = seen.length
    for (let i = 0; i < 10 && seen.length === before; i++) {
      await page.keyboard.press('ControlOrMeta+o')
      await page.waitForTimeout(300)
    }
    await seen[before]!.setFiles(file)
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { plateLoading: boolean; plate: { name: string }[] } } }).__sx.getState()).then((s) => !s.plateLoading && s.plate.some((p) => /x-mark/i.test(p.name))), { timeout: 60_000 }).toBe(true)
    await page.waitForTimeout(400)
  }
  // the first open settles what a plate with x-mark holds; nine more must not add to it. Objects that leave the plate
  // stay built for 10 s in case they come back, so both counts are taken once that has passed.
  await open()
  await page.waitForTimeout(11_000)
  const base = await memory()
  for (let i = 0; i < 9; i++) await open()
  // the last fade's copy goes once it has faded (a slow renderer takes a few frames)
  await expect.poll(async () => (await memory()).overlays).toBe(0)
  await page.waitForTimeout(11_000)
  const after = await memory()
  // the view's own caches move by one or two; nine opens' worth of held frames or meshes would be far more
  expect(after.geometries).toBeLessThanOrEqual(base.geometries + 2)
  expect(after.textures).toBeLessThanOrEqual(base.textures + 2)
})

test('a model added to the plate fades in beside the others, which stay as they are', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop open')
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' }, autoSlice: false }))
  })
  const seen: FileChooser[] = []
  page.on('filechooser', (c) => seen.push(c))
  await page.goto('./')
  await plateReady(page)
  await viewportReady(page)
  type Part = { mesh: { material: { opacity: number; transparent: boolean } } }
  type FadeVp = { objects: Map<string, { parts: Part[] }>; renderFrame(...a: unknown[]): unknown }
  // On every drawn frame: the lowest opacity among the objects there before, and whether a new one was see-through.
  const ids = await page.evaluate(() => {
    const w = window as unknown as { __vp: FadeVp; __old: number; __faded: boolean }
    const vp = w.__vp
    const old = new Set(vp.objects.keys())
    w.__old = 1
    w.__faded = false
    const render = vp.renderFrame.bind(vp)
    vp.renderFrame = (...a: unknown[]) => {
      for (const [id, o] of vp.objects) for (const p of o.parts) {
        if (old.has(id)) w.__old = Math.min(w.__old, p.mesh.material.opacity)
        else if (p.mesh.material.transparent && p.mesh.material.opacity < 1) w.__faded = true
      }
      return render(...a)
    }
    return [...old]
  })
  expect(ids.length).toBeGreaterThan(0)
  await page.getByTestId('objects-add-model').click()
  await expect.poll(() => seen.length).toBe(1)
  await seen[0]!.setFiles(fileURLToPath(new URL('../../../packages/core/bench/models/x-mark.stl', import.meta.url)))
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { plateLoading: boolean; plate: { name: string }[] } } }).__sx.getState()).then((s) => !s.plateLoading && s.plate.some((p) => /x-mark/i.test(p.name))), { timeout: 60_000 }).toBe(true)
  await page.waitForTimeout(600)
  const r = await page.evaluate(() => {
    const w = window as unknown as { __vp: FadeVp; __old: number; __faded: boolean }
    return { old: w.__old, faded: w.__faded, now: [...w.__vp.objects.values()].flatMap((o) => o.parts).map((p) => p.mesh.material.opacity) }
  })
  // the objects already there never dimmed; the new one drew see-through on its way in, and everything ends whole
  expect(r.old).toBe(1)
  expect(r.faded).toBe(true)
  // and everything ends whole (a slow renderer takes a few frames to get there)
  await expect.poll(() => page.evaluate(() => Math.min(...[...(window as unknown as { __vp: FadeVp }).__vp.objects.values()].flatMap((o) => o.parts).map((p) => p.mesh.material.opacity)))).toBe(1)
})
