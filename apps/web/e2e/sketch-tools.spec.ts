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

  // Select has no cursor numbers: the last tool's pills go
  await families.getByRole('radio', { name: 'Select' }).click()
  await expect(page.getByTestId('sketch-pills')).toBeHidden()

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
  // a construction line is no open loop
  await expect(panel).not.toContainText('is open')

  await page.getByTestId('sketch-finish').click()
  await expect.poll(async () => (await loops(page)).length, { timeout: 10_000 }).toBe(2)
  expect((await loops(page)).map((l) => l.construction === true)).toEqual([false, true])
})

type Scene = { dragFrom?: [number, number]; glyphs?: { kind: string }[] } | null
const scene = (page: Page) => page.evaluate(() => (window as unknown as { __vp: { sketchLayer: { scene: Scene } } }).__vp.sketchLayer.scene)
const drag = (page: Page, kind: 'drag' | 'release', at: [number, number], ctrl = false) =>
  page.evaluate(({ kind, at, ctrl }) => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('sketch', { kind, at, handle: -1, mmPerPx: 0.2, screen: [700, 420], shift: false, alt: false, ctrl }), { kind, at, ctrl })

test('L, clicks and a drag off the end draw a closed shape with a tangent arc, and its glyphs', async ({ page, isMobile }) => {
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
  const line = panel.getByTestId('sketch-dof')
  const freedom = async () => ((await line.count()) ? Number(await line.getAttribute('data-dof')) : -1)
  const step = async (go: () => Promise<unknown>) => {
    const before = await freedom()
    await go()
    await expect.poll(freedom).not.toBe(before)
  }
  const glyphs = async () => ((await scene(page))?.glyphs ?? []).map((g) => g.kind).sort()

  await page.locator('body').press('l')
  await sketchAt(page, 'click', [60, 60])
  // one point has nothing to be tangent to, so there is nowhere to drag from yet
  expect((await scene(page))?.dragFrom).toBeUndefined()
  await step(() => sketchAt(page, 'click', [90, 60]))
  await expect.poll(async () => (await scene(page))?.dragFrom).toEqual([90, 60])
  // press on the end and drag round: a tangent arc, placed on release, and the line goes on from its end
  await drag(page, 'drag', [97, 66])
  await step(() => drag(page, 'release', [90, 76]))
  await expect.poll(async () => (await scene(page))?.dragFrom).toEqual([90, 76])
  // a level line tangent to the arc adds two freedoms and takes two, so wait on its end instead
  await sketchAt(page, 'click', [60, 76])
  await expect.poll(async () => (await scene(page))?.dragFrom).toEqual([60, 76])
  await step(() => sketchAt(page, 'click', [60, 60]))
  // a level line, the arc tangent to it, a level line tangent to the arc, and the upright that closes it
  await expect.poll(glyphs).toEqual(['horizontal', 'horizontal', 'tangent', 'tangent', 'vertical'])

  // Ctrl (Cmd on a Mac) leaves no constraints behind
  await page.evaluate(() => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('sketch', { kind: 'click', at: [120, 60], mmPerPx: 0.2, screen: [700, 420], shift: false, alt: false, ctrl: true }))
  await step(() => page.evaluate(() => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('sketch', { kind: 'click', at: [140, 60], mmPerPx: 0.2, screen: [700, 420], shift: false, alt: false, ctrl: true })))
  expect(await glyphs()).toHaveLength(5)

  // Show constraints hides the glyphs
  await panel.locator('#sk-show-constraints').click()
  await expect.poll(glyphs).toEqual([])
  await panel.locator('#sk-show-constraints').click()
  await expect.poll(glyphs).toHaveLength(5)

  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Select' }).click()
  await page.getByTestId('sketch-finish').click()
  await expect.poll(async () => (await loops(page)).length, { timeout: 10_000 }).toBe(2)
  expect((await loops(page))[0]!.segments!.map((s) => s.type)).toEqual(['line', 'arc', 'line', 'line'])
})
