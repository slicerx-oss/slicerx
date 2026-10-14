// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Finish sketch, as in Fusion: a sketch on the XZ plane finishes into the timeline without a solid, shows in the
// strip and the tree, and its menu extrudes it into a body whose feature names the sketch.
import { type Page } from '@playwright/test'
import { command, openStudio, pick, sketchAt, toolPanel } from './cad-helpers'
import { expect, test } from './fixtures'

type Item = { kind: 'sketch'; id: string; name: string } | { kind: 'feature'; body: string; sketch?: string }
type Sx = { getState(): { plate: { id: string; history?: { steps: { sketch?: string }[] } }[]; timeline: { items: Item[]; marker: number }; objectTool: string | null }; setState(p: unknown): void }
const sx = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as { __sx: Sx }).__sx.getState()
  return { plate: s.plate.map((e) => ({ id: e.id, sketches: e.history?.steps.map((st) => st.sketch ?? null) ?? [] })), items: s.timeline.items, marker: s.timeline.marker, tool: s.objectTool }
})

/** The way the camera looks, in bed coordinates (Z up). */
const looking = (page: Page) =>
  page.evaluate(() => {
    type M = { clone(): M; invert(): M }
    type V = { x: number; y: number; z: number; transformDirection(m: M): V }
    const vp = (window as unknown as { __vp: { camera: { position: { constructor: new () => V }; getWorldDirection(v: V): V }; stage: { bedRoot: { matrixWorld: M } } } }).__vp
    const d = vp.camera.getWorldDirection(new vp.camera.position.constructor()).transformDirection(vp.stage.bedRoot.matrixWorld.clone().invert())
    return [d.x, d.y, d.z].map((v) => Math.round(v * 100) / 100 + 0)
  })

test('a sketch on XZ finishes into the timeline, then extrudes from its menu', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  test.slow()
  await openStudio(page)
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  await page.locator('.sx-tab[data-mode="design"]').click()
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('Click an origin plane')
  await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, originPlane: 'xz' })
  await expect(panel).toContainText('The XZ plane')
  await expect.poll(() => looking(page), { timeout: 5000 }).toEqual([0, 1, 0])
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Rectangle' }).click()
  await sketchAt(page, 'hover', [0, 0])
  await page.locator('body').press('5')
  const field = page.getByRole('group', { name: 'Exact size' })
  await field.getByLabel('X mm').fill('0')
  await field.getByLabel('Y mm').fill('0')
  await field.getByLabel('Y mm').press('Enter')
  await sketchAt(page, 'hover', [0, 0])
  await page.locator('body').press('3')
  await field.getByLabel('Width mm').fill('20')
  await field.getByLabel('Height mm').fill('10')
  await field.getByLabel('Height mm').press('Enter')

  // Section clips the models at the sketch plane while it is on
  const clipped = () => page.evaluate(() => (window as unknown as { __vp: { section: unknown } }).__vp.section !== null)
  await panel.locator('#sk-section').click()
  await expect.poll(clipped).toBe(true)
  await panel.locator('#sk-section').click()
  await expect.poll(clipped).toBe(false)

  // Finish sketch: no solid, a Sketch item in the timeline, the camera where it was
  await page.getByTestId('sketch-finish').click()
  await expect.poll(async () => (await sx(page)).tool).toBe(null)
  const done = await sx(page)
  expect(done.plate).toEqual([])
  expect(done.items).toEqual([expect.objectContaining({ kind: 'sketch', name: 'Sketch 1' })])
  expect(await looking(page)).toEqual([0, 1, 0])
  await expect(page.getByTestId('sketch-finish')).toHaveCount(0)
  const id = (done.items[0] as { id: string }).id

  // the tree lists it; its menu extrudes it
  const row = page.getByTestId('model-tree-sketch')
  await expect(row).toHaveText('Sketch 1')
  await row.click({ button: 'right' })
  await page.getByTestId('sketch-ctx-extrude').click()
  await expect(panel).toContainText('Sketch 1')
  // a finished sketch's Extrude shows only the extrude settings: no draw tools, no Finish sketch
  await expect(panel.getByRole('heading', { name: 'Extrude' })).toBeVisible()
  await expect(panel.getByRole('radiogroup', { name: 'Drawing tool' })).toHaveCount(0)
  await expect(page.getByTestId('sketch-finish')).toHaveCount(0)
  // nobody is sketching, so the ribbon's Sketch is up; the tree marks the sketch in use
  await expect(page.getByTestId('model-shelf').locator('.rb-btn[aria-pressed="true"]')).toHaveCount(0)
  await expect(row).toHaveAttribute('data-current')
  await panel.locator('#sk-dist').fill('4')
  const extrude = panel.getByRole('button', { name: 'Extrude' })
  await expect(extrude).toBeEnabled({ timeout: 15_000 })
  await extrude.click()
  await expect.poll(async () => (await sx(page)).plate.length, { timeout: 30_000 }).toBe(1)
  const after = await sx(page)
  expect(after.plate[0]!.sketches).toEqual([id])
  expect(after.items.map((i) => (i.kind === 'sketch' ? i.id : i.sketch))).toEqual([id, id])

  // the strip shows the sketch and the feature; undo takes the body back off and leaves the sketch
  await page.getByRole('button', { name: 'Open Timeline' }).click()
  await expect(page.locator('.tl-chip')).toHaveCount(2)
  await expect(page.locator('.tl-chip[data-kind="sketch"]')).toContainText('Sketch 1')
})

test('Ctrl/Cmd+Enter finishes the sketch, a bare Enter does not, and undo takes the finished sketch back out', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await openStudio(page)
  await page.locator('.sx-tab[data-mode="design"]').click()
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('Click an origin plane')
  await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, bed: [100, 100] })
  await expect(panel).toContainText('The bed')
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Circle' }).click()
  await sketchAt(page, 'click', [100, 100])
  await sketchAt(page, 'click', [106, 100])
  // the circle is drawn before Enter, as a person would see it
  await expect(panel.getByRole('status').filter({ hasText: 'DOF left' })).toBeVisible()
  // a bare Enter keeps the sketch open: a second one would otherwise close it by surprise
  await page.locator('body').press('Enter')
  await expect(panel).toContainText('The bed')
  expect((await sx(page)).items.filter((i) => i.kind === 'sketch').length).toBe(0)
  await page.locator('body').press('ControlOrMeta+Enter')
  await expect.poll(async () => (await sx(page)).items.filter((i) => i.kind === 'sketch').length).toBe(1)
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await sx(page)).items.filter((i) => i.kind === 'sketch').length).toBe(0)
})

test('Join from a finished sketch picks the only body, and the step joins it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  test.slow()
  await openStudio(page)
  await page.locator('.sx-tab[data-mode="design"]').click()
  const body = (await sx(page)).plate
  expect(body).toHaveLength(1)
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('Click an origin plane')
  await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, originPlane: 'xz' })
  await expect(panel).toContainText('The XZ plane')
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Circle' }).click()
  await sketchAt(page, 'click', [0, 4])
  await sketchAt(page, 'click', [3, 4])
  await expect(panel.getByRole('status').filter({ hasText: 'DOF left' })).toBeVisible()
  await page.getByTestId('sketch-finish').click()
  await expect.poll(async () => (await sx(page)).tool).toBe(null)
  await page.getByTestId('model-tree-sketch').click({ button: 'right' })
  await page.getByTestId('sketch-ctx-extrude').click()
  // a sketch on an origin plane starts as a new body; Join asks for the body and offers the only one
  const result = panel.getByRole('radiogroup', { name: 'Result' })
  await expect(result.getByRole('radio', { name: 'New body' })).toHaveAttribute('aria-checked', 'true')
  await result.getByRole('radio', { name: 'Join' }).click()
  await expect(panel.locator('#sk-into')).toHaveValue(body[0]!.id)
  await panel.locator('#sk-dist').fill('4')
  const extrude = panel.getByRole('button', { name: 'Extrude' })
  await expect(extrude).toBeEnabled({ timeout: 15_000 })
  await extrude.click()
  await expect.poll(async () => (await sx(page)).tool, { timeout: 30_000 }).toBe(null)
  const after = await sx(page)
  expect(after.plate.map((e) => e.id)).toEqual([body[0]!.id])
  expect(after.plate[0]!.sketches.at(-1)).toBe((after.items.find((i) => i.kind === 'sketch') as { id: string }).id)
})
