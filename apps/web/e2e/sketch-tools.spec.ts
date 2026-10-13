// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch tool families and the ways to draw each: keys pick line, rectangle and circle as in Fusion, the row
// below the families picks the variant, and each tool's shape reaches the timeline when the sketch is finished.
import { type Page } from '@playwright/test'
import { command, openStudio, pick, sketchAt, toolPanel } from './cad-helpers'
import { expect, test } from './fixtures'

type Loop = { type?: 'circle'; start?: [number, number]; segments?: { type: 'line' | 'arc' }[]; construction?: true }
const loops = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __sx: { getState(): { timeline: { items: { kind: string; loops?: unknown[] }[] } } } }).__sx.getState()
    return (s.timeline.items.find((i) => i.kind === 'sketch')?.loops ?? []) as Loop[]
  })

test('keys and the variant row draw a circle, a 3-point rectangle, a pentagon, a slot and a tangent arc', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  test.slow()
  await openStudio(page)
  await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  await page.locator('.sx-tab[data-mode="design"]').click()
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('Click an origin plane')
  await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, bed: [100, 100] })
  await expect(panel).toContainText('The bed')
  const families = panel.getByRole('radiogroup', { name: 'Drawing tool' })
  const variants = panel.getByRole('radiogroup', { name: 'Draw it by' })
  const dof = panel.getByRole('status').filter({ hasText: /degrees of freedom|defined/ })
  // each shape changes the freedom count; waiting on it keeps the next step from racing the last render
  const line = panel.getByTestId('sketch-dof')
  const freedom = async () => ((await line.count()) ? Number(await line.getAttribute('data-dof')) : -1)
  const shape = async (pts: [number, number][]) => {
    const before = await freedom()
    for (const p of pts) await sketchAt(page, 'click', p)
    await expect.poll(freedom).not.toBe(before)
  }

  // C: a center circle
  await page.locator('body').press('c')
  await expect(families.getByRole('radio', { name: 'Circle' })).toHaveAttribute('aria-checked', 'true')
  await shape([[40, 40], [45, 40]])
  await expect(dof).toBeVisible()

  // R, then 3-point: an edge and a width
  await page.locator('body').press('r')
  await expect(variants.getByRole('radio', { name: '2-point' })).toHaveAttribute('aria-checked', 'true')
  await variants.getByRole('radio', { name: '3-point' }).click()
  await expect(variants.getByRole('radio', { name: '3-point' })).toHaveAttribute('aria-checked', 'true')
  await shape([[80, 40], [100, 40], [90, 50]])

  // a pentagon by its edge
  await families.getByRole('radio', { name: 'Polygon' }).click()
  await variants.getByRole('radio', { name: 'Edge' }).click()
  await panel.locator('#sk-sides').fill('5')
  await expect(panel.locator('#sk-sides')).toHaveValue('5')
  await shape([[130, 40], [140, 40], [135, 45]])

  // a slot by its overall length
  await families.getByRole('radio', { name: 'Slot' }).click()
  await variants.getByRole('radio', { name: 'Overall' }).click()
  await expect(variants.getByRole('radio', { name: 'Overall' })).toHaveAttribute('aria-checked', 'true')
  await shape([[40, 100], [70, 100], [55, 104]])

  // L for a line, then a tangent arc off its end
  await page.locator('body').press('l')
  await expect(families.getByRole('radio', { name: 'Line' })).toHaveAttribute('aria-checked', 'true')
  await shape([[100, 100], [120, 100]])
  await families.getByRole('radio', { name: 'Arc' }).click()
  await variants.getByRole('radio', { name: 'Tangent' }).click()
  await expect(variants.getByRole('radio', { name: 'Tangent' })).toHaveAttribute('aria-checked', 'true')
  await shape([[120, 100], [120, 110]])
  // the arc family remembers the way it was drawn
  await families.getByRole('radio', { name: 'Line' }).click()
  await families.getByRole('radio', { name: 'Arc' }).click()
  await expect(variants.getByRole('radio', { name: 'Tangent' })).toHaveAttribute('aria-checked', 'true')

  // a new tool starts with an empty readout, not the last tool's
  await families.getByRole('radio', { name: 'Select' }).click()
  await expect(panel.locator('.sketch-readout')).toHaveText('')

  await page.getByTestId('sketch-finish').click()
  await expect.poll(async () => (await loops(page)).length, { timeout: 10_000 }).toBe(5)
  const got = (await loops(page)).map((l) => (l.type === 'circle' ? 'circle' : l.segments!.map((s) => s.type).join(' ')))
  expect(got).toEqual(['circle', 'line line line line', 'line line line line line', 'line arc line arc', 'line arc'])
})

test('X makes a picked line construction, and it reaches the timeline flagged', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  test.slow()
  await openStudio(page)
  await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  await page.locator('.sx-tab[data-mode="design"]').click()
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('Click an origin plane')
  await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, bed: [100, 100] })
  await expect(panel).toContainText('The bed')
  const families = panel.getByRole('radiogroup', { name: 'Drawing tool' })
  const line = panel.getByTestId('sketch-dof')
  const freedom = async () => ((await line.count()) ? Number(await line.getAttribute('data-dof')) : -1)
  const shape = async (pts: [number, number][]) => {
    const before = await freedom()
    for (const p of pts) await sketchAt(page, 'click', p)
    await expect.poll(freedom).not.toBe(before)
  }

  await page.locator('body').press('r')
  await shape([[60, 60], [100, 90]])
  await page.locator('body').press('l')
  await shape([[50, 75], [110, 75]])
  await families.getByRole('radio', { name: 'Select' }).click()
  await sketchAt(page, 'click', [80, 75])
  const toggle = panel.getByRole('button', { name: 'Construction' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await page.locator('body').press('x')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  await page.getByTestId('sketch-finish').click()
  await expect.poll(async () => (await loops(page)).length, { timeout: 10_000 }).toBe(2)
  expect((await loops(page)).map((l) => l.construction === true)).toEqual([false, true])
})
