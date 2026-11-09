// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Loft and Sweep from the Model ribbon: a loft through three finished sketches picked in order, edited once to smooth
// sides; a sweep of a round profile along a bent path, edited once onto another path; and a loft the engine refuses,
// its words shown in the panel. Each solid's volume is read from the plate after every change. The phone leg is in
// phone-cad.spec.ts.
import { type Page } from '@playwright/test'
import { journey as test, expect } from '../journey'
import { designTab, pick, studio, toolPanel } from './lib/cad'

test.skip(({ isMobile }) => isMobile, 'The modeling tools run at desktop width; the phone leg is in phone-cad.spec.ts')

type V3 = [number, number, number]
type Sx = { getState(): { plate: { id: string; name: string; transform: number[]; parts: { positions: ArrayLike<number>; indices: ArrayLike<number> }[]; history?: { steps: { params: { op: string; smooth?: boolean }; uses?: string[] }[] } }[]; objectTool: string | null }; setState(p: unknown): void }

const level = (z: number) => ({ origin: [100, 100, z] as V3, normal: [0, 0, 1] as V3, u: [1, 0, 0] as V3, v: [0, 1, 0] as V3 })
/** An upright plane through the bed point (100, 100): u along X, v up. */
const upright = { origin: [100, 100, 0] as V3, normal: [0, -1, 0] as V3, u: [1, 0, 0] as V3, v: [0, 0, 1] as V3 }
const square = (s: number) => ({ points: [[-s / 2, -s / 2], [s / 2, -s / 2], [s / 2, s / 2], [-s / 2, s / 2]] })
const circle = (d: number) => ({ type: 'circle', center: [0, 0], diameterMm: d })

/** Finished sketches put in the timeline as Finish sketch leaves them. */
async function sketches(page: Page, list: { name: string; frame: unknown; loops: unknown[] }[]): Promise<void> {
  await page.evaluate((list) => {
    const items = list.map((k, i) => ({ kind: 'sketch', id: `k${i + 1}`, name: k.name, frame: k.frame, loops: k.loops }))
    ;(window as unknown as { __sx: Sx }).__sx.setState({ timeline: { bodies: [], items, marker: items.length } })
  }, list)
}

/** The volume of the only body on the plate, mm³, from its triangles where it stands. */
function volume(page: Page): Promise<number> {
  return page.evaluate(() => {
    const e = (window as unknown as { __sx: Sx }).__sx.getState().plate[0]
    if (!e) return 0
    const m = e.transform
    let v = 0
    for (const p of e.parts) {
      const w = (i: number) => {
        const x = p.positions[i * 3]!, y = p.positions[i * 3 + 1]!, z = p.positions[i * 3 + 2]!
        return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!]
      }
      for (let t = 0; t < p.indices.length; t += 3) {
        const a = w(p.indices[t]!), b = w(p.indices[t + 1]!), c = w(p.indices[t + 2]!)
        v += (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6
      }
    }
    return Math.abs(v)
  })
}

const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())
const treeSketch = (page: Page, name: string) => page.getByTestId('model-tree-sketch').filter({ hasText: new RegExp(`^${name}`) })

async function ribbonTool(page: Page, id: 'loft' | 'sweep'): Promise<void> {
  await page.getByTestId('ribbon-tab-solid').click()
  await page.locator(`[data-testid="model-shelf-tool"][data-tool="${id}"]`).click()
}

/** Opens the editor of the body's first step from its row, as a person does. */
async function editFirstStep(page: Page): Promise<void> {
  const row = page.locator('.cad-step').first()
  await row.hover()
  await row.getByRole('button', { name: /^Edit / }).click()
}

test.describe('loft and sweep', () => {
  test('a loft through three sketches picked in order, then edited to smooth sides', async ({ page }) => {
    test.slow()
    await studio(page)
    await designTab(page)
    await sketches(page, [
      { name: 'Sketch 1', frame: level(0), loops: [square(20)] },
      { name: 'Sketch 2', frame: level(15), loops: [square(12)] },
      { name: 'Sketch 3', frame: level(30), loops: [circle(18)] },
    ])
    await ribbonTool(page, 'loft')
    const panel = toolPanel(page)
    await expect(panel).toContainText('Click sketches in the view or the tree, in order.')
    await expect(panel.getByTestId('model-tool-reason')).toHaveText('Pick 2 or more sketches.')
    // two from the tree, one from the view
    await treeSketch(page, 'Sketch 1').click()
    await treeSketch(page, 'Sketch 2').click()
    await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, sketch: 'k3' })
    await expect(panel.getByTestId('loft-profile')).toHaveText([/Sketch 1/, /Sketch 2/, /Sketch 3/])
    await expect(treeSketch(page, 'Sketch 3')).toHaveAttribute('data-pick', '3')
    await expect(panel.getByTestId('loft-ring')).toBeEnabled()
    await panel.getByTestId('model-tool-apply').click()
    await expect(panel).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(async () => (await state(page)).plate.length, { timeout: 30_000 }).toBe(1)
    const straight = await volume(page)
    // a frustum of 20 to 12 mm squares over 15 mm, then 12 mm square to an 18 mm circle over 15 mm
    expect(straight).toBeGreaterThan(5000)
    expect(straight).toBeLessThan(12000)
    const made = (await state(page)).plate[0]!.history!.steps[0]!
    expect(made.params.op).toBe('sketch.loft')
    expect(made.uses).toEqual(['k1', 'k2', 'k3'])

    await editFirstStep(page)
    await expect(panel.getByTestId('model-tool-crumb')).toContainText('Loft body')
    await expect(panel.getByTestId('loft-profile')).toHaveText([/Sketch 1/, /Sketch 2/, /Sketch 3/])
    await panel.getByRole('radio', { name: 'Smooth' }).click()
    await panel.getByTestId('model-tool-apply').click()
    await expect(panel).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(async () => (await state(page)).plate[0]?.history?.steps[0]?.params.smooth ?? false, { timeout: 30_000 }).toBe(true)
    await expect.poll(() => volume(page), { timeout: 30_000 }).not.toBeCloseTo(straight, 0)
  })

  test('a sweep from the ribbon along a bent path, then edited onto a straight path', async ({ page }) => {
    test.slow()
    await studio(page)
    await designTab(page)
    await sketches(page, [
      { name: 'Sketch 1', frame: level(0), loops: [circle(6)] },
      { name: 'Sketch 2', frame: upright, loops: [{ start: [0, 0], segments: [{ type: 'line', to: [0, 30] }, { type: 'arc', center: [15, 30], sweepDeg: -90 }] }] },
      { name: 'Sketch 3', frame: upright, loops: [{ start: [0, 0], segments: [{ type: 'line', to: [0, 20] }] }] },
    ])
    await ribbonTool(page, 'sweep')
    const panel = toolPanel(page)
    await expect(panel.getByTestId('sweep-profile')).toHaveText('Click a sketch.')
    await treeSketch(page, 'Sketch 1').click()
    await expect(panel.getByTestId('sweep-path')).toHaveAttribute('aria-pressed', 'true')
    await treeSketch(page, 'Sketch 2').click()
    await expect(panel.getByTestId('sweep-path')).toHaveText('Sketch 2')
    await panel.getByTestId('model-tool-apply').click()
    await expect(panel).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(async () => (await state(page)).plate.length, { timeout: 30_000 }).toBe(1)
    const bent = await volume(page)
    // a 6 mm rod about 30 + 23.6 mm long
    expect(bent).toBeGreaterThan(1200)
    expect(bent).toBeLessThan(1800)

    await editFirstStep(page)
    await expect(panel.getByTestId('sweep-profile')).toHaveText('Sketch 1')
    await expect(panel.getByTestId('sweep-path')).toHaveText('Sketch 2')
    await panel.getByTestId('sweep-path').click()
    await treeSketch(page, 'Sketch 3').click()
    await expect(panel.getByTestId('sweep-path')).toHaveText('Sketch 3')
    await panel.getByTestId('model-tool-apply').click()
    await expect(panel).toHaveCount(0, { timeout: 30_000 })
    // 20 mm of the same rod
    await expect.poll(() => volume(page), { timeout: 30_000 }).toBeLessThan(700)
    expect((await state(page)).plate[0]!.history!.steps[0]!.uses).toEqual(['k1', 'k3'])
  })

  test('a loft the engine refuses shows its words in the panel and changes nothing', async ({ page }) => {
    await studio(page)
    await designTab(page)
    // two profiles on the same plane: the sides between them would have no height
    await sketches(page, [
      { name: 'Sketch 1', frame: level(0), loops: [square(20)] },
      { name: 'Sketch 2', frame: level(0), loops: [circle(8)] },
    ])
    await ribbonTool(page, 'loft')
    const panel = toolPanel(page)
    await expect(panel).toContainText('Click sketches in the view or the tree, in order.')
    await treeSketch(page, 'Sketch 1').click()
    await treeSketch(page, 'Sketch 2').click()
    await panel.getByTestId('model-tool-apply').click()
    await expect(panel.getByTestId('loft-message')).toContainText(/profiles 1 and 2/i, { timeout: 30_000 })
    expect((await state(page)).plate).toHaveLength(0)
    expect((await state(page)).objectTool).toBe('loft')
  })
})
