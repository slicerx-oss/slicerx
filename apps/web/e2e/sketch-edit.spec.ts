// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch's edit tools: Trim (T) shows in red what a click takes off, and trimming two crossing rectangles down to
// their outline leaves one closed profile that extrudes; Extend runs a line on to the next curve; Mirror and Pattern
// add copies from the Select panel.
import { type Page } from '@playwright/test'
import { command, openStudio, pick, sketchAt, toolPanel } from './cad-helpers'
import { expect, test } from './fixtures'

type V2 = [number, number]
type Scene = { paths: { points: V2[]; tone?: string }[]; profiles?: V2[][] }
const scene = (page: Page) => page.evaluate(() => (window as unknown as { __vp: { sketchLayer: { scene: Scene | null } } }).__vp.sketchLayer.scene)
const profiles = async (page: Page) => (await scene(page))?.profiles?.length ?? -1
const curves = async (page: Page) => (await scene(page))?.paths.filter((p) => p.tone !== 'soft' && p.tone !== 'grid').length ?? -1
// the band a hover draws, and its tone
const band = (page: Page) =>
  page.evaluate(() => {
    const l = (window as unknown as { __vp: { sketchLayer: { band: { visible: boolean; material: unknown }; cutMat: unknown } } }).__vp.sketchLayer
    return l.band.visible ? (l.band.material === l.cutMat ? 'cut' : 'normal') : 'none'
  })

const extents = (page: Page) =>
  page.evaluate(() => {
    const sx = (window as unknown as { __sx: { getState(): { plate: { parts: { positions: ArrayLike<number> }[] }[] } } }).__sx
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (const part of sx.getState().plate[0]?.parts ?? [])
      for (let i = 0; i + 2 < part.positions.length; i += 3)
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k]!, part.positions[i + k]!)
          hi[k] = Math.max(hi[k]!, part.positions[i + k]!)
        }
    return lo.map((v, k) => Math.round((hi[k]! - v) * 100) / 100).sort((a, b) => a - b)
  })

async function sketchOnBed(page: Page) {
  await openStudio(page)
  await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  await page.locator('.sx-tab[data-mode="design"]').click()
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('Click an origin plane')
  await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, bed: [100, 100] })
  await expect(panel).toContainText('The bed')
  return panel
}

test('T trims two crossing rectangles to their outline, and the one profile left extrudes', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  test.slow()
  const panel = await sketchOnBed(page)
  await page.locator('body').press('r')
  await sketchAt(page, 'click', [10, 10])
  await sketchAt(page, 'click', [20, 20])
  await sketchAt(page, 'click', [15, 15])
  await sketchAt(page, 'click', [25, 25])
  await expect.poll(() => profiles(page)).toBe(2)

  await page.locator('body').press('t')
  await expect(panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Trim' })).toHaveAttribute('aria-checked', 'true')
  await expect(panel).toContainText('Click the piece of a curve to take off')
  // a hover shows the piece wide and red; off the curves nothing shows
  await sketchAt(page, 'hover', [20, 18])
  await expect.poll(() => band(page)).toBe('cut')
  await sketchAt(page, 'hover', [40, 40])
  await expect.poll(() => band(page)).toBe('none')

  // each corner inside the other rectangle goes, a side at a time
  for (const at of [[20, 18], [18, 20], [18, 15], [15, 18]] as V2[]) {
    const before = await scene(page)
    await sketchAt(page, 'click', at)
    await expect.poll(async () => JSON.stringify(await scene(page))).not.toBe(JSON.stringify(before))
  }
  // eight sides of one closed outline
  await expect.poll(() => profiles(page)).toBe(1)
  await expect.poll(() => curves(page)).toBe(8)
  await expect(panel.locator('.cad-issues')).toHaveCount(0)

  await panel.locator('#sk-dist').fill('4')
  await panel.getByRole('button', { name: 'Extrude', exact: true }).click()
  await expect.poll(async () => await page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: unknown[] } } }).__sx.getState().plate.length), { timeout: 30_000 }).toBe(1)
  await expect.poll(() => extents(page)).toEqual([4, 15, 15])
})

test('Extend runs a line on to the next one; Mirror and Pattern add copies of a loop', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  test.slow()
  const panel = await sketchOnBed(page)
  // a short level line and an upright one past its end
  await page.locator('body').press('l')
  await sketchAt(page, 'click', [10, 10])
  await sketchAt(page, 'click', [14, 10])
  await page.locator('body').press('Escape')
  await sketchAt(page, 'click', [30, 0])
  await sketchAt(page, 'click', [30, 30])
  await page.locator('body').press('Escape')

  await page.locator('body').press('t')
  await panel.getByRole('radio', { name: 'Extend' }).click()
  await sketchAt(page, 'hover', [13.5, 10])
  await expect.poll(() => band(page)).toBe('normal')
  await sketchAt(page, 'click', [13.5, 10])
  await expect.poll(async () => (await scene(page))?.paths.some((p) => p.points.some(([x, y]) => Math.abs(x - 30) < 1e-6 && Math.abs(y - 10) < 1e-6))).toBe(true)

  // a circle mirrored across the upright line, then patterned along
  await page.locator('body').press('c')
  await sketchAt(page, 'click', [20, 20])
  await sketchAt(page, 'click', [22, 20])
  await expect.poll(() => profiles(page)).toBe(1)
  await panel.getByRole('radio', { name: 'Select' }).click()
  await sketchAt(page, 'click', [22, 20])
  await panel.getByRole('button', { name: 'Mirror', exact: true }).click()
  await expect(panel).toContainText('Click the straight line to mirror across')
  await sketchAt(page, 'click', [30, 25])
  await expect.poll(() => profiles(page)).toBe(2)
  await expect(panel).not.toContainText('Click the straight line to mirror across')
  // the copy's center is at x 40, across the line from the first
  const centers = async () => ((await scene(page))?.profiles ?? []).map((r) => Math.round((r.reduce((t, [x]) => t + x, 0) / r.length) * 100) / 100).sort((a, b) => a - b)
  await expect.poll(centers).toEqual([20, 40])

  await panel.locator('#sk-copies').fill('3')
  await panel.locator('#sk-step-x').fill('0')
  await panel.locator('#sk-step-y').fill('-6')
  await panel.getByRole('button', { name: 'Add copies', exact: true }).click()
  await expect.poll(() => profiles(page)).toBe(4)

  // round a clicked point, with the count changed just before: four in all, so three more
  await sketchAt(page, 'click', [22, 20])
  await panel.getByRole('radiogroup', { name: 'Copy kind' }).getByRole('radio', { name: 'Circle' }).click()
  await panel.locator('#sk-copies').fill('4')
  await panel.getByRole('button', { name: 'Add copies round a point' }).click()
  await expect(panel).toContainText('Click the point to pattern round')
  await sketchAt(page, 'click', [16, 24])
  await expect.poll(() => profiles(page)).toBe(7)
})
