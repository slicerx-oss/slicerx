// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Sketch dimension boxes on the shape (the new Model feel, developer flag), with a real mouse and keyboard: Width and
// Height sit on the rectangle's sides, Length and Angle on the line, Diameter on the circle. The first click puts the
// keyboard in the first box, typing replaces its value, Tab moves to the next box and on out of them, Enter places the
// shape and the typed sizes drive it as dimensions, Esc frees a typed value and then drops the shape. A picked shape
// shows its boxes again to change, and they stay on it with the side panes shut. A phone taps the boxes. The open
// sketch's boxes read and set the same way a client does over the app link.
import type { Locator, Page } from '@playwright/test'
import { command, openStudio, pick, toolPanel } from './cad-helpers'
import { expect, test } from './fixtures'

type V2 = [number, number]
type Loop = { start?: V2; segments?: { type: string; to: V2 }[]; type?: string; center?: V2; diameterMm?: number }
type W = {
  __vp: { screenOf(p: number[]): [number, number]; sketchLayer: { scene: { frame: { origin: number[]; u: number[]; v: number[] }; dims?: { label: string; hideLabel?: boolean }[] } | null }; emit(e: string, p: unknown): void; canvas: HTMLCanvasElement }
  __sketch: () => { loops?: Loop[]; dof?: number | null } | null
  __sketchBoxes: () => { read(): Boxes; set(r: Record<string, unknown>): Promise<Boxes & { driven: boolean }> } | null
}
type Boxes = { dof: number | null; shapes: { shape: string; loop: number; seg?: number; boxes: { box: string; value: number; set: string | null }[] }[] }

/** Turns the developer flag on before the app starts, as the palette command leaves it. */
const withFeel = (page: Page) => page.addInitScript(() => localStorage.setItem('sx.modelFeel', '1'))

/** Where plane point `p` of the open sketch is on screen. */
const screenAt = (page: Page, p: V2) =>
  page.evaluate((p) => {
    const vp = (window as unknown as W).__vp
    const f = vp.sketchLayer.scene!.frame
    const s = vp.screenOf([0, 1, 2].map((k) => f.origin[k]! + f.u[k]! * p[0] + f.v[k]! * p[1]))
    return { x: s[0], y: s[1] }
  }, p)

/** Waits until the view holds still: the sketch turns the camera square on as it opens. */
async function still(page: Page): Promise<void> {
  let last = ''
  let n = 0
  await expect
    .poll(
      async () => {
        const s = await screenAt(page, [0, 0])
        const now = `${Math.round(s.x)},${Math.round(s.y)}`
        n = now === last ? n + 1 : 0
        last = now
        return n >= 3
      },
      { intervals: [250], timeout: 20_000 },
    )
    .toBe(true)
}

const loops = (page: Page) => page.evaluate(() => (window as unknown as W).__sketch()?.loops ?? [])
const labels = (page: Page) => page.evaluate(() => ((window as unknown as W).__vp.sketchLayer.scene?.dims ?? []).map((d) => d.label).sort())
/** The kept dimensions as the view draws them: how many, and how many have their value left off (shown in a box). */
const dimsDrawn = (page: Page) =>
  page.evaluate(() => {
    const d = (window as unknown as W).__vp.sketchLayer.scene?.dims ?? []
    return { all: d.length, hidden: d.filter((x) => x.hideLabel).length }
  })
/** Every shown box that sits over a control floating on the view (the pill, the view buttons, a phone's undo group). */
const boxesOverControls = (page: Page) =>
  page.evaluate(() => {
    const hit = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
    const controls = Array.from(document.querySelectorAll<HTMLElement>('.hud-top .hud-row, .hud-top .phandles, .hud-top .hud-col.end > *, .hud-bl > *, .pbar-wrap > *, .pane.sheet.sheet-open'))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
    const boxes = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="shape-box"]:not([hidden])')).map((el) => el.getBoundingClientRect())
    const rr = (r: DOMRect) => [r.left, r.top, r.right, r.bottom].map(Math.round)
    return { boxes: boxes.length, controls: controls.length, over: boxes.filter((b) => controls.some((c) => hit(b, c))).length, boxRects: boxes.map(rr), controlRects: controls.map(rr) }
  })
const r2 = (v: number) => Math.round(v * 100) / 100
const ends = (l: Loop | undefined) => (l?.segments ?? []).map((s) => s.to.map(r2))
// a loop's extent from its start: a rectangle's width and height, a line's run and rise
const size = (l: Loop | undefined): V2 | null => {
  if (!l?.start || !l.segments?.length) return null
  const xs = [l.start[0], ...l.segments.map((s) => s.to[0])]
  const ys = [l.start[1], ...l.segments.map((s) => s.to[1])]
  return l.segments.length === 1 ? [r2(l.segments[0]!.to[0] - l.start[0]), r2(l.segments[0]!.to[1] - l.start[1])] : [r2(Math.max(...xs) - Math.min(...xs)), r2(Math.max(...ys) - Math.min(...ys))]
}
const boxOf = (page: Page, key: string) => page.locator(`[data-testid="shape-box"][data-box="${key}"]:not([hidden])`)
const inputOf = (page: Page, key: string) => boxOf(page, key).locator('input')
const rect = async (l: Locator) => (await l.boundingBox())!

async function move(page: Page, p: V2): Promise<void> {
  const s = await screenAt(page, p)
  await page.mouse.move(s.x, s.y, { steps: 4 })
}
async function clickAt(page: Page, p: V2): Promise<void> {
  await move(page, p)
  await page.mouse.down()
  await page.mouse.up()
}

/** A sketch on the bed with the new feel on; the bed plane's coordinates are bed millimeters. */
async function sketchOnBed(page: Page): Promise<void> {
  await withFeel(page)
  await openStudio(page, { settingsMode: 'developer' })
  await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  await page.locator('.sx-tab[data-mode="design"]').click()
  await command(page, 'Sketch on the bed or a face')
  await expect(toolPanel(page)).toContainText('Click an origin plane')
  await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, bed: [100, 100] })
  await expect(toolPanel(page)).toContainText('The bed')
  await still(page)
}

test.describe('sketch dimension boxes on the shape, desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'Needs a pointer and a keyboard')

  test('a rectangle takes Width and Height on its sides, Tab between them, Enter places it held to them', async ({ page }) => {
    test.slow()
    await page.setViewportSize({ width: 1440, height: 900 })
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
    await page.screenshot({ path: test.info().outputPath('rect-live.png') })

    // typing replaces the value and locks it; the shape follows the typed size, not the pointer
    await page.keyboard.type('30')
    await expect(boxOf(page, 'width')).toHaveAttribute('data-typed', '')
    await page.keyboard.press('Tab')
    await expect(height).toBeFocused()
    await page.keyboard.type('20')
    await move(page, [125, 130])
    await expect(width).toHaveValue('30')
    await page.screenshot({ path: test.info().outputPath('rect-typed.png') })
    await page.keyboard.press('Enter')

    // placed 30 by 20 from the first corner, its sizes kept as dimensions, the boxes gone with the shape
    await expect.poll(async () => ends((await loops(page))[0])).toEqual([[140, 110], [140, 130], [110, 130], [110, 110]])
    await expect.poll(() => labels(page)).toEqual(['20', '30'])
    await expect(boxOf(page, 'width')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => (window as unknown as W).__sketch()?.dof)).toBe(2)
  })

  test('a line takes Length and Angle, Esc frees a typed value then drops the line, and the keys are never stuck', async ({ page }) => {
    test.slow()
    await page.setViewportSize({ width: 1440, height: 900 })
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
    await page.screenshot({ path: test.info().outputPath('line-typed.png') })
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
    await page.setViewportSize({ width: 1440, height: 900 })
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
    await page.screenshot({ path: test.info().outputPath('circle-typed.png') })
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await loops(page))[0]).toMatchObject({ type: 'circle', center: [160, 120], diameterMm: 12 })
    await expect.poll(() => labels(page)).toEqual(['⌀12'])
  })

  test('a picked shape shows its boxes to change, and they stay on it with the side panes shut', async ({ page }) => {
    test.slow()
    await page.setViewportSize({ width: 1440, height: 900 })
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
    await page.screenshot({ path: test.info().outputPath('edit-picked.png') })
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
    await page.screenshot({ path: test.info().outputPath('edit-pane-shut.png') })
    await page.getByTestId('edge-tab-left').click()
    await expect.poll(canvasWidth).toBe(open)
    await expect.poll(placed).toBe(true)
  })

  test('a picked shape shows its sizes in boxes and not twice: the kept label steps aside, with the tool pane open or shut', async ({ page }) => {
    test.slow()
    await page.setViewportSize({ width: 1440, height: 900 })
    await sketchOnBed(page)
    await page.keyboard.press('r')
    await clickAt(page, [110, 110])
    await move(page, [130, 120])
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
    await page.screenshot({ path: test.info().outputPath('picked-kept.png') })
    expect((await boxesOverControls(page)).over).toBe(0)
    // picking nothing gives the labels back
    await clickAt(page, [190, 190])
    await expect(boxOf(page, 'width')).toHaveCount(0)
    await expect.poll(() => dimsDrawn(page)).toEqual({ all: 2, hidden: 0 })
    // shutting the tool pane closes the sketch panel and the sketch with it: no box is left hanging over the view
    const canvasWidth = () => page.evaluate(() => Math.round((window as unknown as W).__vp.canvas.getBoundingClientRect().width))
    const open = await canvasWidth()
    await clickAt(page, [110, 120])
    await expect(boxOf(page, 'width')).toBeVisible()
    await page.getByTestId('edge-tab-right').click()
    await expect.poll(canvasWidth).toBeGreaterThan(open + 100)
    await expect(page.locator('[data-testid="shape-box"]')).toHaveCount(0)
  })

  test('a picked shape under the view buttons keeps its boxes clear of them', async ({ page }) => {
    test.slow()
    await page.setViewportSize({ width: 1440, height: 900 })
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
    await page.screenshot({ path: test.info().outputPath('corner-live.png') })
  })

  test('a client reads the open sketch boxes and sets one, as the app link does', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await sketchOnBed(page)
    await page.keyboard.press('l')
    await clickAt(page, [110, 150])
    await clickAt(page, [130, 150])
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await loops(page)).length).toBe(1)
    const read = await page.evaluate(() => (window as unknown as W).__sketchBoxes()!.read())
    expect(read.shapes).toEqual([{ shape: 'line', loop: 0, seg: 0, boxes: [expect.objectContaining({ box: 'length', value: 20, set: null }), expect.objectContaining({ box: 'angle', value: 0, set: null })] }])
    const set = await page.evaluate(() => (window as unknown as W).__sketchBoxes()!.set({ loop: 0, seg: 0, box: 'length', value: '6*5' }))
    expect(set.driven).toBe(false)
    expect(set.shapes[0]!.boxes[0]).toMatchObject({ box: 'length', value: 30, set: 'driving' })
    // the drawing in the app moved with it
    await expect.poll(async () => ends((await loops(page))[0])).toEqual([[140, 150]])
    await expect.poll(() => labels(page)).toEqual(['30'])
  })
})

test.describe('sketch dimension boxes on the shape, phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'Phone only')

  async function sketchOnPlane(page: Page): Promise<void> {
    await withFeel(page)
    await page.addInitScript(() => {
      if (sessionStorage.getItem('sx-e2e')) return
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.debug', '1')
      localStorage.setItem('slicerx.e2e.cadOnly', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'developer', pilot: { mode: 'off' } }))
    })
    await page.goto('./')
    await page.locator('html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: 120_000 })
    await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
    await page.getByTestId('phone-sketch').tap()
    await expect(page.getByRole('complementary', { name: 'Tool and transform' })).toContainText('Tap an origin plane')
    await page.evaluate(() => (window as unknown as W).__vp.emit('pick', { objectId: null, partIndex: null, triangle: null, point: null, bed: null, originPlane: 'xy' }))
    await expect(page.getByTestId('phone-sketch-bar')).toBeVisible()
    await still(page)
  }
  const family = (page: Page, name: string) => page.getByTestId('phone-sketch-bar').getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name })
  // a tap in the open part of the view, above the sheet: `fx` across and `fy` down the view, as fractions
  const tapAt = async (page: Page, fx: number, fy: number) => {
    const r = await page.evaluate(() => (window as unknown as W).__vp.canvas.getBoundingClientRect().toJSON() as DOMRect)
    const sheet = await page.getByRole('complementary', { name: 'Tool and transform' }).boundingBox()
    const bottom = Math.min(r.y + r.height, sheet ? sheet.y : Infinity)
    // clear of the mode pill and the handles along the top
    const top = r.y + 140
    await page.touchscreen.tap(r.x + 40 + (r.width - 120) * fx, top + (bottom - top) * fy)
  }
  const fitsPhone = async (page: Page, keys: string[]) => {
    const vw = page.viewportSize()!.width
    const boxes = await Promise.all(keys.map((k) => rect(boxOf(page, k))))
    for (const b of boxes) {
      expect(b.height).toBeGreaterThanOrEqual(44)
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x + b.width).toBeLessThanOrEqual(vw)
    }
    if (boxes.length === 2) expect(boxes[0]!.x + boxes[0]!.width <= boxes[1]!.x || boxes[1]!.x + boxes[1]!.width <= boxes[0]!.x || boxes[0]!.y + boxes[0]!.height <= boxes[1]!.y || boxes[1]!.y + boxes[1]!.height <= boxes[0]!.y).toBe(true)
  }

  test('a finger draws a rectangle, a line and a circle with sizes typed in the boxes on the shape', async ({ page }) => {
    test.slow()
    await sketchOnPlane(page)
    // rectangle: the boxes sit on it from the first tap, the keyboard stays down until a box is tapped
    await family(page, 'Rectangle').tap()
    await tapAt(page, 0.3, 0.3)
    await expect(boxOf(page, 'width')).toBeVisible()
    await expect(inputOf(page, 'width')).not.toBeFocused()
    await fitsPhone(page, ['width', 'height'])
    await boxOf(page, 'width').locator('input').tap()
    await page.keyboard.type('16')
    await inputOf(page, 'height').tap()
    await page.keyboard.type('8')
    await page.screenshot({ path: test.info().outputPath('phone-rect-typed.png') })
    await page.keyboard.press('Enter')
    // 16 by 8 from the corner tapped (a finger lands on the nearest grid point)
    await expect.poll(async () => size((await loops(page))[0])).toEqual([16, 8])
    await expect.poll(() => labels(page)).toEqual(['16', '8'])

    // line: 15 straight up
    await family(page, 'Line').tap()
    await tapAt(page, 0.7, 0.3)
    await expect(boxOf(page, 'length')).toBeVisible()
    await fitsPhone(page, ['length', 'angle'])
    await inputOf(page, 'length').tap()
    await page.keyboard.type('15')
    await inputOf(page, 'angle').tap()
    await page.keyboard.type('90')
    await page.keyboard.press('Enter')
    await expect.poll(async () => size((await loops(page))[1])).toEqual([0, 15])
    await inputOf(page, 'length').press('Escape')

    // circle: 10 across
    await family(page, 'Circle').tap()
    await tapAt(page, 0.5, 0.15)
    await expect(boxOf(page, 'diameter')).toBeVisible()
    await fitsPhone(page, ['diameter'])
    await inputOf(page, 'diameter').tap()
    await page.keyboard.type('10')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await loops(page))[2]).toMatchObject({ type: 'circle', diameterMm: 10 })
    await page.screenshot({ path: test.info().outputPath('phone-drawn.png') })
  })

  test('a box on the shape stays clear of the undo group and the other floating controls', async ({ page }) => {
    test.slow()
    await sketchOnPlane(page)
    await family(page, 'Rectangle').tap()
    // a first tap high and at the right of the view: its Height box would go above the corner, under the undo group
    await tapAt(page, 0.85, 0)
    await expect(boxOf(page, 'width')).toBeVisible()
    await fitsPhone(page, ['width', 'height'])
    const first = await boxesOverControls(page)
    await page.waitForTimeout(1500)
    const r = await boxesOverControls(page)
    expect(r.controls).toBeGreaterThan(0)
    expect(r.over, JSON.stringify({ first, r })).toBe(0)
    await page.screenshot({ path: test.info().outputPath('phone-top-right.png') })
  })
})
