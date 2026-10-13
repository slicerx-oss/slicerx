// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The dimension tool (D): a rectangle dimensioned until it is fully defined turns the defined color, one more
// dimension that would over-define it is kept driven, a dimension changed later moves the extrude with it, and a
// picked constraint glyph deletes.
import { type Page } from '@playwright/test'
import { command, openStudio, pick, sketchAt, toolPanel } from './cad-helpers'
import { expect, test } from './fixtures'

type V2 = [number, number]
type Scene = { paths: { points: V2[]; tone?: string; closed?: boolean }[]; dims?: { label: string }[]; glyphs?: { kind: string }[] }
const scene = (page: Page) => page.evaluate(() => (window as unknown as { __vp: { sketchLayer: { scene: Scene | null } } }).__vp.sketchLayer.scene)

// the drawn rectangle's corners, from its start, as the view has them now (each side is its own path)
async function corners(page: Page): Promise<V2[]> {
  const s = await scene(page)
  return (s?.paths.filter((x) => x.tone !== 'soft') ?? []).map((x) => x.points[0]!).map(([x, y]): V2 => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000])
}
const mid = (a: V2, b: V2): V2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
async function segMid(page: Page, k: number): Promise<V2> {
  const c = await corners(page)
  return mid(c[k]!, c[(k + 1) % c.length]!)
}

// a click carrying what the view found under it: a dimension's value or a glyph
const clickMark = (page: Page, at: V2, mark: { dim: number } | { glyph: number }) =>
  page.evaluate(({ at, mark }) => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('sketch', { kind: 'click', at, mmPerPx: 0.2, screen: [700, 420], shift: false, alt: false, mark }), { at, mark })

// the body's size along each axis, smallest first
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

test('D dimensions a rectangle until it is fully defined, and the extrude follows a changed value', async ({ page, isMobile }) => {
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
  const dof = panel.getByTestId('sketch-dof')
  const freedom = async () => ((await dof.count()) ? Number(await dof.getAttribute('data-dof')) : -1)
  const field = page.getByRole('group', { name: 'Exact size' })

  // a 20 by 10 rectangle: level and upright sides, four freedoms left (its width, height and where it is)
  await page.locator('body').press('r')
  await sketchAt(page, 'click', [10, 10])
  await sketchAt(page, 'click', [30, 20])
  await expect.poll(freedom).toBe(4)

  await page.locator('body').press('d')
  await expect(panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Dimension' })).toHaveAttribute('aria-checked', 'true')
  const dimension = async (picks: V2[], at: V2, type: string, value: string) => {
    for (const p of picks) await sketchAt(page, 'click', p)
    await sketchAt(page, 'click', at)
    await expect(field.getByLabel(new RegExp(`^${type} `))).toBeFocused()
    await field.getByLabel(new RegExp(`^${type} `)).fill(value)
    await field.getByLabel(new RegExp(`^${type} `)).press('Enter')
    await expect(field).toHaveCount(0)
  }

  // the bottom's length, then the right side's, typed as a sum
  await dimension([await segMid(page, 0)], [20, 5], 'Length', '25')
  await expect.poll(freedom).toBe(3)
  const right = await segMid(page, 1)
  await dimension([right], [right[0] + 5, right[1]], 'Length', '6*2')
  await expect.poll(freedom).toBe(2)
  await expect.poll(async () => (await scene(page))?.dims?.map((d) => d.label).sort()).toEqual(['12', '25'])

  // sized but free to move: dragging a corner carries the whole rectangle, as the constraints allow
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Select' }).click()
  const pull = (kind: 'drag' | 'release', at: V2) =>
    page.evaluate(({ kind, at }) => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('sketch', { kind, at, handle: 0, mmPerPx: 0.2, screen: [700, 420], shift: false, alt: false }), { kind, at })
  await pull('drag', [4, 6])
  await pull('release', [4, 6])
  await expect.poll(() => corners(page)).toEqual([[4, 6], [29, 6], [29, 18], [4, 18]])
  await page.locator('body').press('d')

  // the start corner from the origin: level with the value below, upright with it to the left
  const start = (await corners(page))[0]!
  await dimension([[0, 0], start], [start[0] / 2, -4], 'Horizontal', '10')
  await expect.poll(freedom).toBe(1)
  await dimension([[0, 0], (await corners(page))[0]!], [-4, start[1] / 2], 'Vertical', '10')
  await expect(dof).toHaveText('Fully constrained')
  await expect(dof).toHaveAttribute('data-tone', 'done')
  await expect.poll(async () => (await scene(page))?.paths.filter((p) => p.tone !== 'soft').map((p) => p.tone)).toEqual(['defined', 'defined', 'defined', 'defined'])
  expect(await corners(page)).toEqual([[10, 10], [35, 10], [35, 22], [10, 22]])

  // the top's length is already set: kept, driven, in parentheses, and the sketch stays fully defined
  await dimension([await segMid(page, 2)], [22, 26], 'Length', '30')
  await expect.poll(async () => (await scene(page))?.dims?.map((d) => d.label)).toContain('(25)')
  await expect(dof).toHaveText('Fully constrained, 1 driven')
  // picked with Select, Delete takes it off
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Select' }).click()
  const driven = ((await scene(page))?.dims ?? []).findIndex((d) => d.label === '(25)')
  await clickMark(page, [22, 26], { dim: driven })
  // the pick shows before the key, so the key reaches it
  await expect.poll(async () => ((await scene(page))?.dims as { picked?: boolean }[] | undefined)?.[driven]?.picked).toBe(true)
  await page.locator('body').press('Delete')
  await expect.poll(async () => (await scene(page))?.dims?.length).toBe(4)

  await panel.locator('#sk-dist').fill('4')
  await panel.getByRole('button', { name: 'Extrude', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: unknown[] } } }).__sx.getState().plate.length)), { timeout: 30_000 }).toBe(1)
  await expect.poll(() => extents(page)).toEqual([4, 12, 25])

  // opened again from the history: a press on the width's value picks it, a second opens it
  await page.getByRole('button', { name: /^Edit / }).first().click()
  const again = toolPanel(page)
  await expect(again.getByTestId('sketch-dof')).toHaveText('Fully constrained')
  const width = ((await scene(page))?.dims ?? []).findIndex((d) => d.label === '25')
  expect(width).toBeGreaterThanOrEqual(0)
  // real presses on the value as drawn, so the view finds the label under the pointer itself
  const label = await page.evaluate((i) => {
    const vp = (window as unknown as { __vp: { sketchLayer: { scene: { frame: { origin: number[]; u: number[]; v: number[] }; dims: { from: V2; to: V2; at?: V2 }[] } }; toScreen(p: number[]): [number, number] } }).__vp
    const s = vp.sketchLayer.scene
    const d = s.dims[i]!
    const [x, y] = d.at ?? [(d.from[0] + d.to[0]) / 2, (d.from[1] + d.to[1]) / 2]
    const f = s.frame
    return vp.toScreen([0, 1, 2].map((k) => f.origin[k]! + f.u[k]! * x + f.v[k]! * y))
  }, width)
  await page.mouse.click(label[0], label[1])
  await expect.poll(async () => ((await scene(page))?.dims as { picked?: boolean }[] | undefined)?.[width]?.picked).toBe(true)
  await page.mouse.click(label[0], label[1])
  await expect(field.getByLabel(/^Length /)).toHaveValue('25')
  await field.getByLabel(/^Length /).fill('30')
  await field.getByLabel(/^Length /).press('Enter')
  await expect.poll(async () => (await scene(page))?.dims?.map((d) => d.label).sort()).toEqual(['10', '10', '12', '30'])
  await expect.poll(() => corners(page)).toEqual([[10, 10], [40, 10], [40, 22], [10, 22]])

  // a picked glyph deletes its constraint, and the sketch gets a freedom back
  const glyphs = (await scene(page))?.glyphs ?? []
  expect(glyphs.length).toBeGreaterThan(0)
  await clickMark(page, [0, 0], { glyph: 0 })
  await expect.poll(async () => ((await scene(page))?.glyphs as { picked?: boolean }[] | undefined)?.[0]?.picked).toBe(true)
  await page.locator('body').press('Delete')
  await expect.poll(async () => ((await scene(page))?.glyphs ?? []).length).toBe(glyphs.length - 1)
  await expect.poll(async () => Number(await again.getByTestId('sketch-dof').getAttribute('data-dof'))).toBe(1)

  await again.getByRole('button', { name: 'Extrude', exact: true }).click()
  await expect.poll(() => extents(page), { timeout: 30_000 }).toEqual([4, 12, 30])
})
