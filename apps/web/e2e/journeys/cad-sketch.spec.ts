// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch tools on one page: planes, drawing tools and their variants, the boxes on the shape, constraints and
// dimensions, trim, extend, mirror and pattern, finishing a sketch into the timeline, and the sketch panel (its cards,
// footer, keyboard and focus). Each block below was a spec of its own; every test starts with `studio` (an empty plate,
// no tool open, the look put back), so the order does not matter. The phone legs are in phone-cad.spec.ts.
import { type Page } from '@playwright/test'
import { journey as test, expect } from '../journey'
import { test as cold } from '../fixtures'
import { bounds, command, facePick, freshBox, height, openStudio, pick, sketchAt, steps, toolPanel } from '../cad-helpers'
import {
  bedSketch, boxOf, boxesOverControls, designTab, dimsDrawn, ends, extents, inputOf, labels, looking, loops, r2, rect, screenAt, shot, size, sketchOnBed, sketchOnTop as sketchOnTopRaw, still, studio,
  type V2, type W,
} from './lib/cad'

test.skip(({ isMobile }) => isMobile, 'The modeling tools run at desktop width; the phone legs are in phone-cad.spec.ts')

/** A fresh box with a sketch open on its top face. */
async function sketchOnTop(page: Page): Promise<string> {
  await studio(page)
  return sketchOnTopRaw(page)
}

// ---- sketch-constraints
// The sketch says how defined it is, from the engine's solver: a free circle has its center and radius left.
test.describe('sketch-constraints', () => {
  test('a circle drawn on a face has three degrees of freedom left', async ({ page }) => {
    await studio(page)
    const id = await freshBox(page)
    await command(page, 'Sketch on the bed or a face')
    const panel = toolPanel(page)
    await expect(panel).toContainText('the bed or a flat face to sketch on')
    await pick(page, await facePick(page, id, [0, 0, 1]))
    await expect(panel).toContainText('A face of')
    await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Circle' }).click()
    await expect(panel).toContainText('Click the center, then the rim.')
    // off the origin, which would hold the center
    await sketchAt(page, 'click', [2, 1])
    await sketchAt(page, 'click', [6, 1])
    const dof = panel.getByTestId('sketch-dof')
    await expect(dof).toHaveText('3 DOF left')
    // the whole line is its tooltip and its accessible name
    await expect(dof).toHaveAttribute('data-tip-title', '3 degrees of freedom left')
    await expect(dof).toHaveAccessibleName('3 degrees of freedom left')
    await expect(dof).toHaveAttribute('data-dof', '3')
  })

  /** Gives the sketch of the object's extrude these constraints, as a saved project would carry them. */
  async function constrain(page: Page, constraints: unknown[]): Promise<void> {
    await page.evaluate((constraints) => {
      type Step = { params: { op: string; shape?: Record<string, unknown> } }
      type E = { history?: { steps: Step[] } }
      const sx = (window as unknown as { __sx: { getState(): { plate: E[] }; setState(p: unknown): void } }).__sx
      const plate = sx.getState().plate.map((e) => (e.history ? { ...e, history: { ...e.history, steps: e.history.steps.map((st) => (st.params.op === 'shape.extrude' ? { ...st, params: { ...st.params, shape: { ...st.params.shape, constraints } } } : st)) } } : e))
      sx.setState({ plate })
    }, constraints)
  }

  test('a circle with its center fixed and a diameter is fully constrained', async ({ page }) => {
    await studio(page)
    const id = await freshBox(page)
    await command(page, 'Sketch on the bed or a face')
    const panel = toolPanel(page)
    await expect(panel).toContainText('the bed or a flat face to sketch on')
    await pick(page, await facePick(page, id, [0, 0, 1]))
    await expect(panel).toContainText('A face of')
    await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Circle' }).click()
    await expect(panel).toContainText('Click the center, then the rim.')
    await sketchAt(page, 'click', [2, 1])
    await sketchAt(page, 'click', [6, 1])
    await expect(panel.getByTestId('sketch-dof')).toHaveText('3 DOF left')
    await expect(panel.getByRole('button', { name: 'Extrude', exact: true })).toBeEnabled()
    await panel.getByRole('button', { name: 'Extrude', exact: true }).click()
    await expect(panel).toHaveCount(0)
    await constrain(page, [
      { type: 'fix', point: { e: 0, at: 'center' } },
      { type: 'diameter', circle: { e: 0, seg: 0 }, value: 8 },
    ])
    await page.getByRole('button', { name: /^Edit / }).first().click()
    const dof = toolPanel(page).getByTestId('sketch-dof')
    await expect(dof).toHaveText('Defined')
    await expect(dof).toHaveAttribute('data-tone', 'done')
  })

  test('sketch dimensions read in the display unit', async ({ page }) => {
    await studio(page)
    const id = await freshBox(page)
    await command(page, 'Sketch on the bed or a face')
    const panel = toolPanel(page)
    await expect(panel).toContainText('the bed or a flat face to sketch on')
    await pick(page, await facePick(page, id, [0, 0, 1]))
    await expect(panel).toContainText('A face of')
    await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Circle' }).click()
    await sketchAt(page, 'click', [2, 1])
    await sketchAt(page, 'click', [6, 1])
    await expect(panel.getByTestId('sketch-dof')).toHaveText('3 DOF left')
    await panel.getByRole('button', { name: 'Extrude', exact: true }).click()
    await expect(panel).toHaveCount(0)
    await constrain(page, [{ type: 'diameter', circle: { e: 0, seg: 0 }, value: 12.7 }])
    const labels = () => page.evaluate(() => ((window as unknown as { __vp: { sketchLayer: { scene: { dims?: { label: string }[] } | null } } }).__vp.sketchLayer.scene?.dims ?? []).map((d) => d.label))
    await page.getByRole('button', { name: /^Edit / }).first().click()
    await expect(toolPanel(page).getByTestId('sketch-dof')).toBeVisible()
    await expect.poll(labels).toEqual(['⌀12.7'])
    // the open sketch follows a change of unit in Settings
    await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ units: { length: 'in', mmDigits: 2, inchDigits: 3, inchFraction: 0 } }))
    await expect.poll(labels).toEqual(['⌀0.500'])
    await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ units: { length: 'in', mmDigits: 2, inchDigits: 3, inchFraction: 16 } }))
    await expect.poll(labels).toEqual(['⌀1/2'])
  })
})

// ---- sketch-dimensions
// The dimension tool (D): a rectangle dimensioned until it is fully defined turns the defined color (a valid profile
// either way, so it can extrude before and after), one more dimension that would over-define it is kept driven, a
// dimension changed later moves the extrude with it, and a picked constraint glyph deletes.
test.describe('sketch-dimensions', () => {
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


  test('D dimensions a rectangle until it is fully defined, and the extrude follows a changed value', async ({ page }) => {
    test.slow()
    await studio(page)
    await designTab(page)
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
    // free to move and resize, and still a valid closed profile: the freedoms left say nothing about whether it can extrude
    const state = () => page.evaluate(() => {
      const s = (window as unknown as { __sketch: () => { profile?: string; ready?: boolean; reason?: string | null } | null }).__sketch()
      return { profile: s?.profile, ready: s?.ready, reason: s?.reason ?? null }
    })
    await expect.poll(state).toEqual({ profile: 'valid', ready: true, reason: null })
    await expect(panel.getByTestId('model-tool-apply')).toHaveAttribute('data-variant', 'primary')

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
    await expect(dof).toHaveText('Defined')
    await expect(dof).toHaveAttribute('data-tone', 'done')
    // fully constrained is the same valid profile, no more and no less ready
    await expect.poll(state).toEqual({ profile: 'valid', ready: true, reason: null })
    await expect(panel.getByTestId('model-tool-apply')).toHaveAttribute('data-variant', 'primary')
    await expect.poll(async () => (await scene(page))?.paths.filter((p) => p.tone !== 'soft').map((p) => p.tone)).toEqual(['defined', 'defined', 'defined', 'defined'])
    expect(await corners(page)).toEqual([[10, 10], [35, 10], [35, 22], [10, 22]])

    // the top's length is already set: kept, driven, in parentheses, and the sketch stays fully defined
    await dimension([await segMid(page, 2)], [22, 26], 'Length', '30')
    await expect.poll(async () => (await scene(page))?.dims?.map((d) => d.label)).toContain('(25)')
    await expect(dof).toHaveText('Defined')
    await expect(dof).toHaveAccessibleName('Fully constrained, 1 driven')
    // the header says it whole at the panel's width, the driven count in the tooltip
    expect(await dof.evaluate((el) => el.parentElement!.scrollWidth <= el.parentElement!.clientWidth)).toBe(true)
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
    await expect(again.getByTestId('sketch-dof')).toHaveText('Defined')
    const width = ((await scene(page))?.dims ?? []).findIndex((d) => d.label === '25')
    expect(width).toBeGreaterThanOrEqual(0)
    // real presses on the value as drawn, so the view finds the label under the pointer itself, once the camera has
    // stopped turning square on to the reopened sketch (a spot read while it eases moves before the second press)
    const labelAt = () => page.evaluate((i) => {
      const vp = (window as unknown as { __vp: { sketchLayer: { scene: { frame: { origin: number[]; u: number[]; v: number[] }; dims: { from: V2; to: V2; at?: V2 }[] } }; toScreen(p: number[]): [number, number] } }).__vp
      const s = vp.sketchLayer.scene
      const d = s.dims[i]!
      const [x, y] = d.at ?? [(d.from[0] + d.to[0]) / 2, (d.from[1] + d.to[1]) / 2]
      const f = s.frame
      return vp.toScreen([0, 1, 2].map((k) => f.origin[k]! + f.u[k]! * x + f.v[k]! * y))
    }, width)
    let label = await labelAt()
    let since = Date.now()
    await expect.poll(async () => {
      const again = await labelAt()
      // two reads inside one frame always agree, so a read counts only once the one before it is far enough back
      if (Date.now() - since < 600) return false
      const still = Math.hypot(again[0] - label[0], again[1] - label[1]) < 0.5
      label = again
      since = Date.now()
      return still
    }, { intervals: [700] }).toBe(true)
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
})

// ---- sketch-dims-on-shape
// Sketch dimension boxes on the shape (the Model feel, on for everyone), with a real mouse and keyboard: Width and
// Height sit on the rectangle's sides, Length and Angle on the line, Diameter on the circle. The first click puts the
// keyboard in the first box, typing replaces its value, Tab moves to the next box and on out of them, Enter places the
// shape and the typed sizes drive it as dimensions, Esc frees a typed value and then drops the shape. A picked shape
// shows its boxes again to change, and they stay on it with the side panes shut. With the tool pane shut a sketch keeps
// going and finishes from the keyboard or the ribbon. A phone taps the boxes. The open sketch's boxes read and set the
// same way a client does over the app link.
test.describe('sketch-dims-on-shape', () => {

  async function move(page: Page, p: V2): Promise<void> {
    const s = await screenAt(page, p)
    await page.mouse.move(s.x, s.y, { steps: 4 })
  }
  async function clickAt(page: Page, p: V2): Promise<void> {
    await move(page, p)
    await page.mouse.down()
    await page.mouse.up()
  }

  /** A sketch on the bed, in the default settings mode; the bed plane's coordinates are bed millimeters. */
  async function sketchOnBed(page: Page): Promise<void> {
    await studio(page)
    await designTab(page)
    await command(page, 'Sketch on the bed or a face')
    await expect(toolPanel(page)).toContainText('Click an origin plane')
    await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, bed: [100, 100] })
    await expect(toolPanel(page)).toContainText('The bed')
    await still(page)
  }

  test('a rectangle takes Width and Height on its sides, Tab between them, Enter places it held to them', async ({ page }) => {
    test.slow()
    await sketchOnBed(page)
    await page.keyboard.press('r')
    await clickAt(page, [110, 110])
    await move(page, [150, 135])
    const width = inputOf(page, 'width')
    const height = inputOf(page, 'height')
    // the first click put the keyboard in Width, its live value picked
    await expect(width).toBeFocused()
    await expect(width).toHaveValue('40.00')
    await expect(height).toHaveValue('25.00')
    expect(await width.evaluate((el: HTMLInputElement) => el.selectionStart === 0 && el.selectionEnd === el.value.length)).toBe(true)
    // on the shape: Width under the bottom side and centered on it, Height right of the right side, apart and clear
    const a = await screenAt(page, [110, 110])
    const b = await screenAt(page, [150, 135])
    const wb = await rect(boxOf(page, 'width'))
    const hb = await rect(boxOf(page, 'height'))
    expect(wb.y).toBeGreaterThan(Math.max(a.y, b.y))
    expect(Math.abs(wb.x + wb.width / 2 - (a.x + b.x) / 2)).toBeLessThan(2)
    expect(hb.x).toBeGreaterThan(Math.max(a.x, b.x))
    expect(Math.abs(hb.y + hb.height / 2 - (a.y + b.y) / 2)).toBeLessThan(2)
    expect(wb.x + wb.width <= hb.x || hb.y + hb.height <= wb.y).toBe(true)
    // the body font with tabular figures (spec 2)
    expect(await width.evaluate((el) => getComputedStyle(el).fontVariantNumeric)).toContain('tabular-nums')
    expect(await width.evaluate((el) => getComputedStyle(el).fontFamily)).toBe(await page.evaluate(() => getComputedStyle(document.body).fontFamily))
    await shot(page, test.info(), 'rect-live.png')

    // typing replaces the value and locks it; the shape follows the typed size, not the pointer
    await page.keyboard.type('30')
    await expect(boxOf(page, 'width')).toHaveAttribute('data-typed', '')
    await page.keyboard.press('Tab')
    await expect(height).toBeFocused()
    await page.keyboard.type('20')
    await move(page, [125, 130])
    await expect(width).toHaveValue('30')
    await shot(page, test.info(), 'rect-typed.png')
    await page.keyboard.press('Enter')

    // placed 30 by 20 from the first corner, its sizes kept as dimensions, the boxes gone with the shape
    await expect.poll(async () => ends((await loops(page))[0])).toEqual([[140, 110], [140, 130], [110, 130], [110, 110]])
    await expect.poll(() => labels(page)).toEqual(['20', '30'])
    await expect(boxOf(page, 'width')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => (window as unknown as W).__sketch()?.dof)).toBe(2)
  })

  test('a line takes Length and Angle, Esc frees a typed value then drops the line, and the keys are never stuck', async ({ page }) => {
    test.slow()
    await sketchOnBed(page)
    await page.keyboard.press('l')
    await clickAt(page, [110, 150])
    await move(page, [120, 150])
    const length = inputOf(page, 'length')
    const angle = inputOf(page, 'angle')
    await expect(length).toBeFocused()
    await expect(length).toHaveValue('10.00')
    await expect(angle).toHaveValue('0.0')
    // Length above the line's middle, Angle past its start
    const a = await screenAt(page, [110, 150])
    const lb = await rect(boxOf(page, 'length'))
    const ab = await rect(boxOf(page, 'angle'))
    expect(lb.y + lb.height).toBeLessThan(a.y)
    expect(ab.x + ab.width).toBeLessThan(a.x)

    // Esc frees a typed value (still in the box), a second Esc drops the line, the tool stays
    await page.keyboard.type('9')
    await expect(boxOf(page, 'length')).toHaveAttribute('data-typed', '')
    await page.keyboard.press('Escape')
    await expect(boxOf(page, 'length')).not.toHaveAttribute('data-typed')
    await expect(length).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(boxOf(page, 'length')).toHaveCount(0)
    await expect(toolPanel(page).getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Line' })).toHaveAttribute('aria-checked', 'true')

    // drawn again: 25 at 30 degrees
    await clickAt(page, [110, 150])
    await move(page, [120, 155])
    await expect(length).toBeFocused()
    await page.keyboard.type('25')
    await page.keyboard.press('Tab')
    await expect(angle).toBeFocused()
    await page.keyboard.type('30')
    await shot(page, test.info(), 'line-typed.png')
    // Tab past the last box leaves the boxes for the panel: never trapped
    await page.keyboard.press('Tab')
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-section="cad-tool"]'))).toBe(true)
    await page.keyboard.press('Shift+Tab')
    await angle.focus()
    await page.keyboard.press('Enter')
    await expect.poll(async () => ends((await loops(page))[0])).toEqual([[r2(110 + 25 * Math.cos(Math.PI / 6)), r2(150 + 12.5)]])
    await expect.poll(() => labels(page)).toEqual(['25', '30°'])
    // the next segment goes on from there, its Length box ready; a tool key from an untouched box picks that tool
    await expect(length).toBeFocused()
    await page.keyboard.press('c')
    await expect(toolPanel(page).getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Circle' })).toHaveAttribute('aria-checked', 'true')
    // undo still steps the sketch
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await loops(page)).length).toBe(0)
  })

  test('a circle takes its Diameter beside the radius, and Enter places it', async ({ page }) => {
    await sketchOnBed(page)
    await page.keyboard.press('c')
    await clickAt(page, [160, 120])
    await move(page, [165, 120])
    const d = inputOf(page, 'diameter')
    await expect(d).toBeFocused()
    await expect(d).toHaveValue('10.00')
    const c = await screenAt(page, [160, 120])
    const rim = await screenAt(page, [165, 120])
    const db = await rect(boxOf(page, 'diameter'))
    expect(db.y + db.height).toBeLessThan(c.y)
    expect(Math.abs(db.x + db.width / 2 - (c.x + rim.x) / 2)).toBeLessThan(2)
    await page.keyboard.type('12')
    await shot(page, test.info(), 'circle-typed.png')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await loops(page))[0]).toMatchObject({ type: 'circle', center: [160, 120], diameterMm: 12 })
    await expect.poll(() => labels(page)).toEqual(['⌀12'])
  })

  test('a picked shape shows its boxes to change, and they stay on it with the side panes shut', async ({ page }) => {
    test.slow()
    await sketchOnBed(page)
    await page.keyboard.press('r')
    await clickAt(page, [110, 110])
    await move(page, [130, 120])
    // the live sizes have caught up with the pointer: Enter places the shape where it is
    await expect(inputOf(page, 'width')).toHaveValue('20.00')
    await page.keyboard.press('Enter')
    await expect.poll(async () => ends((await loops(page))[0])).toEqual([[130, 110], [130, 120], [110, 120], [110, 110]])
    await toolPanel(page).getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Select' }).click()
    await clickAt(page, [120, 110])
    const width = inputOf(page, 'width')
    await expect(boxOf(page, 'width')).toBeVisible()
    await expect(width).toHaveValue('20.00')
    await expect(inputOf(page, 'height')).toHaveValue('10.00')
    await shot(page, test.info(), 'edit-picked.png')
    // a click in the box and a new value: the rectangle grows to it, and the box now says a dimension sets it
    await width.click()
    await width.fill('40')
    await width.press('Enter')
    await expect.poll(async () => ends((await loops(page))[0])).toEqual([[150, 110], [150, 120], [110, 120], [110, 110]])
    await expect(boxOf(page, 'width')).toHaveAttribute('data-set', 'driving')
    await expect(width).toHaveValue('40.00')
    // an emptied box frees the size again
    await width.click()
    await width.fill('')
    await width.press('Enter')
    await expect(boxOf(page, 'width')).not.toHaveAttribute('data-set')
    await expect.poll(() => labels(page)).toEqual([])

    // side panes shut: the view grows, and the boxes move with the shape
    const placed = async () => {
      const a = await screenAt(page, [110, 110])
      const b = await screenAt(page, [150, 110])
      const w = await rect(boxOf(page, 'width'))
      return Math.abs(w.x + w.width / 2 - (a.x + b.x) / 2) < 2 && w.y > a.y
    }
    expect(await placed()).toBe(true)
    const canvasWidth = () => page.evaluate(() => Math.round((window as unknown as W).__vp.canvas.getBoundingClientRect().width))
    const open = await canvasWidth()
    // the edge tab shuts the tree; the view takes the width, and the boxes follow the shape
    await page.getByTestId('edge-tab-left').click()
    await expect.poll(canvasWidth).toBeGreaterThan(open + 100)
    await expect.poll(placed).toBe(true)
    await shot(page, test.info(), 'edit-pane-shut.png')
    await page.getByTestId('edge-tab-left').click()
    await expect.poll(canvasWidth).toBe(open)
    await expect.poll(placed).toBe(true)
  })

  test('a picked shape shows its sizes in boxes and not twice: the kept label steps aside, with the tool pane open or shut', async ({ page }) => {
    test.slow()
    await sketchOnBed(page)
    await page.keyboard.press('r')
    await clickAt(page, [110, 110])
    await move(page, [130, 120])
    // the first click puts the keyboard in Width: type only once it is there
    await expect(inputOf(page, 'width')).toBeFocused()
    await page.keyboard.type('30')
    await page.keyboard.press('Tab')
    await page.keyboard.type('20')
    await page.keyboard.press('Enter')
    await expect.poll(() => labels(page)).toEqual(['20', '30'])
    // placed: its two kept values show on the sides, nothing is picked
    await expect.poll(() => dimsDrawn(page)).toEqual({ all: 2, hidden: 0 })
    await page.keyboard.press('Escape')
    await toolPanel(page).getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Select' }).click()
    // the left side, which carries no value label (a press on a label picks its dimension instead)
    await clickAt(page, [110, 120])
    await expect(boxOf(page, 'width')).toBeVisible()
    await expect(inputOf(page, 'width')).toHaveValue('30.00')
    await expect(boxOf(page, 'height')).toHaveAttribute('data-set', 'driving')
    // the boxes hold the values, so the labels at the sides' middles are left off and nothing is covered
    await expect.poll(() => dimsDrawn(page)).toEqual({ all: 2, hidden: 2 })
    await page.mouse.move(900, 760)
    await shot(page, test.info(), 'picked-kept.png')
    expect((await boxesOverControls(page)).over).toBe(0)
    // picking nothing gives the labels back
    await clickAt(page, [190, 190])
    await expect(boxOf(page, 'width')).toHaveCount(0)
    await expect.poll(() => dimsDrawn(page)).toEqual({ all: 2, hidden: 0 })
    // shutting the tool pane keeps the sketch: the picked shape's boxes stay on it as the view grows, with its labels
    // still left off, and the pane opens again on the same sketch
    const canvasWidth = () => page.evaluate(() => Math.round((window as unknown as W).__vp.canvas.getBoundingClientRect().width))
    const open = await canvasWidth()
    await clickAt(page, [110, 120])
    await expect(boxOf(page, 'width')).toBeVisible()
    await page.getByTestId('edge-tab-right').click()
    await expect.poll(canvasWidth).toBeGreaterThan(open + 100)
    await expect(page.getByTestId('model-inspector')).toBeHidden()
    await expect(boxOf(page, 'width')).toBeVisible()
    await expect(inputOf(page, 'width')).toHaveValue('30.00')
    await expect.poll(() => dimsDrawn(page)).toEqual({ all: 2, hidden: 2 })
    await page.getByTestId('edge-tab-right').click()
    await expect.poll(canvasWidth).toBe(open)
    await expect(toolPanel(page)).toContainText('The bed')
    await expect(boxOf(page, 'width')).toBeVisible()
  })

  test('with the tool pane shut a sketch keeps going: boxes typed, Tab never stuck, Finish sketch from the keyboard and the ribbon', async ({ page }) => {
    test.slow()
    await sketchOnBed(page)
    const pane = page.getByTestId('model-inspector')
    const canvasWidth = () => page.evaluate(() => Math.round((window as unknown as W).__vp.canvas.getBoundingClientRect().width))
    const sketches = () => page.evaluate(() => (window as unknown as { __sx: { getState(): { timeline: { items: { kind: string }[] } } } }).__sx.getState().timeline.items.filter((i) => i.kind === 'sketch').length)
    const tool = () => page.evaluate(() => (window as unknown as { __sx: { getState(): { objectTool: string | null } } }).__sx.getState().objectTool)
    const open = await canvasWidth()
    const shut = async (drawing = true) => {
      await page.getByTestId('edge-tab-right').click()
      await expect(pane).toBeHidden()
      await expect.poll(canvasWidth).toBeGreaterThan(open + 100)
      if (drawing) await still(page)
    }
    await shut()
    // the sketch is still open with the pane shut
    expect(await tool()).toBe('sketch')
    await expect(page.getByTestId('sketch-finish')).toBeVisible()
    // a rectangle drawn with a real mouse, its sizes typed in the boxes on it
    await page.keyboard.press('r')
    await clickAt(page, [110, 110])
    await move(page, [130, 120])
    await expect(inputOf(page, 'width')).toBeFocused()
    await page.keyboard.type('30')
    await page.keyboard.press('Tab')
    await expect(inputOf(page, 'height')).toBeFocused()
    await page.keyboard.type('20')
    await page.mouse.move(900, 760, { steps: 2 })
    await shot(page, test.info(), 'pane-shut-typed.png')
    await page.keyboard.press('Enter')
    await expect.poll(async () => size((await loops(page))[0])).toEqual([30, 20])
    await expect.poll(() => labels(page)).toEqual(['20', '30'])
    // Tab past the last box goes back to the view while the panel is hidden, never stuck in the boxes
    await clickAt(page, [160, 110])
    await move(page, [170, 120])
    await expect(inputOf(page, 'width')).toBeFocused()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('CANVAS')
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="shape-box"]')).toHaveCount(0)
    expect(await tool()).toBe('sketch')
    // the pane opens on the same sketch, and shuts again
    await page.getByTestId('edge-tab-right').click()
    await expect(toolPanel(page)).toContainText('The bed')
    expect((await loops(page)).length).toBe(1)
    await shut()
    // Ctrl/Cmd+Enter finishes it into the timeline with the pane shut
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect.poll(sketches).toBe(1)
    await expect.poll(tool).toBe(null)

    // a second sketch: opening it opens the pane; shut again, it takes its plane, a circle, and the ribbon's Finish sketch
    await command(page, 'Sketch on the bed or a face')
    await expect(pane).toBeVisible()
    await shut(false)
    await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, bed: [100, 100] })
    await expect.poll(() => page.evaluate(() => (window as unknown as W).__sketch() !== null)).toBe(true)
    await still(page)
    await page.keyboard.press('c')
    await clickAt(page, [120, 120])
    await move(page, [126, 120])
    await expect(inputOf(page, 'diameter')).toBeFocused()
    await page.keyboard.type('10')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await loops(page))[0]?.diameterMm).toBe(10)
    await page.getByTestId('sketch-finish').click()
    await expect.poll(sketches).toBe(2)
    await expect.poll(tool).toBe(null)
    await expect(pane).toBeHidden()
  })

  test('a picked shape under the view buttons keeps its boxes clear of them', async ({ page }) => {
    test.slow()
    await sketchOnBed(page)
    // a rectangle whose Height box would land at the view's top right: draw it at the corner of the view
    const corner = await page.evaluate(() => {
      const vp = (window as unknown as W).__vp
      const r = vp.canvas.getBoundingClientRect()
      return { right: r.right, top: r.top }
    })
    await page.keyboard.press('r')
    // a point of the sketch plane near the view's top right, found by walking the plane until it is there
    const near = await page.evaluate((c) => {
      const vp = (window as unknown as W).__vp
      const f = vp.sketchLayer.scene!.frame
      let best: V2 = [100, 100]
      let bestD = Infinity
      for (let x = 0; x <= 250; x += 2)
        for (let y = 0; y <= 250; y += 2) {
          const s = vp.screenOf([0, 1, 2].map((k) => f.origin[k]! + f.u[k]! * x + f.v[k]! * y))
          const d = Math.hypot(s[0] - (c.right - 120), s[1] - (c.top + 70))
          if (d < bestD) [best, bestD] = [[x, y], d]
        }
      return best
    }, corner)
    await clickAt(page, near)
    await move(page, [near[0] - 10, near[1] - 6])
    await expect(boxOf(page, 'height')).toBeVisible()
    expect((await boxesOverControls(page)).over).toBe(0)
    await shot(page, test.info(), 'corner-live.png')
  })
  // 'a client reads the open sketch boxes and sets one' is app-link-sketch-boxes.test.ts (read and set through __sketchBoxes).
})

// ---- sketch-edit
// The sketch's edit tools: Trim (T) shows in red what a click takes off, and trimming two crossing rectangles down to
// their outline leaves one closed profile that extrudes; Extend runs a line on to the next curve; Mirror and Pattern
// add copies from the Select panel.
test.describe('sketch-edit', () => {
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

  async function sketchOnBedEdit(page: Page) {
    await studio(page)
    return sketchOnBed(page)
  }

  test('T trims two crossing rectangles to their outline, and the one profile left extrudes', async ({ page }) => {
    test.slow()
    const panel = await sketchOnBedEdit(page)
    await page.locator('body').press('r')
    await sketchAt(page, 'click', [10, 10])
    await sketchAt(page, 'click', [20, 20])
    await sketchAt(page, 'click', [15, 15])
    await sketchAt(page, 'click', [25, 25])
    await expect.poll(() => profiles(page)).toBe(2)

    await page.locator('body').press('t')
    await expect(panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Trim' })).toHaveAttribute('aria-checked', 'true')
    await expect(panel).toContainText('Click a piece of a curve to remove')
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

  test('Extend runs a line on to the next one; Mirror and Pattern add copies of a loop', async ({ page }) => {
    test.slow()
    const panel = await sketchOnBedEdit(page)
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
    await expect(panel).toContainText('Click the line to mirror across')
    await sketchAt(page, 'click', [30, 25])
    await expect.poll(() => profiles(page)).toBe(2)
    await expect(panel).not.toContainText('Click the line to mirror across')
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
})

// ---- sketch-finish
// Finish sketch, as in Fusion: a sketch on the XZ plane finishes into the timeline without a solid, shows in the
// strip and the tree, and its menu extrudes it into a body whose feature names the sketch.
test.describe('sketch-finish', () => {
  type Item = { kind: 'sketch'; id: string; name: string } | { kind: 'feature'; body: string; sketch?: string }
  type Sx = { getState(): { plate: { id: string; history?: { steps: { sketch?: string }[] } }[]; timeline: { items: Item[]; marker: number }; objectTool: string | null }; setState(p: unknown): void }
  const sx = (page: Page) => page.evaluate(() => {
    const s = (window as unknown as { __sx: Sx }).__sx.getState()
    return { plate: s.plate.map((e) => ({ id: e.id, sketches: e.history?.steps.map((st) => st.sketch ?? null) ?? [] })), items: s.timeline.items, marker: s.timeline.marker, tool: s.objectTool }
  })

  test('a sketch on XZ finishes into the timeline, then extrudes from its menu', async ({ page }) => {
    test.slow()
    await studio(page)
    await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
    await designTab(page)
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
    // the size of the shape after its first point: the boxes on the shape
    const sizes = page.getByRole('group', { name: 'Sizes of the shape being drawn' })
    await field.getByLabel('X mm').fill('0')
    await field.getByLabel('Y mm').fill('0')
    await field.getByLabel('Y mm').press('Enter')
    await sketchAt(page, 'hover', [0, 0])
    await page.locator('body').press('3')
    await sizes.getByLabel('Width mm').fill('20')
    await sizes.getByLabel('Height mm').fill('10')
    await sizes.getByLabel('Height mm').press('Enter')

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

  test('Ctrl/Cmd+Enter finishes the sketch, a bare Enter does not, and undo takes the finished sketch back out', async ({ page }) => {
    await studio(page)
    await designTab(page)
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

  test('Join from a finished sketch picks the only body, and the step joins it', async ({ page }) => {
    test.slow()
    await studio(page)
    const id = await freshBox(page)
    // on the XZ plane, which runs through the middle of the bed, so the join reaches the body
    await page.evaluate((id) => {
      const sx = (window as unknown as { __sx: { getState(): { plate: { id: string; transform: number[] }[] }; setState(p: unknown): void } }).__sx
      sx.setState({ plate: sx.getState().plate.map((e) => (e.id === id ? { ...e, transform: e.transform.map((v, i) => (i === 12 || i === 13 ? 128 : v)) } : e)) })
    }, id)
    await expect.poll(async () => (await bounds(page, id)).min[0]).toBeLessThan(120)
    await designTab(page)
    const body = (await sx(page)).plate
    expect(body).toHaveLength(1)
    await command(page, 'Sketch on the bed or a face')
    const panel = toolPanel(page)
    await expect(panel).toContainText('Click an origin plane')
    await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, originPlane: 'xz' })
    await expect(panel).toContainText('The XZ plane')
    await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Circle' }).click()
    // a circle on the box's +X edge (the XZ plane's x is the bed's x less the bed's middle), so the join adds material
    const edge = (await bounds(page, id)).max[0] - 128
    await sketchAt(page, 'click', [edge, 4])
    await sketchAt(page, 'click', [edge + 3, 4])
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
})

// ---- sketch-planes
// Sketching starts on an origin plane like it does in Fusion: the planes show at the origin, and picking one turns
// the camera square on to it.
test.describe('sketch-planes', () => {
  // 'the XZ origin plane takes a sketch, with the camera square on to it' is the first step of the sketch-finish test above
  // (the XZ plane, the camera looking along +Y).

  /** Moves the camera at once: turned about the vertical through its target, then moved toward it by `zoom`. */
  async function moveCamera(page: Page, turnDeg: number, zoom: number): Promise<void> {
    await page.evaluate(
      ({ turnDeg, zoom }) => {
        type V = { x: number; y: number; z: number; clone(): V; sub(v: V): V; add(v: V): V; multiplyScalar(n: number): V; applyAxisAngle(a: V, r: number): V; set(x: number, y: number, z: number): V }
        const vp = (window as unknown as { __vp: { camera: { position: V; up: V }; controls: { target: V }; rig: { go(p: { pos: V; target: V }, animate: boolean, now: number): void }; invalidate(): void } }).__vp
        const target = vp.controls.target.clone()
        const off = vp.camera.position.clone().sub(target).applyAxisAngle(vp.camera.up.clone(), (turnDeg * Math.PI) / 180).multiplyScalar(zoom)
        vp.rig.go({ pos: target.clone().add(off), target }, false, performance.now())
        vp.invalidate()
      },
      { turnDeg, zoom },
    )
  }

  /** Each shown plane name's distance in px from where its 3D corner projects now. */
  function nameDrift(page: Page): Promise<{ plane: string; px: number }[]> {
    return page.evaluate(() => {
      type V = { x: number; y: number; z: number; clone(): V; project(c: unknown): V }
      const vp = (window as unknown as { __vp: { camera: unknown; canvas: HTMLCanvasElement; originPlanes: { names(): { name: string; at: V }[] } } }).__vp
      const rect = vp.canvas.getBoundingClientRect()
      return vp.originPlanes.names().flatMap(({ name, at }) => {
        const el = document.querySelector<HTMLElement>(`.vp-plane-name[data-plane="${name.toLowerCase()}"]`)
        if (!el || el.style.display === 'none') return []
        const v = at.clone().project(vp.camera)
        const x = rect.left + ((v.x + 1) / 2) * rect.width
        const y = rect.top + ((1 - v.y) / 2) * rect.height
        return [{ plane: name, px: Math.hypot(parseFloat(el.style.left) - x, parseFloat(el.style.top) - y) }]
      })
    })
  }

  test('the plane names follow their corners when the camera turns and zooms', async ({ page }) => {
    await studio(page)
    await command(page, 'Sketch on the bed or a face')
    await expect(toolPanel(page)).toContainText('Click an origin plane (XY, XZ or YZ)')
    // Model frames the part on open with an eased move, close enough that a turn can take a corner off screen: once it
    // stops, start from the whole plate so every turn and zoom below keeps the names in view
    await page.waitForFunction(() => (window as unknown as { __vp: { rig: { move: unknown } } }).__vp.rig.move === null)
    await page.evaluate(() => (window as unknown as { __vp: { view(p: string): void; invalidate(): void } }).__vp.view('plate'))
    for (const [turn, zoom] of [
      [60, 1],
      [0, 0.6],
      [-90, 1.4],
    ] as const) {
      await moveCamera(page, turn, zoom)
      await expect.poll(async () => (await nameDrift(page)).length, { timeout: 5000 }).toBeGreaterThan(0)
      await expect.poll(async () => Math.max(...(await nameDrift(page)).map((d) => d.px)), { timeout: 5000 }).toBeLessThanOrEqual(2)
    }
  })
})

// ---- sketch-tools
// The sketch tool families and the ways to draw each: keys pick line, rectangle and circle as in Fusion, the row
// below the families picks the variant, and each tool's shape reaches the timeline when the sketch is finished.
test.describe('sketch-tools', () => {
  type Loop = { type?: 'circle'; start?: [number, number]; segments?: { type: 'line' | 'arc' }[]; construction?: true }
  const loops = (page: Page) =>
    page.evaluate(() => {
      const s = (window as unknown as { __sx: { getState(): { timeline: { items: { kind: string; loops?: unknown[] }[] } } } }).__sx.getState()
      return (s.timeline.items.find((i) => i.kind === 'sketch')?.loops ?? []) as Loop[]
    })

  test('keys and the variant row draw a circle, a 3-point rectangle, a pentagon, a slot and a tangent arc', async ({ page }) => {
    test.slow()
    await studio(page)
    await designTab(page)
    await command(page, 'Sketch on the bed or a face')
    const panel = toolPanel(page)
    await expect(panel).toContainText('Click an origin plane')
    await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, bed: [100, 100] })
    await expect(panel).toContainText('The bed')
    const families = panel.getByRole('radiogroup', { name: 'Drawing tool' })
    const variants = panel.getByRole('radiogroup', { name: 'Draw it by' })
    const dof = panel.getByRole('status').filter({ hasText: /DOF left|Defined/ })
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

  test('X makes a picked line construction, and it reaches the timeline flagged', async ({ page }) => {
    test.slow()
    await studio(page)
    await designTab(page)
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

  test('L, clicks and a drag off the end draw a closed shape with a tangent arc, and its glyphs', async ({ page }) => {
    test.slow()
    await studio(page)
    await designTab(page)
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
})

// ---- sketch-panel-cards
// The sketch panel's two cards and the numbers on the view: a line drawn with a typed length and angle in the boxes on
// it (Tab between them), the first point's pills staying in the view and off the point, the boxes inside the view with
// typed and live numbers reading apart, the solid card
// folded with its reason until a closed profile opens it, the tool's name in the Drawing header, Flip beside Direction,
// Grid and Snap on one row and independent, Other plane by the face label, the view's mode pill and Look at the sketch
// among the camera buttons, and nothing in the panel moving as tools are picked or the solid card opens.
test.describe('sketch-panel-cards', () => {
  const top = async (page: Page, testid: string): Promise<number> => (await page.getByTestId(testid).boundingBox())!.y

  /** A hover or click at plane point `at`, with the pointer at client `screen`. */
  async function sketchAtScreen(page: Page, kind: 'hover' | 'click', at: [number, number], screen: [number, number]): Promise<void> {
    await page.evaluate(({ kind, at, screen }) => {
      const vp = (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp
      vp.emit('sketch', { kind, at, mmPerPx: 0.2, screen, shift: false, alt: false })
    }, { kind, at, screen })
  }

  /** The 3D view's box on the page. */
  const viewBox = (page: Page) =>
    page.evaluate(() => {
      const r = (window as unknown as { __vp: { canvas: HTMLCanvasElement } }).__vp.canvas.getBoundingClientRect()
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    })

  test('a line takes a typed length and angle in the boxes on it, Tab moving between them, and its actions fit the pane', async ({ page }) => {
    await sketchOnTop(page)
    const pills = page.getByTestId('sketch-pills')
    const boxes = page.getByRole('group', { name: 'Sizes of the shape being drawn' })
    // the first point's pills are X and Y, following the cursor
    await sketchAt(page, 'hover', [2, 3])
    await expect(pills).toBeVisible()
    await expect(pills.locator('[data-label="X"]')).toContainText('2.00')
    await expect(pills.locator('[data-label="Y"]')).toContainText('3.00')
    await sketchAt(page, 'click', [0, 0])
    // then length and angle on the line, the keyboard in Length first; the pills are gone
    await sketchAt(page, 'hover', [5, 0])
    const length = boxes.getByRole('textbox', { name: 'Length mm' })
    const angle = boxes.getByRole('textbox', { name: 'Angle °' })
    await expect(length).toHaveValue('5.00')
    await expect(angle).toHaveValue('0.0')
    await expect(boxes.locator('[data-box="length"]')).toHaveAttribute('data-focus', '')
    await expect(length).toBeFocused()
    await expect(pills).toBeHidden()
    // typing replaces the picked live value; Tab goes on to the angle
    await page.keyboard.press('2')
    await page.keyboard.press('0')
    await expect(length).toHaveValue('20')
    await length.press('Tab')
    await expect(angle).toBeFocused()
    await angle.fill('90')
    await angle.press('Enter')
    await expect(boxes.locator('[data-typed]')).toHaveCount(0)
    // the line ends there: 20 mm straight up the face
    await page.locator('body').press('Escape')
    await toolPanel(page).getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Select' }).click()
    await sketchAt(page, 'click', [0, 10])
    await expect(page.getByTestId('sketch-picked')).toHaveText('Line, 20.00 mm')
    // the picked loop's actions wrap inside the pane: none runs past its edge or sits clipped under it
    const actions = toolPanel(page).locator('.sketch-loop-actions')
    for (const name of ['Mirror', 'Construction', 'Delete loop']) {
      const button = actions.getByRole('button', { name, exact: true })
      await button.scrollIntoViewIfNeeded()
      const [b, row] = [(await button.boundingBox())!, (await actions.boundingBox())!]
      expect(b.x, name).toBeGreaterThanOrEqual(row.x)
      expect(b.x + b.width, name).toBeLessThanOrEqual(row.x + row.width + 1)
      expect(await button.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return el.contains(document.elementFromPoint(r.right - 2, r.y + r.height / 2))
      }), `${name} is not clipped`).toBe(true)
    }
  })

  test('the solid card opens on a closed profile, and nothing above it moves', async ({ page }) => {
    await sketchOnTop(page)
    const panel = toolPanel(page)
    const solid = page.getByTestId('sketch-solid')
    await expect(solid).toHaveAttribute('data-muted', '')
    await expect(solid.locator('.tp-card-reason')).toHaveText('Draw a closed outline to make a solid.')
    await expect(solid.getByRole('radiogroup', { name: 'Result' })).toHaveCount(0)
    await expect(panel.getByTestId('model-tool-apply')).toBeDisabled()

    // the view's pill names the mode and the tool, and so does the Drawing card's header; no box repeats it
    await expect(page.getByTestId('model-select-readout')).toHaveText('Sketching on a face · Line')
    await expect(page.getByTestId('sketch-drawing').locator('h4')).toHaveText('Drawing · Line')
    await expect(page.getByTestId('sketch-variant-one')).toHaveCount(0)
    // Line has one way to draw: no variant row, no empty space for one
    await expect(panel.locator('.sketch-variants')).toHaveCount(0)

    // picking a tool never moves the tools themselves; a family with ways shows them below, one row's height, and the
    // solid card moves only by that row
    const families = panel.getByRole('radiogroup', { name: 'Drawing tool' })
    const solidY = await top(page, 'sketch-solid')
    const toolsBox = await families.boundingBox()
    const shifts = new Set<number>()
    for (const name of ['Rectangle', 'Circle', 'Arc', 'Polygon', 'Slot', 'Trim', 'Dimension', 'Line']) {
      const radio = families.getByRole('radio', { name })
      const before = await radio.boundingBox()
      await radio.click()
      await expect(radio).toHaveAttribute('aria-checked', 'true')
      expect(await radio.boundingBox()).toEqual(before)
      await expect(radio).toBeFocused()
      const row = await panel.locator('.sketch-variants').count()
      const shift = (await top(page, 'sketch-solid')) - solidY
      if (row) shifts.add(shift)
      else expect(shift).toBe(0)
      await expect(page.getByTestId('sketch-drawing').locator('h4')).toHaveText(`Drawing · ${name}`)
    }
    // every family with ways moves the card by the same row height
    expect(shifts.size).toBe(1)
    expect([...shifts][0]).toBeGreaterThan(0)
    expect(await families.boundingBox()).toEqual(toolsBox)
    await expect(page.getByTestId('model-select-readout')).toHaveText('Sketching on a face · Line')

    // an open line keeps it folded, with the open loop as its reason
    await sketchAt(page, 'click', [-6, -6])
    await sketchAt(page, 'click', [6, -6])
    await sketchAt(page, 'click', [6, 6])
    await page.locator('body').press('Escape')
    await expect(solid).toHaveAttribute('data-muted', '')
    await expect(solid.locator('.tp-card-reason')).not.toHaveText('Draw a closed outline to make a solid.')
    expect(await top(page, 'sketch-solid')).toBe(solidY)

    // a closed rectangle opens it below, the drawing card where it was (Rectangle's ways row is already there)
    await page.locator('body').press('r')
    await expect(panel.locator('.sketch-variants')).toHaveCount(1)
    const drawing = await page.getByTestId('sketch-drawing').boundingBox()
    const solidAt = await top(page, 'sketch-solid')
    await sketchAt(page, 'click', [-3, -3])
    await sketchAt(page, 'click', [3, 3])
    await expect(solid).not.toHaveAttribute('data-muted')
    await expect(solid.locator('.tp-card-reason')).toHaveCount(0)
    await expect(solid.getByRole('radiogroup', { name: 'Result' })).toBeVisible()
    expect(await page.getByTestId('sketch-drawing').boundingBox()).toEqual(drawing)
    expect(await top(page, 'sketch-solid')).toBe(solidAt)
    // Extrude or Revolve heads the open card; Direction and Result are words, with no marks
    await expect(solid.getByRole('radiogroup', { name: 'Finish with' }).getByRole('radio', { name: 'Extrude' })).toHaveAttribute('aria-checked', 'true')
    for (const [group, names] of [['Direction', ['One side', 'Symmetric', 'Two sides']], ['Result', ['Join', 'Cut', 'New body']]] as const)
      for (const name of names) {
        const radio = solid.getByRole('radiogroup', { name: group }).getByRole('radio', { name })
        await expect(radio).toHaveText(name)
        await expect(radio.locator('svg')).toHaveCount(0)
      }
  })

  // 960 px tall, not 900: the Model ribbon with its default large icons is 112 px tall, so at 900 the Solid card's fields
  // start under the footer's fade and scroll into reach (sketch-panel-behavior's footer test covers 900 px and shorter)
  test('at 1440 by 960 Distance and Draft show above the footer with the solid card open', async ({ page }) => {
    await studio(page)
    await page.setViewportSize({ width: 1440, height: 960 })
    await sketchOnTopRaw(page)
    await page.locator('body').press('r')
    await sketchAt(page, 'click', [-3, -3])
    await sketchAt(page, 'click', [3, 3])
    await expect(page.getByTestId('sketch-solid')).not.toHaveAttribute('data-muted')
    const panel = toolPanel(page)
    await expect(panel.getByTestId('model-tool-apply')).toBeEnabled()
    const footer = (await panel.locator('.cad-footer').boundingBox())!
    for (const id of ['#sk-dist', '#sk-taper']) {
      const b = (await panel.locator(id).boundingBox())!
      // clear of the footer and the fade above it
      expect(b.y + b.height).toBeLessThanOrEqual(footer.y - 24)
    }
    // the units sit beside the labels, each on one line, and the fields hold only the numbers
    for (const [id, text] of [['sk-dist', 'Distance mm'], ['sk-taper', 'Draft °']] as const) {
      const label = panel.locator(`label[for="${id}"]`)
      await expect(label).toHaveText(text)
      expect((await label.boundingBox())!.height).toBeLessThan(22)
      await expect(panel.locator(`#${id}`)).toHaveValue(/^-?[0-9.]+$/)
      await expect(panel.locator('.sx-inputwrap').filter({ has: page.locator(`#${id}`) }).locator('.sx-inputwrap-unit')).toHaveCount(0)
    }
    // Symmetric's longer label still fits on one line
    await panel.getByRole('radiogroup', { name: 'Direction' }).getByRole('radio', { name: 'Symmetric' }).click()
    await expect(panel.locator('label[for="sk-dist"]')).toHaveText('Total distance mm')
    expect((await panel.locator('label[for="sk-dist"]').boundingBox())!.height).toBeLessThan(22)
  })

  test('Flip beside Direction sends a join into the face instead of out of it', async ({ page }) => {
    test.slow()
    for (const flipped of [false, true]) {
      const id = await sketchOnTop(page)
      const panel = toolPanel(page)
      await page.locator('body').press('r')
      await sketchAt(page, 'click', [-4, -4])
      await sketchAt(page, 'click', [4, 4])
      await expect(page.getByTestId('sketch-solid')).not.toHaveAttribute('data-muted')
      await expect(panel.getByRole('radiogroup', { name: 'Result' }).getByRole('radio', { name: 'Join' })).toHaveAttribute('aria-checked', 'true')
      const flip = panel.getByTestId('sketch-flip')
      await expect(flip).toHaveAttribute('aria-pressed', 'false')
      // Flip sits on Direction's label line, at the right edge, above the choice and clear of it
      const direction = (await panel.getByRole('radiogroup', { name: 'Direction' }).boundingBox())!
      const label = (await panel.locator('#sk-direction-label').boundingBox())!
      const fb = (await flip.boundingBox())!
      expect(Math.abs(fb.y + fb.height / 2 - (label.y + label.height / 2))).toBeLessThan(3)
      expect(Math.abs(fb.x + fb.width - (direction.x + direction.width))).toBeLessThan(2)
      expect(fb.y + fb.height).toBeLessThanOrEqual(direction.y)
      if (flipped) {
        const fill = () => flip.evaluate((el) => getComputedStyle(el).backgroundColor)
        const off = await fill()
        await flip.click()
        await expect(flip).toHaveAttribute('aria-pressed', 'true')
        // pressed reads as on: a different fill, under the pointer and away from it, the same size
        await expect.poll(fill).not.toBe(off)
        await page.mouse.move(0, 0)
        await expect.poll(fill).not.toBe(off)
        expect(await flip.boundingBox()).toEqual(fb)
      }
      await panel.locator('#sk-dist').fill('5')
      await panel.getByTestId('model-tool-apply').click()
      await expect(panel).toHaveCount(0, { timeout: 30_000 })
      // out of the top face it grows 5 mm; flipped it goes into the box and the height stays
      await expect.poll(() => height(page, id), { timeout: 30_000 }).toBe(flipped ? 20 : 25)
    }
  })

  test('Other plane by the face label picks another plane; Look at the sketch is among the camera buttons', async ({ page }) => {
    await sketchOnTop(page)
    const panel = toolPanel(page)
    // the bottom row is only Cancel and the primary
    const footer = panel.locator('.cad-footer')
    await expect(footer.getByRole('button')).toHaveText(['Cancel', 'Extrude'])
    // Other plane sits in the header, right after the face label
    const other = panel.getByTestId('sketch-other-plane')
    await expect(other).toHaveText('Other plane')
    await expect(page.getByTestId('model-tool-state').locator('xpath=..').getByTestId('sketch-other-plane')).toHaveCount(1)
    // Cancel and the primary sit at opposite edges of the footer
    const [cancel, primary, row] = [await footer.getByTestId('model-tool-cancel').boundingBox(), await footer.getByTestId('model-tool-apply').boundingBox(), await footer.boundingBox()]
    expect(cancel!.x - row!.x).toBeLessThan(40)
    expect(row!.x + row!.width - (primary!.x + primary!.width)).toBeLessThan(40)
    // Look at the sketch shows in the view while sketching
    await expect(page.getByTestId('sketch-look')).toBeVisible()
    await page.getByTestId('sketch-look').click()
    await other.click()
    await expect(panel).toContainText('Click an origin plane')
    await expect(page.getByTestId('sketch-look')).toHaveCount(0)
    await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, bed: [100, 100] })
    await expect(panel).toContainText('The bed')
    await expect(page.getByTestId('model-select-readout')).toHaveText('Sketching on the bed · Line')
    await expect(page.getByTestId('sketch-look')).toBeVisible()
    // closing the tool puts the pill back to the selection
    await panel.getByTestId('model-tool-cancel').click()
    await expect(page.getByTestId('model-select-readout')).not.toContainText('Sketching')
    await expect(page.getByTestId('sketch-look')).toHaveCount(0)
  })

  test('Grid and Snap share a row and stay apart: snapping works with the grid hidden, and Off stops it', async ({ page }) => {
    await sketchOnTop(page)
    const panel = toolPanel(page)
    const row = panel.getByTestId('sketch-grid-snap')
    await expect(row.locator('#sk-grid')).toBeVisible()
    await expect(row.locator('#sk-step')).toBeVisible()
    const [g, sn] = [(await row.locator('#sk-grid').boundingBox())!, (await row.locator('#sk-step').boundingBox())!]
    expect(Math.abs(g.y + g.height / 2 - (sn.y + sn.height / 2))).toBeLessThan(3)
    // Section has its own row
    await expect(row.locator('#sk-section')).toHaveCount(0)
    await expect(panel.locator('#sk-section')).toBeVisible()
    await expect(row.locator('#sk-step option').first()).toHaveText('Off')
    // the grid hidden, a 5 mm snap still holds the first point to its step
    await row.locator('#sk-grid').click()
    await expect(row.locator('#sk-grid')).not.toBeChecked()
    await row.locator('#sk-step').selectOption({ label: '5 mm' })
    const pills = page.getByTestId('sketch-pills')
    await sketchAt(page, 'hover', [2.2, 3.1])
    await expect(pills.locator('[data-label="X"]')).toContainText('0.00')
    await expect(pills.locator('[data-label="Y"]')).toContainText('5.00')
    // Off places it where the cursor is
    await row.locator('#sk-step').selectOption('off')
    await sketchAt(page, 'hover', [2.2, 3.1])
    await expect(pills.locator('[data-label="X"]')).toContainText('2.20')
    await expect(pills.locator('[data-label="Y"]')).toContainText('3.10')
    await expect(row.locator('#sk-grid')).not.toBeChecked()
    // the grid and the snap step are the panel's own memory for the whole visit: put them back for the next sketch
    await row.locator('#sk-grid').click()
    await expect(row.locator('#sk-grid')).toBeChecked()
    await row.locator('#sk-step').selectOption('1')
  })

  test('the pills stay in the view and off the point; the boxes stay in the view; typed numbers read apart; Tab, Enter and Esc', async ({ page }) => {
    await sketchOnTop(page)
    // the sketch turns the camera square on as it opens, and the boxes follow the shape through it: wait for the view
    // to stop before reading where a box is, or the read before the hover and the read after it differ by the camera's move
    await still(page)
    const pills = page.getByTestId('sketch-pills')
    const boxes = page.getByRole('group', { name: 'Sizes of the shape being drawn' })
    const view = await viewBox(page)
    const frame = (name: string) => shot(page, test.info(), `pills-${name}.png`, { x: view.left, y: view.top, width: view.right - view.left, height: view.bottom - view.top })
    const inside = (b: { x: number; y: number; width: number; height: number }) => {
      expect(b.x).toBeGreaterThanOrEqual(view.left)
      expect(b.y).toBeGreaterThanOrEqual(view.top)
      expect(b.x + b.width).toBeLessThanOrEqual(view.right)
      expect(b.y + b.height).toBeLessThanOrEqual(view.bottom)
    }
    const clear = async (cursor: [number, number]) => {
      const b = (await pills.boundingBox())!
      inside(b)
      // and not over the point under the cursor, with room for the point's mark
      const off = cursor[0] < b.x - 4 || cursor[0] > b.x + b.width + 4 || cursor[1] < b.y - 4 || cursor[1] > b.y + b.height + 4
      expect(off).toBe(true)
    }
    // the first point's pills follow the cursor: in the middle, below and right of it
    const mid: [number, number] = [Math.round((view.left + view.right) / 2), Math.round((view.top + view.bottom) / 2)]
    await sketchAtScreen(page, 'hover', [0, 0], mid)
    await expect(pills.locator('[data-label="X"]')).toContainText('0.00')
    await clear(mid)
    await frame('1-live')
    // at the right edge, the bottom edge and the corner: flipped to the other side, still inside
    const edges: [string, [number, number]][] = [
      ['2-right', [view.right - 6, mid[1]]],
      ['3-bottom', [mid[0], view.bottom - 6]],
      ['4-corner', [view.right - 6, view.bottom - 6]],
    ]
    for (const [name, at] of edges) {
      await sketchAtScreen(page, 'hover', [0, 0], at)
      await clear(at)
      await frame(name)
    }
    await sketchAt(page, 'click', [0, 0])
    // from the first click the sizes are boxes on the line, inside the view
    await sketchAtScreen(page, 'hover', [5, 0], mid)
    const length = boxes.getByRole('textbox', { name: 'Length mm' })
    const angle = boxes.getByRole('textbox', { name: 'Angle °' })
    const lengthBox = boxes.locator('[data-box="length"]')
    const angleBox = boxes.locator('[data-box="angle"]')
    await expect(length).toHaveValue('5.00')
    await expect(pills).toBeHidden()
    for (const b of [lengthBox, angleBox]) inside((await b.boundingBox())!)
    // live: the keyboard is in Length with its value picked. Typing replaces it and marks the box, so typed and live
    // read apart
    await expect(length).toBeFocused()
    await expect(lengthBox).not.toHaveAttribute('data-typed')
    const liveBg = await lengthBox.evaluate((el) => getComputedStyle(el).backgroundColor)
    await page.keyboard.press('1')
    await page.keyboard.press('2')
    await expect(length).toHaveValue('12')
    await expect(lengthBox).toHaveAttribute('data-typed', '')
    await expect(angleBox).not.toHaveAttribute('data-typed')
    expect(await lengthBox.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(liveBg)
    // the angle still shows the live value
    await expect(angle).toHaveValue('0.0')
    await frame('5-typed')
    // Tab goes to the angle, Shift+Tab back
    await length.press('Tab')
    await expect(angle).toBeFocused()
    await angle.press('Shift+Tab')
    await expect(length).toBeFocused()
    await length.press('Tab')
    await angle.fill('30')
    // with both typed the line is set: its boxes hold still wherever the cursor goes
    const held = (await lengthBox.boundingBox())!
    await sketchAtScreen(page, 'hover', [-5, 4], [mid[0] - 200, mid[1] - 120])
    const now = (await lengthBox.boundingBox())!
    expect([now.x, now.y]).toEqual([held.x, held.y])
    await frame('6-tab-angle')
    // Esc clears the typed angle first (it shows the live angle again, Length still typed), then in a box with nothing
    // typed it drops the line being drawn; the tool stays
    await angle.press('Escape')
    await expect(angleBox).not.toHaveAttribute('data-typed')
    await expect(lengthBox).toHaveAttribute('data-typed', '')
    await expect(angle).toBeFocused()
    await angle.press('Escape')
    await expect(boxes).toHaveCount(0)
    await expect(page.getByTestId('sketch-drawing').locator('h4')).toHaveText('Drawing · Line')
    await frame('7-escape')
    // Enter places the typed point: 12 mm at 90 degrees from the start
    await sketchAt(page, 'click', [0, 0])
    await sketchAt(page, 'hover', [5, 0])
    await expect(length).toBeFocused()
    await page.keyboard.type('12')
    await length.press('Tab')
    await angle.fill('90')
    await angle.press('Enter')
    await expect(boxes.locator('[data-typed]')).toHaveCount(0)
    await frame('8-enter')
    await page.locator('body').press('Escape')
    await toolPanel(page).getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Select' }).click()
    await sketchAt(page, 'click', [0, 6])
    await expect(page.getByTestId('sketch-picked')).toHaveText('Line, 12.00 mm')
  })

  test('Show chips: one row when the four fit the real width, two by two when not, never clipped or shrunk', async ({ page }) => {
    await sketchOnTop(page)
    const m = await page.evaluate(() => {
      const show = document.querySelector('.sketch-show') as HTMLElement
      const chips = [...show.querySelectorAll<HTMLElement>('.tp-chip')]
      const label = show.querySelector('.tp-label') as HTMLElement
      const gap = parseFloat(getComputedStyle(show.querySelector('.tp-chips')!).columnGap)
      // what each chip needs, measured in place
      const need = chips.map((b) => {
        const was = b.style.width
        b.style.width = 'max-content'
        const w = b.getBoundingClientRect().width
        b.style.width = was
        return w
      })
      // the columns are equal: one row takes four of the widest chip and three gaps, beside the label
      const oneRow = label.getBoundingClientRect().width + parseFloat(getComputedStyle(show).columnGap) + Math.max(...need) * 4 + gap * 3
      const tops = new Set(chips.map((b) => Math.round(b.getBoundingClientRect().top)))
      return {
        width: show.getBoundingClientRect().width,
        oneRow,
        rows: tops.size,
        clipped: chips.filter((b) => b.scrollWidth > b.clientWidth + 0.5).map((b) => b.textContent),
        heights: chips.map((b) => b.getBoundingClientRect().height),
        font: parseFloat(getComputedStyle(chips[0]!).fontSize),
        pressed: chips.map((b) => b.getAttribute('aria-pressed')),
        // the compact control height token, as the look and feel sets it (28 px at the default density)
        token: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--h-sm')),
      }
    })
    expect(m.rows).toBe(m.oneRow <= m.width ? 1 : 2)
    expect(m.clipped).toEqual([])
    for (const h of m.heights) expect(h).toBe(m.token)
    expect(m.font).toBeGreaterThanOrEqual(12)
    expect(m.pressed).toEqual(['true', 'true', 'true', 'true'])
    test.info().annotations.push({ type: 'chips', description: `row ${m.width}px, one row needs ${m.oneRow.toFixed(1)}px: ${m.rows} rows` })
  })
})

// ---- sketch-panel-behavior
// How the sketch panel behaves, beyond how it looks: lengths and angles typed in the boxes on the line land the
// committed end where they say, the sketch steps back and on with its own undo, the keyboard never gets stuck in the
// boxes and Esc steps back one level at a time, Finish sketch and Extrude stay apart (one primary at a time, Finish sketch while drawing
// and Extrude for a valid profile, and a bare Enter finishes nothing), every reason Extrude or Revolve is off shows, the footer never covers a setting at 900 px tall or less,
// and Other plane asks before it drops a drawing. On a phone, the folded sheet opens to every control and stays open.
test.describe('sketch-panel-behavior', () => {
  type Loop = { start?: [number, number]; segments?: { type: string; to: [number, number] }[]; type?: string }
  interface SketchRead {
    tool: string
    profile?: string
    dof?: number | null
    ready?: boolean
    reason?: string | null
    loops?: Loop[]
  }

  /** The open sketch as app_state's `sketch` is built from it. */
  const read = (page: Page) => page.evaluate(() => (window as unknown as { __sketch: () => SketchRead | null }).__sketch())

  const DEG = Math.PI / 180

  /** A hover with Alt held, so no snap moves the cursor off the exact spot. */
  const hoverFree = (page: Page, at: [number, number]) =>
    page.evaluate((at) => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('sketch', { kind: 'hover', at, mmPerPx: 0.2, screen: [700, 420], shift: false, alt: true }), at)
  const near = (got: [number, number], want: [number, number]) => {
    expect(got[0]).toBeCloseTo(want[0], 4)
    expect(got[1]).toBeCloseTo(want[1], 4)
  }

  /** Ctrl/Cmd+Z until the sketch is empty again, one step at a time. */
  async function undoAll(page: Page): Promise<void> {
    for (let i = 0; i < 12 && (await read(page))?.profile !== 'none'; i++) {
      const n = JSON.stringify((await read(page))?.loops)
      await page.locator('body').press('ControlOrMeta+z')
      await expect.poll(async () => JSON.stringify((await read(page))?.loops)).not.toBe(n)
    }
    await expect.poll(async () => (await read(page))?.profile).toBe('none')
  }

  /** The boxes on the shape being drawn: a line's Length and Angle sit on it from its first click. */
  const drawBoxes = (page: Page) => page.getByRole('group', { name: 'Sizes of the shape being drawn' })

  /** Types into the boxes on the line: the keyboard is in Length from the first click, Tab goes on to Angle. */
  async function typeSegment(page: Page, length: string, angle: string): Promise<void> {
    const len = drawBoxes(page).getByRole('textbox', { name: 'Length mm' })
    await expect(len).toBeFocused()
    await len.fill(length)
    await len.press('Tab')
    const ang = drawBoxes(page).getByRole('textbox', { name: 'Angle °' })
    await expect(ang).toBeFocused()
    await ang.fill(angle)
  }

  test('typed length and angle put the committed end where they say, the next segment starts there, and undo steps the sketch only', async ({ page }) => {
    const id = await sketchOnTop(page)
    const before = (await steps(page)).length
    const boxes = drawBoxes(page)
    await sketchAt(page, 'click', [1, 2])
    // the cursor is far from where the numbers say; the numbers win
    await sketchAt(page, 'hover', [-7, 9])
    await typeSegment(page, '12', '30')
    await boxes.getByRole('textbox', { name: 'Angle °' }).press('Enter')
    await expect(boxes.locator('[data-typed]')).toHaveCount(0)
    const first: [number, number] = [1 + 12 * Math.cos(30 * DEG), 2 + 12 * Math.sin(30 * DEG)]
    await expect.poll(async () => (await read(page))?.loops?.[0]?.segments?.length).toBe(1)
    let s = (await read(page))!
    near(s.loops![0]!.start!, [1, 2])
    near(s.loops![0]!.segments![0]!.to, first)
    // the next segment starts at the typed end: the live length reads from there
    await hoverFree(page, [first[0] + 3, first[1] + 4])
    await expect(boxes.getByRole('textbox', { name: 'Length mm' })).toHaveValue('5.00')
    // a second typed segment, 5 mm at 120 degrees, measured the same way
    await typeSegment(page, '5', '120')
    await page.keyboard.press('Enter')
    const second: [number, number] = [first[0] + 5 * Math.cos(120 * DEG), first[1] + 5 * Math.sin(120 * DEG)]
    await expect.poll(async () => (await read(page))?.loops?.[0]?.segments?.length).toBe(2)
    s = (await read(page))!
    near(s.loops![0]!.segments![1]!.to, second)
    // a length of 0 places nothing and says why
    await typeSegment(page, '0', '45')
    await page.keyboard.press('Enter')
    await expect(toolPanel(page)).toContainText('The length must be more than 0 mm.')
    expect((await read(page))!.loops![0]!.segments!.length).toBe(2)
    // Esc frees the typed angle, then drops the segment being drawn
    await boxes.getByRole('textbox', { name: 'Angle °' }).press('Escape')
    await boxes.getByRole('textbox', { name: 'Angle °' }).press('Escape')
    await expect(boxes).toHaveCount(0)
    // Ctrl/Cmd+Z steps the drawing back one segment at a time and redo brings it again; the model's history is untouched
    await page.locator('body').press('ControlOrMeta+z')
    await expect.poll(async () => (await read(page))?.loops?.[0]?.segments?.length ?? 0).toBe(1)
    near((await read(page))!.loops![0]!.segments![0]!.to, first)
    await page.locator('body').press('ControlOrMeta+Shift+z')
    await expect.poll(async () => (await read(page))?.loops?.[0]?.segments?.length).toBe(2)
    expect((await steps(page)).length).toBe(before)
    expect(await page.evaluate((id) => (window as unknown as { __sx: { getState(): { plate: { id: string }[] } } }).__sx.getState().plate.some((e) => e.id === id), id)).toBe(true)
  })

  /** Every preview the view is handed from now on, newest last: where the preview's end sits. */
  async function watchPreview(page: Page): Promise<void> {
    await page.evaluate(() => {
      const w = window as unknown as { __previews: ([number, number] | null)[]; __vp: { setSketchCursor(c: { at?: [number, number] | null } | null): void } }
      w.__previews = []
      const set = w.__vp.setSketchCursor.bind(w.__vp)
      w.__vp.setSketchCursor = (c) => {
        w.__previews.push(c?.at ?? null)
        set(c)
      }
    })
  }
  const lastPreview = (page: Page) => page.evaluate(() => (window as unknown as { __previews: ([number, number] | null)[] }).__previews.at(-1) ?? null)
  const segments = async (page: Page) => (await read(page))?.loops?.[0]?.segments ?? []
  const units = (page: Page, length: 'mm' | 'in') =>
    page.evaluate((length) => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ units: { length, mmDigits: 2, inchDigits: 3, inchFraction: 0 } }), length)

  test('typed numbers move the preview before Enter and land exactly: decimals, a negative angle, inches, inferred level and upright, and bad input refused', async ({ page }) => {
    await sketchOnTop(page)
    await watchPreview(page)
    const boxes = drawBoxes(page)
    const len = () => boxes.getByRole('textbox', { name: /^Length / })
    const ang = () => boxes.getByRole('textbox', { name: /^Angle / })
    // the snap is on (a hover without Alt): the typed numbers still win over the grid
    await sketchAt(page, 'click', [0, 0])
    await sketchAt(page, 'hover', [5, 5])
    // a decimal length moves the preview at once, along the cursor's direction, before any Enter
    await expect(len()).toBeFocused()
    await len().fill('7.25')
    await expect.poll(() => lastPreview(page)).not.toBeNull()
    near((await lastPreview(page))!, [7.25 * Math.cos(45 * DEG), 7.25 * Math.sin(45 * DEG)])
    // a negative decimal angle turns it below the axis, still before Enter
    await len().press('Tab')
    await expect(ang()).toBeFocused()
    await ang().fill('-33.5')
    const typedEnd: [number, number] = [7.25 * Math.cos(-33.5 * DEG), 7.25 * Math.sin(-33.5 * DEG)]
    await expect.poll(async () => (await lastPreview(page))?.[1] ?? 0).toBeLessThan(0)
    near((await lastPreview(page))!, typedEnd)
    expect(await segments(page)).toHaveLength(0)
    // Shift+Tab goes back to the length with both numbers kept, and Enter there commits them
    await ang().press('Shift+Tab')
    await expect(len()).toBeFocused()
    await expect(len()).toHaveValue('7.25')
    await expect(ang()).toHaveValue('-33.5')
    await len().press('Enter')
    await expect.poll(async () => (await segments(page)).length).toBe(1)
    near((await segments(page))[0]!.to, typedEnd)
    // the next segment is an ordinary one: a click places it from the typed end
    const free = (kind: 'hover' | 'click', at: [number, number]) =>
      page.evaluate(({ kind, at }) => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('sketch', { kind, at, mmPerPx: 0.2, screen: [700, 420], shift: false, alt: true }), { kind, at })
    const clicked: [number, number] = [typedEnd[0] + 1.5, typedEnd[1] + 6.5]
    await free('hover', clicked)
    await free('click', clicked)
    await expect.poll(async () => (await segments(page)).length).toBe(2)
    near((await segments(page))[1]!.to, clicked)
    // junk, a negative length and zero change nothing and say why; nothing NaN lands in the sketch
    const before = await segments(page)
    const same = async () => {
      const now = await segments(page)
      expect(now).toHaveLength(before.length)
      now.forEach((g, i) => near(g.to, before[i]!.to))
      for (const g of now) expect(g.to.every(Number.isFinite)).toBe(true)
    }
    for (const [bad, why] of [['abc', 'Type numbers only.'], ['-5', 'The length must be more than 0 mm.'], ['0', 'The length must be more than 0 mm.']] as const) {
      await len().fill(bad)
      await len().press('Enter')
      await expect(toolPanel(page).getByRole('status').filter({ hasText: why })).toBeVisible()
      await same()
    }
    // emptied boxes take the cursor, as a click there would
    await len().fill('')
    await free('hover', [clicked[0] + 4, clicked[1] + 1.3])
    await len().press('Enter')
    await expect.poll(async () => (await segments(page)).length).toBe(3)
    near((await segments(page))[2]!.to, [clicked[0] + 4, clicked[1] + 1.3])
    // inches: a bare 1 is 25.4 mm, and a typed unit wins over the setting; the level and upright ends get their constraints
    await units(page, 'in')
    await expect(boxes.getByRole('textbox', { name: 'Length in' })).toBeFocused()
    await len().fill('1')
    await len().press('Tab')
    await ang().fill('0')
    await ang().press('Enter')
    await expect.poll(async () => (await segments(page)).length).toBe(4)
    const start = (await segments(page))[2]!.to
    near((await segments(page))[3]!.to, [start[0] + 25.4, start[1]])
    await expect(len()).toBeFocused()
    await len().fill('10mm')
    await len().press('Tab')
    await ang().fill('90')
    await ang().press('Enter')
    await expect.poll(async () => (await segments(page)).length).toBe(5)
    near((await segments(page))[4]!.to, [start[0] + 25.4, start[1] + 10])
    const glyphs = () => page.evaluate(() => (window as unknown as { __vp: { sketchLayer: { scene: { glyphs?: { kind: string }[] } | null } } }).__vp.sketchLayer.scene?.glyphs?.map((g) => g.kind).sort() ?? [])
    await expect.poll(glyphs).toEqual(expect.arrayContaining(['horizontal', 'vertical']))
    await units(page, 'mm')
    // undo steps back the typed point and redo puts it back where it was
    await page.locator('body').press('Escape')
    await expect(boxes).toHaveCount(0)
    await page.locator('body').press('ControlOrMeta+z')
    await expect.poll(async () => (await segments(page)).length).toBe(4)
    await page.locator('body').press('ControlOrMeta+Shift+z')
    await expect.poll(async () => (await segments(page)).length).toBe(5)
    near((await segments(page))[4]!.to, [start[0] + 25.4, start[1] + 10])
  })

  test('the keyboard is never stuck in the boxes, and Esc steps back one level at a time without closing the sketch', async ({ page }) => {
    await sketchOnTop(page)
    const panel = toolPanel(page)
    const boxes = drawBoxes(page)
    await sketchAt(page, 'click', [0, 0])
    await sketchAt(page, 'hover', [4, 3])
    await typeSegment(page, '10', '90')
    // Tab past the last box goes on into the panel, the numbers kept; Tab goes on through the panel from there
    await boxes.getByRole('textbox', { name: 'Angle °' }).press('Tab')
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-section="cad-tool"]'))).toBe(true)
    await expect(boxes.getByRole('textbox', { name: 'Length mm' })).toHaveValue('10')
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-section="cad-tool"]'))).toBe(true)
    // Shift+Tab before the first box goes back to the view
    await boxes.getByRole('textbox', { name: 'Length mm' }).focus()
    await boxes.getByRole('textbox', { name: 'Length mm' }).press('Shift+Tab')
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('CANVAS')
    // Enter back in the view places the kept numbers
    await page.locator('canvas.vp-canvas').focus()
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await read(page))?.loops?.[0]?.segments?.[0]?.to?.[1]).toBeCloseTo(10, 4)
    // Esc ladder: the typed value, the pending segment, the tool, and the sketch stays open
    await typeSegment(page, '4', '0')
    const angle = boxes.getByRole('textbox', { name: 'Angle °' })
    await angle.press('Escape')
    await expect(boxes.locator('[data-box="angle"]')).not.toHaveAttribute('data-typed')
    await expect(angle).toBeFocused()
    await angle.press('Escape')
    await expect(boxes).toHaveCount(0)
    await expect(page.getByTestId('sketch-drawing').locator('h4')).toHaveText('Drawing · Line')
    await page.locator('body').press('Escape')
    await expect(page.getByTestId('sketch-drawing').locator('h4')).toHaveText('Drawing · Select')
    await page.locator('body').press('Escape')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('A face of')
    // while a line is drawn, Tab in the panel walks the panel's controls; it no longer moves between boxes
    await page.locator('body').press('l')
    await expect(page.getByTestId('sketch-drawing').locator('h4')).toHaveText('Drawing · Line')
    await sketchAt(page, 'click', [0, 0])
    await sketchAt(page, 'hover', [2, 2])
    await expect(boxes.locator('[data-box="length"]')).toHaveAttribute('data-focus', '')
    await panel.locator('#sk-grid').focus()
    await page.keyboard.press('Tab')
    await expect(boxes.locator('[data-box="length"]')).toHaveAttribute('data-focus', '')
    expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('sk-grid')
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-section="cad-tool"]'))).toBe(true)
  })

  test('Finish sketch and Extrude stay apart: one primary, Ctrl/Cmd+Enter finishes, a bare Enter does not', async ({ page }) => {
    await sketchOnTop(page)
    const panel = toolPanel(page)
    const finish = page.getByTestId('sketch-finish')
    const extrude = panel.getByTestId('model-tool-apply')
    // while drawing, Finish sketch is the primary and Extrude is off with its reason, in the plain look
    await expect(finish).not.toHaveAttribute('aria-disabled', 'true')
    await expect(finish).toHaveAttribute('data-variant', 'primary')
    await expect(extrude).toBeDisabled()
    await expect(extrude).not.toHaveAttribute('data-variant', 'primary')
    await expect(panel.getByTestId('model-tool-reason')).toHaveText('Draw a closed outline to make a solid.')
    await expect(finish).toHaveAttribute('data-tip-key', /Enter$/)
    // a closed rectangle: Extrude takes the primary and Finish sketch goes plain (the per-frame check of that is the
    // nightly test below)
    await page.locator('body').press('r')
    await sketchAt(page, 'click', [-3, -3])
    await sketchAt(page, 'click', [3, 3])
    await expect(extrude).toBeEnabled()
    await expect(extrude).toHaveAttribute('data-variant', 'primary')
    await expect(finish).not.toHaveAttribute('data-variant', 'primary')
    await expect(panel.getByTestId('model-tool-reason')).toHaveCount(0)
    // a bare Enter in the view, twice, neither finishes nor extrudes
    const bodies = () => page.evaluate(() => JSON.stringify((window as unknown as { __sx: { getState(): { plate: { id: string; parts: { positions: ArrayLike<number> }[] }[] } } }).__sx.getState().plate.map((e) => [e.id, e.parts.map((p) => Array.from(p.positions).reduce((a, v) => a + v, 0).toFixed(3))])))
    const model = await bodies()
    const timeline = await page.evaluate(() => (window as unknown as { __sx: { getState(): { timeline: { items: unknown[] } } } }).__sx.getState().timeline.items.length)
    await page.locator('body').press('Enter')
    await page.locator('body').press('Enter')
    await expect(panel).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { __sx: { getState(): { timeline: { items: unknown[] } } } }).__sx.getState().timeline.items.length)).toBe(timeline)
    // Ctrl/Cmd+Enter is Finish sketch: the sketch goes in the timeline with no solid
    await page.locator('body').press('ControlOrMeta+Enter')
    await expect(panel).toHaveCount(0)
    await expect(page.getByTestId('toast').filter({ hasText: 'is in the timeline' })).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { __sx: { getState(): { timeline: { items: unknown[] } } } }).__sx.getState().timeline.items.length)).toBe(timeline + 1)
    // Finish sketch made no solid: the same bodies with the same geometry
    expect(await bodies()).toBe(model)
  })

  test('Cancel backs out of the sketch: the drawing goes, the model and its timeline stay', async ({ page }) => {
    const id = await sketchOnTop(page)
    const panel = toolPanel(page)
    const box = await bounds(page, id)
    const timeline = () => page.evaluate(() => (window as unknown as { __sx: { getState(): { timeline: { items: unknown[] } } } }).__sx.getState().timeline.items.length)
    const was = await timeline()
    const stepsWere = (await steps(page)).length
    await page.locator('body').press('r')
    await sketchAt(page, 'click', [-3, -3])
    await sketchAt(page, 'click', [3, 3])
    await expect(panel.getByTestId('model-tool-apply')).toBeEnabled()
    // Cancel is its own button, apart from Finish sketch and Extrude, and says what it does
    const cancel = panel.getByTestId('model-tool-cancel')
    await expect(cancel).toHaveText('Cancel')
    await expect(cancel).toHaveAttribute('data-tip-title', 'Close the tool')
    await cancel.click()
    await expect(panel).toHaveCount(0)
    expect(await timeline()).toBe(was)
    expect((await steps(page)).length).toBe(stepsWere)
    expect(await bounds(page, id)).toEqual(box)
    expect(await page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: unknown[] } } }).__sx.getState().plate.length)).toBe(1)
  })

  test('Extrude makes what the panel says: a cut of the typed depth and size into the face, kept as an editable step', async ({ page }) => {
    test.slow()
    const id = await sketchOnTop(page)
    const panel = toolPanel(page)
    const box = await bounds(page, id)
    // the corners the body has at a height, on the bed, as their extent: [width, depth], or null with none there
    const at = (z: number) =>
      page.evaluate(({ id, z }) => {
        const e = (window as unknown as { __sx: { getState(): { plate: { id: string; transform: number[]; parts: { positions: ArrayLike<number> }[] }[] } } }).__sx.getState().plate.find((p) => p.id === id)!
        const m = e.transform
        const xs: number[] = []
        const ys: number[] = []
        for (const part of e.parts)
          for (let i = 0; i < part.positions.length; i += 3) {
            const [x, y, w] = [part.positions[i]!, part.positions[i + 1]!, part.positions[i + 2]!]
            if (Math.abs(m[2]! * x + m[6]! * y + m[10]! * w + m[14]! - z) > 0.01) continue
            xs.push(m[0]! * x + m[4]! * y + m[8]! * w + m[12]!)
            ys.push(m[1]! * x + m[5]! * y + m[9]! * w + m[13]!)
          }
        return xs.length ? [Math.round((Math.max(...xs) - Math.min(...xs)) * 1000) / 1000, Math.round((Math.max(...ys) - Math.min(...ys)) * 1000) / 1000] : null
      }, { id, z })
    const floor = box.max[2] - 5
    expect(await at(floor)).toBeNull()
    await page.locator('body').press('r')
    await sketchAt(page, 'click', [-3, -3])
    await sketchAt(page, 'click', [3, 3])
    const result = panel.getByRole('radiogroup', { name: 'Result' })
    await result.getByRole('radio', { name: 'Cut' }).click()
    await expect(result.getByRole('radio', { name: 'Cut' })).toHaveAttribute('aria-checked', 'true')
    await panel.locator('#sk-dist').fill('5')
    await panel.getByTestId('model-tool-apply').click()
    await expect(panel).toHaveCount(0, { timeout: 30_000 })
    // the box keeps its outside; the pocket's floor is a 6 by 6 square, 5 mm under the top, and nothing goes deeper
    await expect.poll(() => at(floor), { timeout: 30_000 }).toEqual([6, 6])
    expect((await bounds(page, id)).min).toEqual(box.min)
    expect((await bounds(page, id)).max).toEqual(box.max)
    expect(await at(floor - 1)).toBeNull()
    // the step is in the history and opens again with what was typed
    await page.getByRole('button', { name: /^Edit / }).first().click()
    const again = toolPanel(page)
    await expect(again).toBeVisible()
    await expect(again.locator('#sk-dist')).toHaveValue('5')
    await expect(again.getByRole('radiogroup', { name: 'Result' }).getByRole('radio', { name: 'Cut' })).toHaveAttribute('aria-checked', 'true')
  })

  test('Extrude and Revolve say why they are off: open, crossing, no axis, no body to cut', async ({ page }) => {
    await bedSketch(page)
    const panel = toolPanel(page)
    const reason = panel.getByTestId('model-tool-reason')
    const apply = panel.getByTestId('model-tool-apply')
    // an open line
    for (const p of [[0, 0], [10, 0], [10, 10]] as [number, number][]) await sketchAt(page, 'click', p)
    await expect(reason).toHaveText('End the shape being drawn first (Esc or a right click).')
    await page.locator('body').press('Escape')
    await expect(reason).toHaveText('Close the outline to make a solid.')
    await expect.poll(async () => (await read(page))?.profile).toBe('open')
    // the button itself carries the reason, is not the primary, and Finish sketch is there to press, as the primary
    const finish = page.getByTestId('sketch-finish')
    await expect(apply).toHaveAccessibleDescription('Close the outline to make a solid.')
    await expect(apply).not.toHaveAttribute('data-variant', 'primary')
    await expect(finish).not.toHaveAttribute('aria-disabled', 'true')
    await expect(finish).toHaveAttribute('data-variant', 'primary')
    // undo back to nothing, then a bow tie: closed, but it crosses itself
    await undoAll(page)
    for (const p of [[20, 0], [30, 10], [30, 0], [20, 10], [20, 0]] as [number, number][]) await sketchAt(page, 'click', p)
    await expect.poll(async () => (await read(page))?.profile).toBe('invalid')
    await expect(apply).toBeDisabled()
    await expect(reason).toBeVisible()
    expect((await reason.textContent())!.length).toBeGreaterThan(5)
    expect((await read(page))!.ready).toBe(false)
    // no false success: Extrude is not the primary (Finish sketch still is), the reason is its description, and the
    // read-back gives the same reason
    await expect(apply).not.toHaveAttribute('data-variant', 'primary')
    await expect(finish).toHaveAttribute('data-variant', 'primary')
    await expect(apply).toHaveAccessibleDescription((await reason.textContent())!)
    expect((await read(page))!.reason).toBe(await reason.textContent())
    // undo the bow tie, draw a square: valid, and the read-back agrees
    await undoAll(page)
    await page.locator('body').press('r')
    await sketchAt(page, 'click', [0, 0])
    await sketchAt(page, 'click', [10, 10])
    await expect.poll(async () => (await read(page))?.profile).toBe('valid')
    await expect(apply).toBeEnabled()
    expect((await read(page))!.reason).toBeNull()
    await expect(apply).toHaveAttribute('data-variant', 'primary')
    await expect(finish).not.toHaveAttribute('data-variant', 'primary')
    // on the bed there is no body: Join and Cut say why they are off
    await expect(panel.getByTestId('sketch-result-reason')).toBeVisible()
    await expect(panel.getByRole('radiogroup', { name: 'Result' }).getByRole('radio', { name: 'Cut' })).toBeDisabled()
    // Revolve with no axis picked
    await page.getByTestId('sketch-solid').getByRole('radiogroup', { name: 'Finish with' }).getByRole('radio', { name: 'Revolve' }).click()
    await expect(apply).toBeDisabled()
    await expect(reason).toHaveText('Pick a straight line of the sketch as the axis.')
  })

  for (const [width, height] of [[1440, 900], [1440, 560], [1100, 700]] as const) {
    test(`at ${width} by ${height} the footer never covers a setting`, async ({ page }) => {
      await studio(page)
      await page.setViewportSize({ width, height })
      const id = await freshBox(page)
      await command(page, 'Sketch on the bed or a face')
      // at 1100 the side panes start folded
      const open = page.getByRole('button', { name: 'Open Tool and transform' })
      if (await open.isVisible()) await open.click()
      await expect(toolPanel(page)).toContainText('the bed or a flat face to sketch on')
      await pick(page, await facePick(page, id, [0, 0, 1]))
      await expect(toolPanel(page)).toContainText('A face of')
      await page.locator('body').press('r')
      await sketchAt(page, 'click', [-3, -3])
      await sketchAt(page, 'click', [3, 3])
      const solid = page.getByTestId('sketch-solid')
      await expect(solid).not.toHaveAttribute('data-muted')
      // the tool pane slides open beside the view: measure once it has, or a control read mid-slide sits in a pane
      // still narrow and moves, or is gone, by the next read
      await still(page)
      const panel = toolPanel(page)
      const footer = panel.locator('.cad-footer')
      // every control of the solid card, focused in turn as Tab would, sits clear of the footer
      const controls = solid.locator('input, button, select, [role="radio"]')
      const n = await controls.count()
      expect(n).toBeGreaterThan(5)
      for (let i = 0; i < n; i++) {
        const c = controls.nth(i)
        if (!(await c.isVisible()) || (await c.isDisabled())) continue
        await c.focus()
        const [b, f] = [(await c.boundingBox())!, (await footer.boundingBox())!]
        expect(b.y + b.height, `control ${i} at ${height}`).toBeLessThanOrEqual(f.y + 1)
        expect(b.y, `control ${i} at ${height}`).toBeGreaterThanOrEqual(0)
      }
      // scrolled to the end, the last setting ends above the footer
      await panel.evaluate((el) => {
        const s = el.closest('.sx-rail-body')
        if (s) s.scrollTop = s.scrollHeight
      })
      const last = solid.locator('.tp-card-body > :last-child')
      const [lb, fb] = [(await last.boundingBox())!, (await footer.boundingBox())!]
      expect(lb.y + lb.height).toBeLessThanOrEqual(fb.y + 1)
      await shot(page, test.info(), `footer-${height}.png`)
    })
  }

  test('the solid card lines its controls up on one right edge', async ({ page }) => {
    await sketchOnTop(page)
    await page.locator('body').press('r')
    await sketchAt(page, 'click', [-3, -3])
    await sketchAt(page, 'click', [3, 3])
    const solid = page.getByTestId('sketch-solid')
    await expect(solid).not.toHaveAttribute('data-muted')
    const edges = await solid.locator('.tp-card-body').evaluate((body) => {
      const right = body.getBoundingClientRect().right - parseFloat(getComputedStyle(body).paddingRight)
      const out: { what: string; gap: number }[] = []
      for (const el of body.querySelectorAll<HTMLElement>('input:not([type="checkbox"]):not([type="radio"]), select, [role="radiogroup"], .sx-seg')) {
        const r = el.getBoundingClientRect()
        if (!r.width) continue
        // a segmented control is measured by its frame, not its last button inside the frame's padding
        out.push({ what: el.getAttribute('aria-label') ?? el.id, gap: Math.round((right - r.right) * 10) / 10 })
      }
      return out
    })
    expect(edges.length).toBeGreaterThan(2)
    for (const e of edges) expect(Math.abs(e.gap), e.what).toBeLessThanOrEqual(1)
  })

  for (const width of [1100, 1440]) {
    test(`at ${width} the drawing card's header says its state whole, for every tool`, async ({ page }) => {
      await studio(page)
      await page.setViewportSize({ width, height: 900 })
      const id = await freshBox(page)
      await command(page, 'Sketch on the bed or a face')
      // at 1100 the side panes start folded
      const open = page.getByRole('button', { name: 'Open Tool and transform' })
      if (await open.isVisible()) await open.click()
      await expect(toolPanel(page)).toContainText('the bed or a flat face to sketch on')
      await pick(page, await facePick(page, id, [0, 0, 1]))
      await expect(toolPanel(page)).toContainText('A face of')
      await page.locator('body').press('r')
      await sketchAt(page, 'click', [-3, -3])
      await sketchAt(page, 'click', [3, 3])
      const dof = page.getByTestId('sketch-dof')
      await expect(dof).toHaveText('4 DOF left')
      await expect(dof).toHaveAttribute('data-tip-title', '4 degrees of freedom left')
      const head = page.getByTestId('sketch-drawing').locator('.tp-card-h')
      const families = toolPanel(page).getByRole('radiogroup', { name: 'Drawing tool' })
      for (const name of ['Line', 'Rectangle', 'Circle', 'Arc', 'Polygon', 'Slot', 'Trim', 'Dimension']) {
        await families.getByRole('radio', { name }).click()
        const cut = await head.evaluate((h) => [...h.querySelectorAll<HTMLElement>('h4, .tp-card-state')].filter((e) => e.scrollWidth > e.clientWidth + 0.5).map((e) => e.textContent))
        expect(cut, `${name} at ${width}`).toEqual([])
        // and the two never overlap
        const [t, st] = await head.evaluate((h) => [h.querySelector('h4')!.getBoundingClientRect().right, h.querySelector('.tp-card-state')!.getBoundingClientRect().left])
        expect(t!, `${name} at ${width}`).toBeLessThanOrEqual(st! + 0.5)
      }
    })
  }

  test('Other plane asks before it drops a drawing: Keep and Esc keep all of it, Drop changes plane only when chosen', async ({ page }) => {
    const id = await sketchOnTop(page)
    const panel = toolPanel(page)
    const head = page.getByTestId('sketch-drawing').locator('h4')
    await page.locator('body').press('r')
    await sketchAt(page, 'click', [-3, -3])
    await sketchAt(page, 'click', [3, 3])
    await expect.poll(async () => (await read(page))?.loops?.length).toBe(1)
    const drawn = JSON.stringify((await read(page))?.loops)
    const plane = await page.evaluate(() => JSON.stringify((window as unknown as { __sketch: () => { on?: string; label?: string } | null }).__sketch()?.label))
    expect(plane).toContain('face')
    const other = panel.getByTestId('sketch-other-plane')
    const ask = panel.getByTestId('sketch-plane-ask')
    await expect(page.getByTestId('sketch-solid')).not.toHaveAttribute('data-muted')
    await expect(other).toHaveAttribute('aria-expanded', 'false')
    // asked from the keyboard: the question shows and is announced, focus stays on Other plane (expanded), Tab reaches it
    await other.focus()
    await page.keyboard.press('Enter')
    await expect(ask).toBeVisible()
    await expect(ask.getByRole('status')).toHaveText(/this drawing goes/)
    await expect(other).toBeFocused()
    await expect(other).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Tab')
    await expect(panel.getByTestId('sketch-plane-keep')).toBeFocused()
    // Keep drawing: the question goes, the drawing, the tool and the plane stay as they were
    await page.keyboard.press('Enter')
    await expect(ask).toHaveCount(0)
    expect(JSON.stringify((await read(page))?.loops)).toBe(drawn)
    await expect(head).toHaveText('Drawing · Rectangle')
    expect(await page.evaluate(() => JSON.stringify((window as unknown as { __sketch: () => { label?: string } | null }).__sketch()?.label))).toBe(plane)
    // Esc answers it the same way and gives focus back to Other plane
    await other.click()
    await expect(ask).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(ask).toHaveCount(0)
    await expect(other).toBeFocused()
    await expect(head).toHaveText('Drawing · Rectangle')
    expect(JSON.stringify((await read(page))?.loops)).toBe(drawn)
    // Drop it and pick a plane: only now does the plane go, and the drawing with it, never into the timeline
    const timeline = () => page.evaluate(() => (window as unknown as { __sx: { getState(): { timeline: { items: unknown[] } } } }).__sx.getState().timeline.items.length)
    const was = await timeline()
    await other.click()
    await panel.getByTestId('sketch-plane-drop').click()
    await expect(panel).toContainText('Click an origin plane')
    expect(await timeline()).toBe(was)
    // a dropped drawing has no undo: the next sketch starts empty, and its undo does not reach the model
    await pick(page, await facePick(page, id, [0, 0, 1]))
    await expect(panel).toContainText('A face of')
    await expect.poll(async () => (await read(page))?.profile).toBe('none')
    await page.locator('body').press('ControlOrMeta+z')
    await page.waitForTimeout(300)
    expect((await read(page))?.profile).toBe('none')
    expect(await page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: unknown[] } } }).__sx.getState().plate.length)).toBe(1)
  })

  // one scheme: light is the one whose focus rings and borders come closest to the 3:1 bar
  for (const scheme of ['light'] as const) {
    test(`in ${scheme}: every panel control and box shows its focus, has a name, and no text is cut off`, async ({ page }) => {
      await sketchOnTop(page)
      await page.evaluate((s) => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ scheme: s, themeFollowsSystem: false }), scheme)
      await expect(page.locator(`html[data-scheme="${scheme}"]`)).toHaveCount(1)
      const panel = toolPanel(page)
      // an open outline first: Extrude is off, and its reason is its description
      await sketchAt(page, 'click', [0, 0])
      await sketchAt(page, 'click', [5, 0])
      await page.locator('body').press('Escape')
      const apply = panel.getByTestId('model-tool-apply')
      await expect(apply).toBeDisabled()
      await expect(apply).toHaveAccessibleDescription('Close the outline to make a solid.')
      await page.locator('body').press('ControlOrMeta+z')
      await expect.poll(async () => (await read(page))?.profile).toBe('none')
      // then a closed square, so the solid card's controls are all there
      await page.locator('body').press('r')
      await sketchAt(page, 'click', [-3, -3])
      await sketchAt(page, 'click', [3, 3])
      await expect(apply).toBeEnabled()
      // the focus mark on each control the keyboard reaches: there, and at least 3:1 against the panel (a non-text contrast)
      const focusMark = () =>
        page.evaluate(() => {
          const lum = (c: string) => {
            const m = c.match(/[\d.]+/g)!.map(Number)
            const [r, g, b] = (c.startsWith('color(') ? m.slice(0, 3).map((v) => v * 255) : m.slice(0, 3)).map((v) => {
              const x = v / 255
              return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
            })
            return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
          }
          const alpha = (c: string) => {
            const m = c.match(/[\d.]+/g)!.map(Number)
            return c.startsWith('color(') ? (m[3] ?? 1) : c.startsWith('rgba') ? m[3]! : 1
          }
          const a = document.activeElement as HTMLElement
          let bg = 'rgb(0, 0, 0)'
          for (let e: HTMLElement | null = a.parentElement; e; e = e.parentElement) {
            const c = getComputedStyle(e).backgroundColor
            if (alpha(c) > 0.9) {
              bg = c
              break
            }
          }
          const cs = getComputedStyle(a)
          const mark = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1 ? cs.outlineColor : cs.borderColor
          const [l1, l2] = [lum(mark), lum(bg)]
          return {
            name: a.getAttribute('aria-label') ?? a.id ?? a.textContent,
            inPanel: !!a.closest('[data-section="cad-tool"]'),
            visible: a.matches(':focus-visible') && (cs.outlineStyle !== 'none' || cs.boxShadow !== 'none'),
            ratio: Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100,
          }
        })
      await panel.getByTestId('sketch-other-plane').focus()
      const seen = new Set<string>()
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab')
        const f = await focusMark()
        if (!f.inPanel) break
        seen.add(f.name ?? '')
        expect(f.visible, `${f.name} in ${scheme}`).toBe(true)
        // read once the field's border has eased to the accent
        await expect.poll(async () => (await focusMark()).ratio, { message: `${f.name} in ${scheme}`, timeout: 2000 }).toBeGreaterThanOrEqual(3)
      }
      expect(seen.size).toBeGreaterThan(8)
      // names, values and states: every control has a name, every radio says whether it is on
      const unnamed = await panel.evaluate((p) =>
        [...p.querySelectorAll<HTMLElement>('button, input, select, [role="radio"]')]
          .filter((e) => e.getClientRects().length && !(e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || (e.id && p.querySelector(`label[for="${e.id}"]`)) || (e.textContent ?? '').trim() || e.closest('label')))
          .map((e) => e.outerHTML.slice(0, 80)),
      )
      expect(unnamed).toEqual([])
      for (const r of await panel.getByRole('radio').all()) expect(['true', 'false']).toContain(await r.getAttribute('aria-checked'))
      // nothing cut off in the panel
      const cut = (root: string) =>
        page.evaluate((root) => [...document.querySelectorAll<HTMLElement>(`${root} *`)].filter((e) => e.getClientRects().length && e.children.length === 0 && (e.textContent ?? '').trim() && e.scrollWidth > e.clientWidth + 0.5 && getComputedStyle(e).overflowX !== 'visible').map((e) => e.textContent), root)
      expect(await cut('[data-section="cad-tool"]')).toEqual([])
      // the boxes on the line while typing: their field shows the focus ring, and their text fits
      await page.locator('body').press('l')
      await sketchAt(page, 'click', [8, 8])
      await sketchAt(page, 'hover', [12, 11])
      const len = drawBoxes(page).getByRole('textbox', { name: 'Length mm' })
      await expect(len).toBeFocused()
      await len.fill('123.456')
      const box = await focusMark()
      expect(box.visible || (await len.evaluate((e) => getComputedStyle(e.closest('.shape-box')!).outlineStyle !== 'none' || getComputedStyle(e.closest('.shape-box')!).boxShadow !== 'none'))).toBe(true)
      expect(await cut('[data-testid="shape-boxes"]')).toEqual([])
      expect(await len.evaluate((e: HTMLInputElement) => e.scrollWidth <= e.clientWidth + 0.5)).toBe(true)
    })
  }

  // Nightly: one primary in every painted frame while a rectangle closes (a rAF watcher over every frame).
  test('Finish sketch and Extrude: exactly one primary in every painted frame as the profile closes', { tag: '@nightly' }, async ({ page }) => {
    await sketchOnTop(page)
    const panel = toolPanel(page)
    const extrude = panel.getByTestId('model-tool-apply')
    await page.evaluate(() => {
      const w = window as unknown as { __off: number; __frames: number; __watch: boolean }
      w.__off = 0
      w.__frames = 0
      w.__watch = true
      const tick = () => {
        const n = document.querySelectorAll('[data-testid="sketch-finish"][data-variant="primary"], [data-section="cad-tool"] [data-testid="model-tool-apply"][data-variant="primary"]').length
        w.__frames++
        if (n !== 1) w.__off++
        if (w.__watch) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await page.locator('body').press('r')
    await sketchAt(page, 'click', [-3, -3])
    await sketchAt(page, 'click', [3, 3])
    await expect(extrude).toBeEnabled()
    await expect(extrude).toHaveAttribute('data-variant', 'primary')
    await page.waitForTimeout(300)
    const frames = await page.evaluate(() => {
      const w = window as unknown as { __off: number; __frames: number; __watch: boolean }
      w.__watch = false
      return { off: w.__off, frames: w.__frames }
    })
    expect(frames.frames).toBeGreaterThan(0)
    expect(frames.off).toBe(0)
  })
})

// ---- the slow 3D view notice needs a touch screen at desktop width, so it keeps a page of its own
cold.describe('the slow 3D view notice', () => {
  // a touch screen at desktop width (a tablet): the desktop's toast, with a coarse pointer
  cold.use({ hasTouch: true })
  cold('one toast: Details opens in place, the close mark takes a finger-sized tap, and closed it stays closed', async ({ page }) => {
    await openStudio(page)
    await sketchOnTopRaw(page)
    // the boxes below follow their shape through the camera's turn square on to the face: read their places once it ends
    await still(page)
    // A browser without a GPU says this notice itself as the view starts, with the browser reason, and a notice is told
    // once a visit: by the time the sketch is open that card can have timed out (on a slow machine, such as the nightly's),
    // and the same words said again show nothing. So the test says it with a reason of its own, and counts by that reason.
    const reason = 'Hardware acceleration looks off in this test. Turn it on in the browser settings and reload.'
    const degrade = () => page.evaluate((r) => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('degrade', { message: 'The 3D view will be slow here.', details: r }), reason)
    // said twice, it is still one card
    await degrade()
    await degrade()
    const notices = page.getByTestId('toast').filter({ hasText: reason })
    await expect(notices).toHaveCount(1)
    const t = notices.first()
    await t.getByTestId('toast-details').click()
    // Details opens the same card: still one notice, the reason under the line
    await expect(notices).toHaveCount(1)
    await expect(t.locator('.sx-toast-more')).toBeVisible()
    // it keeps clear of the tool panel and its footer
    const [tb, pb] = [(await t.boundingBox())!, (await toolPanel(page).boundingBox())!]
    const apart = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) => a.x + a.width <= b.x || a.x >= b.x + b.width || a.y + a.height <= b.y || a.y >= b.y + b.height
    expect(apart(tb, pb)).toBe(true)
    // and of the boxes on the line while drawing: a press on a box reaches the box, not the notice
    await page.locator('body').press('l')
    await sketchAt(page, 'click', [0, 0])
    await sketchAt(page, 'hover', [4, 3])
    const shown = page.locator('[data-testid="shape-box"]:not([hidden])')
    await expect(shown).toHaveCount(2)
    for (const b of await shown.all()) {
      const pl = (await b.boundingBox())!
      expect(apart((await t.boundingBox())!, pl)).toBe(true)
      expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('[data-testid="shape-box"]'), [pl.x + pl.width / 2, pl.y + pl.height / 2])).toBe(true)
    }
    // nor over the panel's footer, where the primary is
    expect(apart((await t.boundingBox())!, (await toolPanel(page).getByTestId('model-tool-apply').boundingBox())!)).toBe(true)
    await page.locator('body').press('Escape')
    // the close mark: small to see, 44 px to a finger, and its reach ends before Details
    const close = t.getByTestId('toast-close')
    await expect(close).toHaveAccessibleName('Dismiss')
    // the mark itself is at least the desktop's 28 px; a coarse pointer gets the larger target around it
    expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(28)
    const hit = await close.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const b = getComputedStyle(el, '::before')
      const inset = parseFloat(b.top)
      const d = el.parentElement!.querySelector('[data-testid="toast-details"]')!.getBoundingClientRect()
      return { w: r.width - 2 * inset, h: r.height - 2 * inset, mark: r.height, reachLeft: r.left + inset, detailsRight: d.right, coarse: matchMedia('(pointer: coarse)').matches }
    })
    expect(hit.coarse).toBe(true)
    expect(hit.w).toBeGreaterThanOrEqual(44)
    expect(hit.h).toBeGreaterThanOrEqual(44)
    expect(hit.mark).toBeLessThanOrEqual(32)
    expect(hit.reachLeft).toBeGreaterThanOrEqual(hit.detailsRight)
    await shot(page, test.info(), 'notice-open.png')
    await close.click()
    await expect(notices).toHaveCount(0)
    // the view says it again (a new view starting): it stays closed
    await degrade()
    await page.waitForTimeout(500)
    await expect(notices).toHaveCount(0)
    // closed is kept for the visit: a reload starts a new one, which may say it once more
    await page.reload()
    await page.locator('html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: 120_000 })
    await degrade()
    await degrade()
    await expect(notices).toHaveCount(1)
  })
})

