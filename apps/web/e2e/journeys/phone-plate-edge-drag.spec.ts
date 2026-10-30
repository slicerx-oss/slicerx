// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Plate edge drag on a phone, 390 x 844 with a finger on the move arrows: each edge's commit line is reachable with
// all of the part still in sight, and a drop with no plate bar on screen goes straight to the plate, says where the
// part went, and keeps the framing. The desktop gesture is in plate-edge-drag.spec.ts.
import type { CDPSession, Page } from '@playwright/test'
import { expect } from '../fixtures'
import { journey as test } from '../journey'
import { setState, settledView, useFlags } from './lib/model'

test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, sliceLook: 'toolpaths', autoSliceBySize: false } })
test.skip(({ isMobile }) => !isMobile, 'Phone only')
// Model on a phone: the parts move by their arrows, and no plate bar shows
useFlags({ 'slicerx.e2e.cadOnly': '1' }, true)

type Entry = { id: string; parts: { positions: ArrayLike<number> }[] }
type Sx = {
  getState(): { plates: { id: string; name: string; objects: unknown[] }[]; plate: Entry[]; activePlate: string; selectedIds: string[] }
  setState(p: unknown): void
}
type Vp = {
  rig: { move: unknown }
  camera: { position: { x: number; y: number; z: number } }
  controls: { target: { x: number; y: number; z: number } }
  canvas: HTMLCanvasElement
  objects: Map<string, { group: { matrix: { elements: number[] } } }>
  screenOf(p: number[]): [number, number]
  selectedEntries(): unknown[]
  arrowLayout(e: unknown[]): { origin: number[]; length: number }
}
type Box = { x0: number; y0: number; x1: number; y1: number }

const sx = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as { __sx: Sx }).__sx.getState()
  return { shown: s.plates.findIndex((p) => p.id === s.activePlate) + 1, plates: s.plates.map((p) => (p.id === s.activePlate ? s.plate.length : p.objects.length)), selected: s.selectedIds.length }
})

/** A box on plate 1 of four, selected with its move arrows up, the whole bed in view. Returns the box's id. */
async function setup(page: Page): Promise<string> {
  await setState(page, { plate: [], selection: null, selectedIds: [], objectTool: null })
  await page.getByTestId('phone-add').tap()
  await page.getByRole('menu', { name: 'Add' }).getByRole('menuitem', { name: 'Box' }).first().tap()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate.length)).toBe(1)
  const id = await page.evaluate(() => {
    const sx = (window as unknown as { __sx: Sx }).__sx
    const s = sx.getState()
    const id = s.plate[0]!.id
    const more = [2, 3, 4].map((n) => ({ id: `phone-edge-${n}`, name: `Plate ${n}`, objects: [], settings: {} }))
    sx.setState({ selection: id, selectedIds: [id], plates: [...s.plates.filter((p) => p.id === s.activePlate), ...more] })
    return id
  })
  await page.getByTestId('phone-handle-move').tap()
  await page.evaluate(() => (window as unknown as { __vp: { view(v: string, o?: unknown): void } }).__vp.view('bed', { animate: false }))
  await settledView(page)
  return id
}

/** The part as drawn now, its screen box, and whether all of it is inside the view on screen and not under a bar. */
const partOnScreen = (page: Page, id: string) =>
  page.evaluate((id) => {
    const vp = (window as unknown as { __vp: Vp }).__vp
    const e = (window as unknown as { __sx: Sx }).__sx.getState().plate.find((o) => o.id === id)!
    const m = vp.objects.get(id)!.group.matrix.elements
    const xs: number[] = []
    const ys: number[] = []
    for (const part of e.parts)
      for (let i = 0; i + 2 < part.positions.length; i += 3) {
        const [x, y, z] = [part.positions[i]!, part.positions[i + 1]!, part.positions[i + 2]!]
        const s = vp.screenOf([m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!])
        xs.push(s[0])
        ys.push(s[1])
      }
    const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
    const r = vp.canvas.getBoundingClientRect()
    const view = { x0: Math.max(0, r.left), y0: Math.max(0, r.top), x1: Math.min(innerWidth, r.right), y1: Math.min(innerHeight, r.bottom) }
    const inside = box.x0 >= view.x0 && box.x1 <= view.x1 && box.y0 >= view.y0 && box.y1 <= view.y1
    const onTop = [[(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2], [box.x0 + 2, box.y0 + 2], [box.x1 - 2, box.y0 + 2], [box.x0 + 2, box.y1 - 2], [box.x1 - 2, box.y1 - 2]].every(([x, y]) => document.elementFromPoint(x!, y!) === vp.canvas)
    return { box, inside, onTop }
  }, id)

/** Where the finger takes the arrow: its grab point and the arrow's way out on screen (a unit vector). */
const arrowGrab = (page: Page, axis: 0 | 1) =>
  page.evaluate((axis) => {
    const vp = (window as unknown as { __vp: Vp }).__vp
    const l = vp.arrowLayout(vp.selectedEntries())
    const at = (t: number) => vp.screenOf([l.origin[0]! + (axis === 0 ? l.length * t : 0), l.origin[1]! + (axis === 1 ? l.length * t : 0), l.origin[2]!])
    const p = at(0.8)
    const q = at(1)
    const o = at(0)
    const len = Math.hypot(q[0] - o[0], q[1] - o[1])
    return { x: p[0], y: p[1], dir: [(q[0] - o[0]) / len, (q[1] - o[1]) / len] as const }
  }, axis)

/** Two frames: the overlay draws what the last move read. */
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))

const touch = (cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', at?: { x: number; y: number }) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: at ? [{ x: at.x, y: at.y }] : [] })

const armedSide = (page: Page) => page.evaluate(() => document.querySelector('[data-testid="edge-drag"] .sx-edge-label[data-armed]')?.getAttribute('data-side') ?? null)

/** A finger keeps this far inside the screen: the outer strip is the screen's own edge swipes, and a thumb is wide. */
const FINGER_CLEAR = 32

/**
 * Puts a finger on the arrow along `axis` and draws it out `sign` way, a few px at a time, until an edge arms or the
 * finger is at the screen's edge. Once the move is on its way the view makes room; the finger waits for the view to
 * settle there, as a person's eye does, then goes on. Leaves the finger down. Returns how far the finger went when the
 * edge armed, where the finger was, and the part then and once the view rests.
 */
async function reach(page: Page, cdp: CDPSession, id: string, axis: 0 | 1, sign: 1 | -1) {
  const g = await arrowGrab(page, axis)
  const screen = page.viewportSize()!
  const at = (d: number) => ({ x: g.x + g.dir[0] * sign * d, y: g.y + g.dir[1] * sign * d })
  const clear = (p: { x: number; y: number }) => Math.min(p.x, p.y, screen.width - p.x, screen.height - p.y)
  await touch(cdp, 'touchStart', at(0))
  for (const d of [4, 8, 12, 16]) await touch(cdp, 'touchMove', at(d))
  await expect(page.getByTestId('edge-drag')).toHaveCount(1)
  await settledView(page)
  let d = 16
  let side: string | null = null
  while (!side && clear(at(d + 3)) >= 4) {
    d += 3
    await touch(cdp, 'touchMove', at(d))
    await frames(page)
    side = await armedSide(page)
  }
  const finger = at(d)
  const armedAt = await partOnScreen(page, id)
  // and where the view comes to rest with the part held there
  await settledView(page)
  const rest = await partOnScreen(page, id)
  const live = await page.getByTestId('edge-drag-live').textContent()
  return { side, distance: side ? d : null, fingerClear: Math.round(clear(finger)), armedAt, rest, live, out: (more: number) => at(d + more), clearOf: clear }
}
test.describe('plate edge drag on a phone', () => {
  test('every edge arms with the finger and all of the part on screen, and the part stays in sight past the line', async ({ page }) => {
    const id = await setup(page)
    const cdp = await page.context().newCDPSession(page)
    const rows: unknown[] = []
    try {
      for (const [axis, sign, name] of [[0, 1, 'x+'], [0, -1, 'x-'], [1, 1, 'y+'], [1, -1, 'y-']] as const) {
        const r = await reach(page, cdp, id, axis, sign)
        // on past the line, as far as the finger goes before the screen's edge strip
        let more = 0
        while (r.side && more < 160 && r.clearOf(r.out(more + 3)) >= FINGER_CLEAR) {
          more += 3
          await touch(cdp, 'touchMove', r.out(more))
        }
        await frames(page)
        await settledView(page)
        const past = await partOnScreen(page, id)
        rows.push({ edge: name, side: r.side, distance: r.distance, fingerClear: r.fingerClear, inside: r.armedAt.inside && r.rest.inside, onTop: r.armedAt.onTop && r.rest.onTop, pastBy: more, pastInside: past.inside && past.onTop, armedAt: r.armedAt.box, past: past.box })
        // a lift past the line would move it: Esc calls it off, so the part stays for the next edge
        await page.keyboard.press('Escape')
        await touch(cdp, 'touchEnd')
        await expect(page.getByTestId('edge-drag')).toHaveCount(0)
        await expect.poll(async () => (await sx(page)).plates).toEqual([1, 0, 0, 0])
        await settledView(page)
        expect.soft(r.side, `${name}: an edge arms before the finger is at the screen's edge`).not.toBeNull()
        expect.soft(r.fingerClear, `${name}: the finger is clear of the screen's edge when it arms`).toBeGreaterThanOrEqual(FINGER_CLEAR)
        expect.soft(r.armedAt.inside && r.rest.inside, `${name}: the part is inside the view when armed ${JSON.stringify(r)}`).toBe(true)
        expect.soft(r.armedAt.onTop && r.rest.onTop, `${name}: no bar covers the armed part ${JSON.stringify(r)}`).toBe(true)
        expect.soft(past.inside && past.onTop, `${name}: the part stays in sight ${more} px past the line ${JSON.stringify(past)}`).toBe(true)
      }
    } finally {
      test.info().annotations.push({ type: 'measure', description: JSON.stringify(rows) })
      await cdp.detach()
    }
  })

  test('a drop with no plate bar goes straight to the plate, says so, and keeps the framing', async ({ page }) => {
    const id = await setup(page)
    await expect(page.getByTestId('plate-picker-current')).toHaveCount(0)
    const camera = () => page.evaluate(() => {
      const vp = (window as unknown as { __vp: Vp }).__vp
      const p = vp.camera.position
      const t = vp.controls.target
      return { distance: Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z), target: [t.x, t.y, t.z] }
    })
    const before = await camera()
    const cdp = await page.context().newCDPSession(page)
    try {
      const r = await reach(page, cdp, id, 0, 1)
      expect(r.side).not.toBeNull()
      const plate = Number(/Plate (\d+)/.exec(r.live ?? '')?.[1])
      expect(plate).toBeGreaterThan(1)
      // from the lift, page side: when the plate shows, and when the view after it comes to rest
      await page.evaluate((plate) => {
        const w = window as unknown as { __sx: Sx; __vp: Vp; __drop?: { t0: number; shown?: number; settled?: number } }
        const target = w.__sx.getState().plates[plate - 1]!.id
        const d: { t0: number; shown?: number; settled?: number } = { t0: 0 }
        w.__drop = d
        addEventListener('touchend', () => {
          d.t0 = performance.now()
          let still = 0
          const tick = (now: number) => {
            const s = w.__sx.getState()
            if (d.shown === undefined && s.activePlate === target && w.__vp.objects.size > 0) d.shown = now
            if (d.shown !== undefined) still = w.__vp.rig.move === null ? still + 1 : 0
            if (d.shown !== undefined && still >= 3) d.settled = now
            if (d.settled === undefined && now - d.t0 < 5000) requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        }, { once: true, capture: true })
      }, plate)
      await touch(cdp, 'touchEnd')
      const drop = page.waitForFunction(() => (window as unknown as { __drop: { settled?: number } }).__drop.settled !== undefined)
      await drop
      const t = await page.evaluate(() => (window as unknown as { __drop: { t0: number; shown: number; settled: number } }).__drop)
      const s = await sx(page)
      const after = await camera()
      test.info().annotations.push({ type: 'measure', description: JSON.stringify({ plate, shownMs: Math.round(t.shown - t.t0), settledMs: Math.round(t.settled - t.t0), distanceBefore: before.distance, distanceAfter: after.distance }) })
      expect(s.shown).toBe(plate)
      expect(s.plates[plate - 1]).toBe(1)
      // no wait on a fly that has nowhere to go
      expect.soft(t.shown - t.t0, 'release to the plate shown, ms').toBeLessThan(300)
      // a short note says where it went
      await expect.soft(page.getByText(`Moved to Plate ${plate}`)).toBeVisible()
      // the plate opens framed as the view was, not zoomed close on the part
      expect.soft(Math.abs(after.distance / before.distance - 1), `camera distance ${before.distance} then ${after.distance}`).toBeLessThan(0.1)
      const p = await partOnScreen(page, id)
      expect.soft(p.inside, 'the part is in view on its new plate').toBe(true)
    } finally {
      await cdp.detach()
    }
  })
})
