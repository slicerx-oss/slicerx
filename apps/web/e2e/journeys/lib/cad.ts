// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Shared steps for the CAD journeys (cad-ops, cad-sketch, phone-cad). They share one page per worker, so every test
// starts with `studio(page)`: it makes sure the debug hooks (window.__sx, __vp) are there and puts the studio back to
// what the first test found, then the test builds its own part.
import type { Locator, Page, TestInfo } from '@playwright/test'
import { bounds, command, facePick, freshBox, pick, placeAt, sketchAt, steps, toolPanel, type V3 } from '../../cad-helpers'
import { expect, viewportReady } from '../../fixtures'

export { bounds, clickStepButton, command, facePick, freshBox, height, pick, placeAt, pointsAround, pushTop, roundWall, sketchAt, steps, toolPanel, type V3 } from '../../cad-helpers'

type Anything = Record<string, unknown>
type Sx = { getState(): Anything; setState(p: unknown): void }
type Win = { __sx: Sx; __cadBase?: Anything }

const sizes = new WeakMap<Page, { width: number; height: number }>()

/**
 * Makes sure the page has the debug hooks. journey.ts sets 'slicerx.debug' before every load, so they are there from
 * the first frame; this is the guard for a page that lost them (it sets the flag and reloads once). `cadOnly` also
 * turns the page into the CAD-only studio, which the phone tests use.
 */
async function hooks(page: Page, cadOnly: boolean): Promise<void> {
  const ready = await page.evaluate((cadOnly) => {
    const w = window as unknown as Partial<Win> & { __vp?: unknown }
    const only = localStorage.getItem('slicerx.e2e.cadOnly') === '1'
    return w.__sx !== undefined && w.__vp !== undefined && only === cadOnly
  }, cadOnly)
  if (ready) return
  await page.evaluate((cadOnly) => {
    localStorage.setItem('slicerx.debug', '1')
    if (cadOnly) localStorage.setItem('slicerx.e2e.cadOnly', '1')
    else localStorage.removeItem('slicerx.e2e.cadOnly')
  }, cadOnly)
  await page.reload()
  await viewportReady(page)
}

/** Puts the studio back to how the first test of this page found it, with an empty plate and no tool open. */
async function reset(page: Page): Promise<void> {
  const size = sizes.get(page) ?? page.viewportSize()
  if (size) {
    sizes.set(page, size)
    const now = page.viewportSize()
    if (!now || now.width !== size.width || now.height !== size.height) await page.setViewportSize(size)
  }
  await page.evaluate(() => {
    const w = window as unknown as Win
    const s = w.__sx.getState()
    // what a test may change and not put back: the look, the units, the side panes, which half of Model is open
    w.__cadBase ??= { rails: s['rails'], appearance: s['appearance'], scheme: s['scheme'], themeFollowsSystem: s['themeFollowsSystem'], units: s['units'], modelMode: s['modelMode'], workspace: s['workspace'], pilot: s['pilot'] }
    w.__sx.setState({
      ...w.__cadBase,
      objectTool: null,
      historyEdit: null,
      rollback: null,
      parked: null,
      plate: [],
      selection: null,
      selectedIds: [],
      subPicks: [],
      timeline: { bodies: [], items: [], marker: 0 },
      namedValues: [],
      projectFile: null,
    })
  })
}

/** The start of every desktop CAD test. */
export async function studio(page: Page): Promise<void> {
  await hooks(page, false)
  await reset(page)
}

/** The start of every phone CAD test: the CAD-only studio, as a phone gets it. */
export async function phoneStudio(page: Page): Promise<void> {
  await hooks(page, true)
  await reset(page)
}

/** Opens the Design half of Model. */
export async function designTab(page: Page): Promise<void> {
  await page.locator('.sx-tab[data-mode="design"]').click()
}

/** Saves a picture only when SX_SHOTS asks for them, so a normal run attaches and writes nothing. */
export async function shot(page: Page, info: TestInfo, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
  if (!process.env['SX_SHOTS']) return
  await page.screenshot({ path: info.outputPath(name), ...(clip ? { clip } : {}) })
}

/** Sends the view's own events from a script. */
export const emit = (page: Page, e: string, p: unknown) => page.evaluate(({ e, p }) => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit(e, p), { e, p })

/** The store, for a test to read. */
export const store = (page: Page) => page.evaluate(() => (window as unknown as Win).__sx.getState())

/** Empties the plate (and nothing else), for a test that starts from an empty bed. */
export const emptyPlate = (page: Page) => page.evaluate(() => (window as unknown as Win).__sx.setState({ plate: [], selection: null, selectedIds: [] }))

/** A bed point (mm) on screen, in client pixels. */
export function screenOf(page: Page, p: V3): Promise<[number, number]> {
  return page.evaluate((p) => (window as unknown as { __vp: { screenOf(p: number[]): [number, number] } }).__vp.screenOf(p), p)
}

/** Waits until the view's frame stops moving (a pane opening or a framing move resizes it a little later). A camera move still running is not still. */
export async function settled(page: Page): Promise<void> {
  let last = ''
  let still = 0
  await expect
    .poll(async () => {
      const now = (await screenOf(page, [0, 0, 0])).map((v) => Math.round(v)).join(',')
      const moving = await page.evaluate(() => (window as unknown as { __vp: { rig: { move: unknown } } }).__vp.rig.move !== null)
      still = now === last && !moving ? still + 1 : 0
      last = now
      return still >= 4
    }, { intervals: [250], timeout: 15_000 })
    .toBe(true)
}

/** A fresh 20 mm box in Design, framed, with the camera still. */
export async function framedBox(page: Page, at?: [number, number]): Promise<string> {
  const id = await freshBox(page)
  if (at) await placeAt(page, at[0], at[1])
  await designTab(page)
  await expect.poll(() => page.evaluate((id) => (window as unknown as { __vp: { drawnObjects(): string[] } }).__vp.drawnObjects().includes(id), id)).toBe(true)
  await page.evaluate(() => (window as unknown as { __vp: { view(v: string, o?: unknown): void } }).__vp.view('fit', { animate: false }))
  await settled(page)
  return id
}

/** The middle of the box's top face on screen. */
export async function topMiddle(page: Page, id: string): Promise<{ x: number; y: number }> {
  const b = await bounds(page, id)
  const [x, y] = await screenOf(page, [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]])
  return { x, y }
}

/** A click on the top face of a framed box, then Push and pull, with the right pane open or shut. */
export async function pickThenPush(page: Page, id: string, pane: 'open' | 'shut' = 'open'): Promise<void> {
  const top = await topMiddle(page, id)
  await page.mouse.click(top.x, top.y)
  await expect(page.getByTestId('model-select-readout')).toHaveText('1 face on Box')
  await command(page, 'Push or pull a face')
  if (pane === 'shut') {
    await expect(page.getByTestId('model-inspector')).toBeVisible()
    await page.evaluate(() => {
      const s = (window as unknown as Win).__sx
      const rails = s.getState()['rails'] as Record<string, Record<string, boolean>>
      s.setState({ rails: { ...rails, 'prepare-design': { ...rails['prepare-design'], right: false } } })
    })
    await expect(page.getByTestId('model-inspector')).toBeHidden()
  }
  await settled(page)
  await expect(page.getByTestId('push-view-box')).toBeVisible()
}

/** What the view's operation preview draws now. */
export type Shown = { added: boolean; removed: boolean; look: { add: string; cut: string; addFill: number; cutFill: number } }
export const shown = (page: Page) => page.evaluate(() => (window as unknown as { __vp: { operationPreview(): Shown } }).__vp.operationPreview())

/** The way the camera looks, in bed coordinates (Z up). */
export const looking = (page: Page) =>
  page.evaluate(() => {
    type M = { clone(): M; invert(): M }
    type V = { x: number; y: number; z: number; transformDirection(m: M): V }
    const vp = (window as unknown as { __vp: { camera: { position: { constructor: new () => V }; getWorldDirection(v: V): V }; stage: { bedRoot: { matrixWorld: M } } } }).__vp
    const d = vp.camera.getWorldDirection(new vp.camera.position.constructor()).transformDirection(vp.stage.bedRoot.matrixWorld.clone().invert())
    return [d.x, d.y, d.z].map((v) => Math.round(v * 100) / 100 + 0)
  })

/** The body's size along each axis, smallest first. */
export const extents = (page: Page) =>
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

/** Starts a sketch on the bed (Design half) and returns the tool panel, ready to draw. */
export async function sketchOnBed(page: Page, at: [number, number] = [100, 100]) {
  await designTab(page)
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('Click an origin plane')
  await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, bed: at })
  await expect(panel).toContainText('The bed')
  return panel
}

/** A fresh box with a sketch open on its top face; the face's frame is centered on it, so its middle is 0, 0. */
export async function sketchOnTop(page: Page): Promise<string> {
  const id = await freshBox(page)
  await command(page, 'Sketch on the bed or a face')
  // the panel takes picks once it shows
  await expect(toolPanel(page)).toContainText('the bed or a flat face to sketch on')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(toolPanel(page)).toContainText('A face of')
  return id
}

/**
 * A fresh box with a round hole cut through it from a sketch on its top face: `diameter` mm across, in the middle.
 * The prelude of the fillet, hole and thread steps. Returns the box before the cut and the middle of its top.
 */
export async function circleCut(page: Page, diameter: string): Promise<{ id: string; before: Awaited<ReturnType<typeof bounds>>; cx: number; cy: number }> {
  const id = await freshBox(page)
  const before = await bounds(page, id)
  const cx = (before.min[0] + before.max[0]) / 2
  const cy = (before.min[1] + before.max[1]) / 2
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('the bed or a flat face to sketch on')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(panel).toContainText('A face of')
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Circle' }).click()
  // The face's frame is centered on the face: the center is 0, 0.
  await sketchAt(page, 'hover', [5, 0])
  await page.locator('body').press('0')
  const field = page.getByRole('group', { name: 'Exact size' })
  const sizes = page.getByRole('group', { name: 'Sizes of the shape being drawn' })
  await field.getByLabel('X mm').fill('0')
  await field.getByLabel('Y mm').fill('0')
  await field.getByLabel('Y mm').press('Enter')
  await sketchAt(page, 'hover', [5, 0])
  await page.locator('body').press(diameter[0]!)
  await sizes.getByLabel('Diameter mm').fill(diameter)
  await sizes.getByLabel('Diameter mm').press('Enter')
  await panel.getByRole('radiogroup', { name: 'Result' }).getByRole('radio', { name: 'Cut' }).click()
  // A cut goes into the face on its own.
  await panel.locator('#sk-dist').fill('25')
  await expect(panel.getByTestId('sketch-flip')).toHaveAttribute('aria-pressed', 'false')
  await panel.getByRole('button', { name: 'Extrude' }).click()
  await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: 'Sketch cut 25 mm', state: 'done' }])
  return { id, before, cx, cy }
}

/** The sketch tests' start on the bed: an empty studio, then a sketch on the bed plane. */
export async function bedSketch(page: Page) {
  await studio(page)
  return sketchOnBed(page)
}

// ---- what the sketch dimension boxes tests read, on the desktop and on a phone
export type V2 = [number, number]
export type Loop = { start?: V2; segments?: { type: string; to: V2 }[]; type?: string; center?: V2; diameterMm?: number }
export type W = {
  __vp: { screenOf(p: number[]): [number, number]; sketchLayer: { scene: { frame: { origin: number[]; u: number[]; v: number[] }; dims?: { label: string; hideLabel?: boolean }[] } | null }; emit(e: string, p: unknown): void; canvas: HTMLCanvasElement }
  __sketch: () => { loops?: Loop[]; dof?: number | null } | null
  __sketchBoxes: () => { read(): Boxes; set(r: Record<string, unknown>): Promise<Boxes & { driven: boolean }> } | null
}
export type Boxes = { dof: number | null; shapes: { shape: string; loop: number; seg?: number; boxes: { box: string; value: number; set: string | null }[] }[] }

/** Where plane point `p` of the open sketch is on screen. */
export const screenAt = (page: Page, p: V2) =>
  page.evaluate((p) => {
    const vp = (window as unknown as W).__vp
    const f = vp.sketchLayer.scene!.frame
    const s = vp.screenOf([0, 1, 2].map((k) => f.origin[k]! + f.u[k]! * p[0] + f.v[k]! * p[1]))
    return { x: s[0], y: s[1] }
  }, p)

/**
 * Waits until the view holds still: the sketch turns the camera square on as it opens. The turn is the camera rig's
 * move, which starts from an effect and takes its first step on the next frame, so a slow machine can show the same
 * spot for several reads before the camera goes. A move still running counts as not still, whatever the spot says.
 */
export async function still(page: Page): Promise<void> {
  let last = ''
  let n = 0
  await expect
    .poll(
      async () => {
        const s = await screenAt(page, [0, 0])
        const moving = await page.evaluate(() => (window as unknown as { __vp: { rig: { move: unknown } } }).__vp.rig.move !== null)
        const now = `${Math.round(s.x)},${Math.round(s.y)}`
        n = now === last && !moving ? n + 1 : 0
        last = now
        return n >= 3
      },
      { intervals: [250], timeout: 20_000 },
    )
    .toBe(true)
}

export const loops = (page: Page) => page.evaluate(() => (window as unknown as W).__sketch()?.loops ?? [])
export const labels = (page: Page) => page.evaluate(() => ((window as unknown as W).__vp.sketchLayer.scene?.dims ?? []).map((d) => d.label).sort())
/** The kept dimensions as the view draws them: how many, and how many have their value left off (shown in a box). */
export const dimsDrawn = (page: Page) =>
  page.evaluate(() => {
    const d = (window as unknown as W).__vp.sketchLayer.scene?.dims ?? []
    return { all: d.length, hidden: d.filter((x) => x.hideLabel).length }
  })
/** Every shown box that sits over a control floating on the view (the pill, the view buttons, a phone's undo group). */
export const boxesOverControls = (page: Page) =>
  page.evaluate(() => {
    const hit = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
    const controls = Array.from(document.querySelectorAll<HTMLElement>('.hud-top .hud-row, .hud-top .phandles, .hud-top .hud-col.end > *, .hud-bl > *, .pbar-wrap > *, .pane.sheet.sheet-open'))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
    const boxes = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="shape-box"]:not([hidden])')).map((el) => el.getBoundingClientRect())
    const rr = (r: DOMRect) => [r.left, r.top, r.right, r.bottom].map(Math.round)
    return { boxes: boxes.length, controls: controls.length, over: boxes.filter((b) => controls.some((c) => hit(b, c))).length, boxRects: boxes.map(rr), controlRects: controls.map(rr) }
  })
export const r2 = (v: number) => Math.round(v * 100) / 100
export const ends = (l: Loop | undefined) => (l?.segments ?? []).map((s) => s.to.map(r2))
// a loop's extent from its start: a rectangle's width and height, a line's run and rise
export const size = (l: Loop | undefined): V2 | null => {
  if (!l?.start || !l.segments?.length) return null
  const xs = [l.start[0], ...l.segments.map((s) => s.to[0])]
  const ys = [l.start[1], ...l.segments.map((s) => s.to[1])]
  return l.segments.length === 1 ? [r2(l.segments[0]!.to[0] - l.start[0]), r2(l.segments[0]!.to[1] - l.start[1])] : [r2(Math.max(...xs) - Math.min(...xs)), r2(Math.max(...ys) - Math.min(...ys))]
}
export const boxOf = (page: Page, key: string) => page.locator(`[data-testid="shape-box"][data-box="${key}"]:not([hidden])`)
export const inputOf = (page: Page, key: string) => boxOf(page, key).locator('input')
export const rect = async (l: Locator) => (await l.boundingBox())!

/** On a phone: adds a box from the Add button and waits for the camera to stop. Returns its id. */
export async function phoneBox(page: Page): Promise<string> {
  await page.getByTestId('phone-add').tap()
  await page.getByRole('menu', { name: 'Add' }).getByRole('menuitem', { name: 'Box' }).first().tap()
  await expect.poll(async () => ((await store(page))['plate'] as unknown[]).length).toBe(1)
  const id = ((await store(page))['plate'] as { id: string }[])[0]!.id
  await page.waitForFunction(() => (window as unknown as { __vp: { rig: { move: unknown } } }).__vp.rig.move === null)
  return id
}
