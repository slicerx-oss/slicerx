// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model on a phone, in the browser build that models only: the tools are one bar along the bottom of the view with
// fixed slots a finger can hit, the tree and the open tool are sheets the bar opens, the tool's sheet leaves the model
// in view, the sketch's drawing tools move into the bar, and a finger selects, turns the view, drags a gizmo handle and
// holds for the ring menu. Touch is real: taps through the touchscreen, drags and holds through the browser's touch
// events. A desktop window keeps the shelf.
import { type CDPSession, type Page } from '@playwright/test'
import { appReady, expect, test } from './fixtures'

type Entry = { id: string; transform: number[] }
type Sx = { getState(): { plate: Entry[]; selection: string | null; objectTool: string | null; timeline: { items: unknown[] } }; setState(p: unknown): void }

const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())
const setState = (page: Page, p: Record<string, unknown>) => page.evaluate((x) => (window as unknown as { __sx: Sx }).__sx.setState(x), p)

async function openModel(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.e2e.cadOnly', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await appReady(page)
  await page.locator('html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: 120_000 })
}

/** Empties the plate and adds a box from the bar's Add menu, as a finger would. Returns its id, selected. */
async function addBox(page: Page): Promise<string> {
  await setState(page, { plate: [], selection: null, selectedIds: [] })
  await page.getByTestId('phone-add').tap()
  await page.getByRole('menu', { name: 'Add' }).getByRole('menuitem', { name: 'Box' }).first().tap()
  await expect.poll(async () => (await state(page)).plate.length).toBe(1)
  const id = (await state(page)).plate[0]!.id
  await setState(page, { selection: id, selectedIds: [id] })
  return id
}

/** Where a point of the plate (bed mm) is on the screen. */
function screenOf(page: Page, at: [number, number, number]): Promise<{ x: number; y: number }> {
  return page.evaluate((p) => {
    type V = { x: number; y: number; set(x: number, y: number, z: number): V; applyMatrix4(m: unknown): V; project(c: unknown): V }
    const vp = (window as unknown as { __vp: { camera: { position: { clone(): V } }; canvas: HTMLCanvasElement; stage: { bedRoot: { matrixWorld: unknown } } } }).__vp
    const v = vp.camera.position.clone().set(p[0], p[1], p[2]).applyMatrix4(vp.stage.bedRoot.matrixWorld).project(vp.camera)
    const r = vp.canvas.getBoundingClientRect()
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }
  }, at)
}

/** The middle of an object's box, bed mm. */
function middleOf(page: Page, id: string): Promise<[number, number, number]> {
  return page.evaluate((id) => {
    type E = { id: string; transform: number[]; parts: { positions: Float32Array }[] }
    const e = (window as unknown as { __sx: { getState(): { plate: E[] } } }).__sx.getState().plate.find((p) => p.id === id)!
    const m = e.transform
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (const part of e.parts)
      for (let i = 0; i < part.positions.length; i += 3) {
        const x = part.positions[i]!, y = part.positions[i + 1]!, z = part.positions[i + 2]!
        const w = [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!]
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k]!, w[k]!)
          hi[k] = Math.max(hi[k]!, w[k]!)
        }
      }
    return [0, 1, 2].map((k) => (lo[k]! + hi[k]!) / 2) as [number, number, number]
  }, id)
}

/** One finger: down at `from`, through `to` in steps, then up; `hold` ms before moving. */
async function finger(cdp: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }, hold = 0, steps = 10): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] })
  if (hold) await new Promise((r) => setTimeout(r, hold))
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }] })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

test.describe('Model on a phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'Phone only')

  test('the bar has six fixed slots a finger can hit, at 390, 360 and 430 wide', async ({ page }) => {
    await openModel(page)
    await expect(page.locator('.shelf')).toHaveCount(0)
    for (const [w, h] of [[390, 844], [360, 780], [430, 932]] as const) {
      await page.setViewportSize({ width: w, height: h })
      const slots = page.locator('.pbar-slot')
      await expect(slots).toHaveCount(6)
      await expect(slots).toHaveText(['Add', 'Sketch', 'Tools', 'Edit', 'Tree', 'More'])
      const boxes = await slots.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect))
      for (const b of boxes) {
        expect(b.width).toBeGreaterThanOrEqual(44)
        expect(b.height).toBeGreaterThanOrEqual(44)
        expect(b.left).toBeGreaterThanOrEqual(0)
        expect(b.right).toBeLessThanOrEqual(w)
        expect(b.bottom).toBeLessThanOrEqual(h)
      }
      // side by side, none over another
      for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.left).toBeGreaterThanOrEqual(boxes[i - 1]!.right - 0.5)
      // nothing scrolls sideways
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w)
    }
  })

  test('a tap selects the model and a tap on empty space clears it', async ({ page }) => {
    await openModel(page)
    const id = await addBox(page)
    await setState(page, { selection: null, selectedIds: [] })
    const at = await screenOf(page, await middleOf(page, id))
    await page.touchscreen.tap(at.x, at.y)
    await expect.poll(async () => (await state(page)).selection).toBe(id)
    const box = (await page.locator('.vp-canvas').boundingBox())!
    await page.touchscreen.tap(box.x + 30, box.y + box.height * 0.45)
    await expect.poll(async () => (await state(page)).selection).toBe(null)
  })

  test('a finger drags a move arrow and moves the model along it only, and a drag on the model turns the view', async ({ page }) => {
    await openModel(page)
    const id = await addBox(page)
    await expect(page.getByTestId('phone-handle-move')).toHaveAttribute('aria-checked', 'true')
    const cdp = await page.context().newCDPSession(page)
    // a drag that starts on the model itself turns the view and leaves the model where it is
    const before = (await state(page)).plate[0]!.transform.join(',')
    const mid = await screenOf(page, await middleOf(page, id))
    await finger(cdp, mid, { x: mid.x + 60, y: mid.y + 10 })
    await page.waitForTimeout(300)
    expect((await state(page)).plate[0]!.transform.join(',')).toBe(before)
    // the X arrow: from the model's middle along X, most of the way to its tip
    const tip = await page.evaluate(() => {
      const vp = (window as unknown as { __vp: { moveTarget(): unknown; arrowLayout(t: unknown): { origin: [number, number, number]; length: number } } }).__vp
      const l = vp.arrowLayout(vp.moveTarget())
      return [l.origin[0] + l.length * 0.75, l.origin[1], l.origin[2]] as [number, number, number]
    })
    const from = await screenOf(page, tip)
    const along = await screenOf(page, [tip[0] + 10, tip[1], tip[2]])
    const x0 = (await state(page)).plate[0]!.transform
    await finger(cdp, from, along, 0, 12)
    await expect.poll(async () => Math.abs((await state(page)).plate[0]!.transform[12]! - x0[12]!)).toBeGreaterThan(2)
    const x1 = (await state(page)).plate[0]!.transform
    expect(Math.abs(x1[13]! - x0[13]!)).toBeLessThan(0.01)
    expect(Math.abs(x1[14]! - x0[14]!)).toBeLessThan(0.01)
  })

  test('a finger held on the model opens the ring menu', async ({ page }) => {
    await openModel(page)
    const id = await addBox(page)
    // nothing selected, so no move arrow starts under the finger: a hold on a handle drags it instead
    await setState(page, { selection: null, selectedIds: [] })
    const cdp = await page.context().newCDPSession(page)
    const mid = await screenOf(page, await middleOf(page, id))
    await finger(cdp, mid, mid, 800, 1)
    await expect(page.getByTestId('model-ring')).toBeVisible()
  })

  test('Tree and Edit open their sheets and close them again; the tool sheet leaves the view taking taps', async ({ page }) => {
    await openModel(page)
    const id = await addBox(page)
    const bar = (await page.locator('.pbar').boundingBox())!
    // the tree: a sheet over the view
    await page.getByTestId('phone-tree').tap()
    await expect(page.getByTestId('model-tree')).toBeInViewport()
    await expect(page.getByTestId('phone-tree')).toHaveAttribute('aria-pressed', 'true')
    // a modal sheet: a tap on the dimmed view above it closes it
    await page.touchscreen.tap(20, 160)
    await expect(page.getByTestId('model-tree')).not.toBeInViewport()
    // Edit: the tool and Transform, low over the view, with no scrim, above the bar
    await page.getByTestId('phone-edit').tap()
    await expect(page.getByTestId('model-inspector')).toBeInViewport()
    await expect(page.locator('.sheet-scrim')).toHaveCount(0)
    // the sheet slides up for 200 ms; measure it once it is in place
    await expect.poll(async () => { const b = (await page.locator('aside.sheet-docked').boundingBox())!; return b.y + b.height }).toBeLessThanOrEqual(bar.y + 0.5)
    const sheet = (await page.locator('aside.sheet-docked').boundingBox())!
    // the view above it still takes a tap
    const at = await screenOf(page, await middleOf(page, id))
    if (at.y < sheet.y) {
      await setState(page, { selection: null, selectedIds: [] })
      await page.touchscreen.tap(at.x, at.y)
      await expect.poll(async () => (await state(page)).selection).toBe(id)
    }
    // the handle folds it to its header and opens it again
    await page.locator('aside.sheet-docked .sheet-handle').tap()
    await expect(page.locator('aside.sheet-docked')).toHaveClass(/sheet-folded/)
    await page.locator('aside.sheet-docked .sheet-handle').tap()
    await expect(page.locator('aside.sheet-docked')).not.toHaveClass(/sheet-folded/)
    await page.getByTestId('phone-edit').tap()
    await expect(page.getByTestId('model-inspector')).not.toBeInViewport()
    // the bar never moved
    expect((await page.locator('.pbar').boundingBox())!).toEqual(bar)
  })

  test('a tool from the Tools menu opens its sheet and closes it with the tool', async ({ page }) => {
    await openModel(page)
    await addBox(page)
    await page.getByTestId('phone-tools').tap()
    await page.getByTestId('phone-tools-menu').getByRole('menuitem', { name: 'Push and pull' }).tap()
    await expect(page.locator('[data-section="cad-tool"]')).toBeInViewport()
    await expect(page.getByTestId('phone-edit')).toHaveAttribute('aria-pressed', 'true')
    await page.locator('[data-section="cad-tool"]').getByRole('button', { name: 'Cancel' }).tap()
    await expect.poll(async () => (await state(page)).objectTool).toBe(null)
    await expect(page.getByTestId('phone-edit')).toHaveAttribute('aria-pressed', 'false')
  })

  test('a sketch puts its two rows of drawing tools in the bar, and Finish sketch ends it', async ({ page }) => {
    await openModel(page)
    await setState(page, { plate: [], selection: null, selectedIds: [] })
    await page.getByTestId('phone-sketch').tap()
    await expect(page.getByTestId('phone-sketch')).toHaveAttribute('aria-pressed', 'true')
    // the panel takes picks once it is up
    await expect(page.getByRole('complementary', { name: 'Tool and transform' })).toContainText('Tap an origin plane')
    await page.evaluate(() => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('pick', { objectId: null, partIndex: null, triangle: null, point: null, bed: null, originPlane: 'xy' }))
    const bar = page.getByTestId('phone-sketch-bar')
    const families = bar.getByRole('radiogroup', { name: 'Drawing tool' })
    await expect(families).toBeInViewport()
    await expect(page.locator('.pbar-slots')).toBeHidden()
    const row = (await families.boundingBox())!
    // Rectangle: its ways to draw show in the second row; the first row stays put
    await families.getByRole('radio', { name: 'Rectangle' }).tap()
    await expect(families.getByRole('radio', { name: 'Rectangle' })).toHaveAttribute('aria-checked', 'true')
    await expect(bar.getByRole('radiogroup', { name: 'Draw it by' })).toBeVisible()
    expect((await families.boundingBox())!).toEqual(row)
    for (const b of await families.getByRole('radio').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(b).toBeGreaterThanOrEqual(44)
    // the hint speaks of taps
    await expect(page.locator('.sketch-hint')).toContainText('Tap')
    await expect(page.locator('.sketch-hint')).not.toContainText(/click/i)
    // draw a rectangle and finish
    for (const at of [[-10, -10], [10, 8]] as const) await page.evaluate((p) => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('sketch', { kind: 'click', at: p, mmPerPx: 0.2, screen: [200, 300], shift: false, alt: false }), at)
    await page.getByTestId('sketch-finish').tap()
    await expect.poll(async () => (await state(page)).objectTool).toBe(null)
    await expect(page.locator('.pbar-slots')).toBeVisible()
    // the finished sketch is in the timeline strip above the bar, its marker a finger wide
    await expect(page.getByTestId('phone-timeline')).toBeVisible()
    const marker = (await page.getByTestId('tl-marker').boundingBox())!
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid'), { x: marker.x + marker.width / 2 + 16, y: marker.y + marker.height / 2 })
    expect(hit).toBe('tl-marker')
  })
})

test('a desktop window keeps the shelf and has no phone bar', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop only')
  await openModel(page)
  await expect(page.locator('.shelf')).toHaveCount(1)
  await expect(page.locator('.pbar')).toHaveCount(0)
  await expect(page.getByTestId('phone-handles')).toHaveCount(0)
})
