// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A delta printer's round bed, on the FLSUN V400 (a 300 mm circle): the bed reads and draws as a circle, Fill bed and
// Arrange all keep every part inside it, and the off-bed check judges a part by the circle, not its square box. A part
// just past the rim on the diagonal sits well inside the box, so only the circle flags it. Everything is read from the
// app's state and the viewport's own outline settings, never from pixels.
import { type Page } from '@playwright/test'
import { closeSheet, expect, openSheet, openTransform, plateReady, test, viewportReady } from './fixtures'

const V400 = { id: 'e2e-v400', name: 'Delta V400', profileId: 'flsun-v400', vendor: 'FLSUN', model: 'V400', nozzleCount: 1 }

interface Entry { id: string; transform: number[]; parts: { positions: ArrayLike<number> }[] }
interface Sx { getState(): { plate: Entry[]; bed: { widthMm: number; depthMm: number; heightMm: number; round?: boolean } } }
interface Vp { stage: { outline: { uniforms: { rnd: { value: number }; alert: { value: number } } } | null } }

async function open(page: Page): Promise<void> {
  await page.addInitScript((p) => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, autoSliceBySize: false, handPrinters: [p], printerId: p.id }))
  }, V400)
  await page.goto('./')
  await plateReady(page)
  await viewportReady(page)
  // The printer's profile loads after the first plate; the bed turns round once it has.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().bed.round === true)).toBe(true)
}

/** Each object's footprint on the bed: how far its farthest point reaches from the bed's center, and its box. */
function footprints(page: Page): Promise<{ id: string; reach: number; min: [number, number]; max: [number, number] }[]> {
  return page.evaluate(() => {
    const s = (window as unknown as { __sx: Sx }).__sx.getState()
    const cx = s.bed.widthMm / 2
    const cy = s.bed.depthMm / 2
    return s.plate.map((e) => {
      const m = e.transform
      let reach = 0
      const min: [number, number] = [Infinity, Infinity]
      const max: [number, number] = [-Infinity, -Infinity]
      for (const part of e.parts) for (let i = 0; i + 2 < part.positions.length; i += 3) {
        const px = part.positions[i]!, py = part.positions[i + 1]!, pz = part.positions[i + 2]!
        const x = m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!
        const y = m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!
        reach = Math.max(reach, Math.hypot(x - cx, y - cy))
        min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y)
        max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y)
      }
      return { id: e.id, reach, min, max }
    })
  })
}

async function expectInsideCircle(page: Page): Promise<void> {
  const r = await page.evaluate(() => Math.min((window as unknown as { __sx: Sx }).__sx.getState().bed.widthMm, (window as unknown as { __sx: Sx }).__sx.getState().bed.depthMm) / 2)
  for (const f of await footprints(page)) expect(f.reach, `object ${f.id} reaches ${f.reach.toFixed(2)} mm from the center of a ${r} mm radius bed`).toBeLessThanOrEqual(r + 0.01)
  await expect(page.locator('[data-testid="object-warning"][data-kind="off-bed"]')).toHaveCount(0)
}

test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, 'Desktop: a phone has no plate tools or transform fields')
})

test('the FLSUN V400 bed reads and draws as a 300 mm circle', async ({ page }) => {
  await open(page)
  const bed = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().bed)
  expect(bed.round).toBe(true)
  expect(bed.widthMm).toBeCloseTo(300, 0)
  expect(bed.depthMm).toBeCloseTo(300, 0)
  // The viewport draws the outline, grid and fill by the circle (its round setting), with no off-bed alert.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __vp: Vp }).__vp.stage.outline?.uniforms.rnd.value)).toBe(1)
  expect(await page.evaluate(() => (window as unknown as { __vp: Vp }).__vp.stage.outline?.uniforms.alert.value)).toBe(0)
})

test('Fill bed and Arrange all keep every part inside the circle', async ({ page }) => {
  await open(page)
  await openSheet(page)
  const objs = page.locator('.objs > li')
  await expect(objs).toHaveCount(1)
  await openTransform(page)
  await page.getByRole('button', { name: 'Fill bed' }).click()
  await expect.poll(() => objs.count()).toBeGreaterThan(4)
  await expect(page.locator('html')).not.toHaveAttribute('data-sx-busy')
  await expectInsideCircle(page)
  const filled = await objs.count()
  await closeSheet(page)
  await page.getByRole('toolbar', { name: 'Plate tools' }).getByRole('button', { name: 'Arrange all' }).click()
  await expect(page.locator('html')).not.toHaveAttribute('data-sx-busy')
  await expect(objs).toHaveCount(filled)
  await expectInsideCircle(page)
})

test('the off-bed check flags a part just past the rim and clears it just inside', async ({ page }) => {
  await open(page)
  await openSheet(page)
  await openTransform(page)
  const pos = page.getByRole('group', { name: 'Position' })
  // Where the object's translation goes, on the bed's front right diagonal, for its farthest point to reach `target` mm
  // from the center.
  const place = (target: number) => page.evaluate((target) => {
    const s = (window as unknown as { __sx: Sx }).__sx.getState()
    const e = s.plate[0]!
    const m = e.transform
    const offsets: [number, number][] = []
    for (const part of e.parts) for (let i = 0; i + 2 < part.positions.length; i += 3) {
      const px = part.positions[i]!, py = part.positions[i + 1]!, pz = part.positions[i + 2]!
      offsets.push([m[0]! * px + m[4]! * py + m[8]! * pz, m[1]! * px + m[5]! * py + m[9]! * pz])
    }
    const u = Math.SQRT1_2
    const reach = (d: number) => Math.max(...offsets.map(([x, y]) => Math.hypot(d * u + x, -d * u + y)))
    let lo = 0
    let hi = target
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2
      if (reach(mid) < target) lo = mid
      else hi = mid
    }
    return [s.bed.widthMm / 2 + lo * u, s.bed.depthMm / 2 - lo * u]
  }, target)
  const moveTo = async ([x, y]: number[]) => {
    for (const [axis, v] of [['X', x!], ['Y', y!]] as const) {
      const field = pos.getByRole('textbox', { name: new RegExp(axis) })
      await field.fill(v.toFixed(2))
      await field.press('Enter')
      await expect.poll(async () => Math.abs(Number(await field.inputValue()) - v)).toBeLessThan(0.01)
    }
  }
  const warning = page.locator('[data-testid="object-warning"][data-kind="off-bed"]')
  const alert = () => page.evaluate(() => (window as unknown as { __vp: Vp }).__vp.stage.outline?.uniforms.alert.value)

  // 1 mm past the rim: flagged, in the list and on the bed outline.
  await moveTo(await place(151))
  await expect(warning).toHaveCount(1)
  await expect(warning).toHaveAttribute('aria-label', /Off the bed/)
  await expect.poll(alert).toBe(1)
  // The part's box is well inside the 300 mm square, so a rectangle test would have passed it.
  const [past] = await footprints(page)
  expect(past!.reach).toBeGreaterThan(150)
  expect(past!.min[0]).toBeGreaterThan(0)
  expect(past!.min[1]).toBeGreaterThan(0)
  expect(past!.max[0]).toBeLessThan(300)
  expect(past!.max[1]).toBeLessThan(300)

  // Just inside the rim: the part itself is on the bed.
  await moveTo(await place(149))
  await expect(page.locator('[data-testid="object-warning"][aria-label*="Off the bed"]')).toHaveCount(0)
  const [inside] = await footprints(page)
  expect(inside!.reach).toBeLessThan(150)
})
