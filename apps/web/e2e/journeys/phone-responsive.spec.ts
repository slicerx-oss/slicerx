// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The phone journey: the app in a phone window with a finger. Model in the build that models only (the bar of fixed slots,
// its sheets, the sketch's tools, a finger that selects, turns the view, drags a gizmo handle and holds), the slim Slice
// studio (Simple settings, no modeling or plate tools, a finger that never moves the model), the controls after a slice,
// the touch tip, and long names. One page serves the whole file. The Model build and the Slice build differ by a boot flag
// the app reads at load, so a test that needs the other one reloads the page (boot below); the rest share the page as it is.
//
// The desktop describe runs on a desktop window: the long names must also fit at 1440 and 1100 wide. The phone project
// never runs it; it is here so the long-names checks stay in one place, and the config can let the desktop project run
// this file too. The view chips test runs in both: a phone, and a desktop window as narrow as one.
import { type CDPSession, type Page } from '@playwright/test'
import { addMenu, appReady, closeSheet, expect, goTab, openSheet, plateReady, sliceCount, sliced, tab, viewportReady } from '../fixtures'
import { journey as test } from '../journey'
import { shotsDir, shotsOn } from './lib/session'

// Debug hooks (__sx, __vp) on, the Slice tab, mimir off. The phone opens Slice in Simple whatever was saved, so a pref saved
// from a desktop is set here too: the slim studio must leave it alone for the person's desktop.
const SLICE = { workspace: 'prepare', pilot: { mode: 'off' }, modelModeDefault: 'design', settingsMode: 'expert' }
// The page's first load (a desktop window opens Model with those, so the desktop test finds no plate list): the boots below set the rest.
test.use({ journeyPrefs: { workspace: 'prepare', pilot: { mode: 'off' } } })

const LONG = 'Workshop enclosure printer with the hardened nozzle, bay 12 A'
const PRINTER = { id: 'e2e-long-name', name: LONG, profileId: 'bambu-a1', vendor: 'Bambu Lab', model: 'A1', nozzleCount: 1 }
const longName = (kind: string, n = 1) => `${kind} ${n} for the workshop enclosure with the hardened nozzle`.slice(0, 60)

type Boot = 'model' | 'slice' | 'long' | 'window'
const BOOTS: Record<Boot, { prefs: Record<string, unknown>; cadOnly: boolean }> = {
  model: { prefs: { workspace: 'prepare', pilot: { mode: 'off' } }, cadOnly: true },
  slice: { prefs: SLICE, cadOnly: false },
  long: { prefs: { workspace: 'prepare', settingsMode: 'expert', pilot: { mode: 'off' }, handPrinters: [PRINTER], printerId: PRINTER.id }, cadOnly: false },
  // Slice on a desktop window: SLICE would open Model there (modelModeDefault), so the journey's own prefs.
  window: { prefs: { workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }, cadOnly: false },
}

/**
 * Makes the page the kind of app a test needs and reloads it only when it is not that already: the debug hooks, the saved
 * prefs and the Model-only flag are read at load. The kind is kept in sessionStorage, which a reload keeps.
 */
async function boot(page: Page, kind: Boot, { fresh = false }: { fresh?: boolean } = {}): Promise<void> {
  const same = await page.evaluate((k) => sessionStorage.getItem('sx-journey-boot') === k && Boolean((window as unknown as { __sx?: unknown }).__sx), kind)
  if (!same || fresh) {
    await page.evaluate(
      ({ kind, config }) => {
        localStorage.setItem('slicerx.debug', '1')
        localStorage.setItem('slicerx.prefs.v1', JSON.stringify(config.prefs))
        if (config.cadOnly) localStorage.setItem('slicerx.e2e.cadOnly', '1')
        else localStorage.removeItem('slicerx.e2e.cadOnly')
        sessionStorage.setItem('sx-journey-boot', kind)
      },
      { kind, config: BOOTS[kind] },
    )
    await page.reload()
  }
  if (kind === 'model') {
    await appReady(page)
    await page.locator('html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: 120_000 })
  } else if (kind === 'long') {
    // The long-name printer is not the one the example plate was made for, so only the studio's own mark is waited for.
    await page.locator('html[data-sx-ready="plate"], html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: 120_000 })
  } else await plateReady(page)
}

/**
 * Closes an open side sheet with Escape (fixtures.ts closeSheet); Escape did not close it once in 9 runs after a held touch,
 * so a tap on the dimmed view above the sheet is the second try.
 */
async function shutSheet(page: Page): Promise<void> {
  try {
    await closeSheet(page)
  } catch {
    await page.touchscreen.tap(20, 20)
    await closeSheet(page)
  }
}

/** Runs `use` at another window size and puts the project's own size back, so the next test starts where this one did. */
async function sized<T>(page: Page, viewport: { width: number; height: number }, use: () => Promise<T>): Promise<T> {
  const was = page.viewportSize()!
  await page.setViewportSize(viewport)
  try {
    return await use()
  } finally {
    await page.setViewportSize(was)
  }
}

type Entry = { id: string; transform: number[] }
type Sx = { getState(): { plate: Entry[]; selection: string | null; objectTool: string | null }; setState(p: unknown): void }
const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())
const setState = (page: Page, p: Record<string, unknown>) => page.evaluate((x) => (window as unknown as { __sx: Sx }).__sx.setState(x), p)

// ---- Model on a phone ------------------------------------------------------------------------------------------------

/** Empties the plate and adds a box from the bar's Add menu, as a finger would. Returns its id, selected. */
async function addBox(page: Page): Promise<string> {
  await setState(page, { plate: [], selection: null, selectedIds: [] })
  await page.getByTestId('phone-add').tap()
  await page.getByRole('menu', { name: 'Add' }).getByRole('menuitem', { name: 'Box' }).first().tap()
  await expect.poll(async () => (await state(page)).plate.length).toBe(1)
  const id = (await state(page)).plate[0]!.id
  await setState(page, { selection: id, selectedIds: [id] })
  // Model frames a new part and then the selection, each an eased camera move: measure screen points once it stops
  await page.waitForFunction(() => (window as unknown as { __vp: { rig: { move: unknown } } }).__vp.rig.move === null)
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

/** A point of an object's box, bed mm, as fractions of its size from the low corner. */
function pointIn(page: Page, id: string, f: [number, number, number]): Promise<[number, number, number]> {
  return page.evaluate(([id, f]) => {
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
    return [0, 1, 2].map((k) => lo[k]! + (hi[k]! - lo[k]!) * f[k]!) as [number, number, number]
  }, [id, f] as const)
}

/** The middle of an object's box, bed mm. */
const middleOf = (page: Page, id: string) => pointIn(page, id, [0.5, 0.5, 0.5])

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

test.describe('phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'Phone only')

  test.describe('Model on a phone', () => {
    test('the bar has six fixed slots a finger can hit, at 390, 360 and 430 wide', async ({ page }) => {
      await boot(page, 'model')
      await expect(page.locator('.shelf')).toHaveCount(0)
      const was = page.viewportSize()!
      try {
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
      } finally {
        await page.setViewportSize(was)
      }
    })

    test('a tap selects the model and a tap on empty space clears it', async ({ page }) => {
      await boot(page, 'model')
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
      await boot(page, 'model')
      const id = await addBox(page)
      await expect(page.getByTestId('phone-handle-move')).toHaveAttribute('aria-checked', 'true')
      const cdp = await page.context().newCDPSession(page)
      // a drag that starts on the model itself turns the view and leaves the model where it is. Framed, the model's
      // middle is the move arrows' origin, so the drag starts on the low X and Y side, away from all three arrows.
      const before = (await state(page)).plate[0]!.transform.join(',')
      const body = await screenOf(page, await pointIn(page, id, [0.2, 0.2, 0.5]))
      // In four steps, so the first move is already past the 8 px a held finger may wander. Each step waits for the
      // page to take it, one a frame, so on a slow runner a drag still inside that read as a finger held for Select
      // Other, whose list then took the arrow drag below.
      await finger(cdp, body, { x: body.x + 60, y: body.y + 10 }, 0, 4)
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

    test('a finger held on the model opens Select Other, whose More actions opens the ring menu', async ({ page }) => {
      await boot(page, 'model')
      const id = await addBox(page)
      // nothing selected, so no move arrow starts under the finger: a hold on a handle drags it instead
      await setState(page, { selection: null, selectedIds: [] })
      const cdp = await page.context().newCDPSession(page)
      const mid = await screenOf(page, await middleOf(page, id))
      await finger(cdp, mid, mid, 800, 1)
      await expect(page.getByTestId('select-other')).toBeVisible()
      await page.getByTestId('select-other-more').tap()
      await expect(page.getByTestId('model-ring')).toBeVisible()
    })

    test('Tree and Edit open their sheets and close them again; the tool sheet leaves the view taking taps', async ({ page }) => {
      await boot(page, 'model')
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
      await boot(page, 'model')
      await addBox(page)
      await page.getByTestId('phone-tools').tap()
      // (the menu also offers the tool that follows the last edit, as a second item of the same name)
      await page.getByTestId('phone-tools-menu').locator('[data-tool="push"]').tap()
      await expect(page.locator('[data-section="cad-tool"]')).toBeInViewport()
      await expect(page.getByTestId('phone-edit')).toHaveAttribute('aria-pressed', 'true')
      await page.locator('[data-section="cad-tool"]').getByRole('button', { name: 'Cancel' }).tap()
      await expect.poll(async () => (await state(page)).objectTool).toBe(null)
      await expect(page.getByTestId('phone-edit')).toHaveAttribute('aria-pressed', 'false')
    })

    test('a sketch puts its two rows of drawing tools in the bar, and Finish sketch ends it', async ({ page }) => {
      await boot(page, 'model')
      await setState(page, { plate: [], selection: null, selectedIds: [] })
      await page.getByTestId('phone-sketch').tap()
      await expect(page.getByTestId('phone-sketch')).toHaveAttribute('aria-pressed', 'true')
      // the panel takes picks once it is up
      await expect(page.getByRole('complementary', { name: 'Tool and transform' })).toContainText('Tap an origin plane')
      await page.evaluate(() => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('pick', { objectId: null, partIndex: null, triangle: null, point: null, bed: null, originPlane: 'xy' }))
      const bar = page.getByTestId('phone-sketch-bar')
      const families = bar.getByRole('radiogroup', { name: 'Drawing tool' })
      await expect(families).toBeInViewport()
      // the view's pill says the mode, as on a desktop
      await expect(page.getByTestId('model-select-readout')).toHaveText('Sketching on a plane · Line')
      await expect(page.locator('.pbar-slots')).toBeHidden()
      const row = (await families.boundingBox())!
      // Rectangle: its ways to draw show in the second row; the first row stays put
      await families.getByRole('radio', { name: 'Rectangle' }).tap()
      await expect(families.getByRole('radio', { name: 'Rectangle' })).toHaveAttribute('aria-checked', 'true')
      await expect(bar.getByRole('radiogroup', { name: 'Draw it by' })).toBeVisible()
      expect((await families.boundingBox())!).toEqual(row)
      for (const b of await families.getByRole('radio').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect))) {
        expect(b.width).toBeGreaterThanOrEqual(44)
        expect(b.height).toBeGreaterThanOrEqual(44)
      }
      // the row scrolls inside the bar instead of running off the screen
      const rowBox = (await families.boundingBox())!
      expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(page.viewportSize()!.width)
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

    test('drawing folds the sheet to the tool and its state, with a button to open it, and Finish sketch in reach', async ({ page }, info) => {
      await boot(page, 'model')
      await setState(page, { plate: [], selection: null, selectedIds: [] })
      await page.getByTestId('phone-sketch').tap()
      const sheet = page.getByRole('complementary', { name: 'Tool and transform' })
      await expect(sheet).toContainText('Tap an origin plane')
      await page.evaluate(() => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('pick', { objectId: null, partIndex: null, triangle: null, point: null, bed: null, originPlane: 'xy' }))
      // no box repeats the tool; the sheet's header, just above the tool strip, names it and sums up the sketch
      await expect(page.getByTestId('phone-sketch-bar').getByTestId('sketch-variant-one')).toHaveCount(0)
      const summary = page.getByTestId('sketch-summary')
      await expect(summary).toContainText('Line')
      const toggle = page.getByTestId('sketch-sheet-toggle')
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      const open = (await sheet.boundingBox())!
      if (process.env['SX_SHOTS']) await page.screenshot({ path: info.outputPath('phone-sheet-open.png') })
      // the first point folds the sheet to its header: the view gets the room, the summary and Finish sketch stay
      await page.evaluate(() => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('sketch', { kind: 'click', at: [-10, -10], mmPerPx: 0.2, screen: [200, 300], shift: false, alt: false }))
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect.poll(async () => (await sheet.boundingBox())!.height).toBeLessThan(open.height / 2)
      await expect(summary).toBeInViewport()
      await expect(page.getByTestId('sketch-finish')).toBeInViewport()
      if (process.env['SX_SHOTS']) await page.screenshot({ path: info.outputPath('phone-sheet-folded.png') })
      // the button opens it again, and Finish sketch is still there
      await toggle.tap()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(page.locator('#sk-grid')).toBeInViewport()
      await expect(page.getByTestId('sketch-finish')).toBeInViewport()
      await toggle.tap()
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      // A line of one point cannot finish, so the tool is put away the way a replaced project does it; the next test starts with the bar.
      await setState(page, { objectTool: null })
      await expect(page.locator('.pbar-slots')).toBeVisible()
    })
  })

  // ---- The slim studio on a phone --------------------------------------------------------------------------------------

  test.describe('the slim studio on a phone', () => {
    // The desktop window at 800 px with a mouse (the old last test here) is phone-layout.test.ts:33/38, which sets the
    // width and the pointer and asks whether the window is a phone. The Supports radio test (Off and Auto, Painted kept)
    // was dropped with the approved plan; no unit test reads that radio.
    test('Slice shows Simple settings and the objects as a list, with no modeling or plate tools', async ({ page }) => {
      // saved as if the person had used Model and Expert on a desktop (SLICE): the phone still opens Slice in Simple
      await boot(page, 'slice')
      await expect(tab(page, 'prepare')).toHaveAttribute('aria-current', 'page')
      await expect(page.getByTestId('tab-model')).toHaveCount(0)
      await openSheet(page)
      const sheet = page.getByTestId('slice-sidebar')
      await expect(sheet.getByText('Print settings')).toBeVisible()
      await expect(page.locator('#expert-toggle')).toHaveCount(0)
      await expect(page.locator('.mode-chip')).toHaveCount(0)
      await expect(page.locator('.settings-tabs, [role="tablist"][aria-label="Settings"]')).toHaveCount(0)
      // the objects: a row and its print toggle; no lock, parts, transform fields or tool panels
      const row = page.getByTestId('object-row').first()
      await expect(row.getByTestId('object-printable')).toBeVisible()
      await expect(row.getByTestId('object-lock')).toHaveCount(0)
      await expect(row.getByTestId('slice-object-expand')).toHaveCount(0)
      await row.getByTestId('object-select').click()
      await expect(page.locator('.tf-row')).toHaveCount(0)
      // no selection bar or its menu: those verbs are edits
      await expect(page.getByTestId('slice-selection-bar')).toHaveCount(0)
      // and no scope pill: a phone's settings are the plate's
      await expect(page.getByTestId('slice-scope-object')).toHaveCount(0)
      // the plate toolbar isn't there at all
      await expect(page.locator('.plate-tools')).toHaveCount(0)
      // the settings that stay are still the person's to change: the saved mode is kept for their desktop
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('slicerx.prefs.v1') ?? '{}').settingsMode)).toBe('expert')
      await shutSheet(page)
    })

    test('the Add menu offers files, the Vault and printer exports only', async ({ page }) => {
      await boot(page, 'slice')
      await openSheet(page)
      await page.getByTestId('slice-objects-add-menu').click()
      const menu = page.getByRole('menu', { name: 'Add' })
      await expect(menu.getByRole('menuitem', { name: 'From the Vault', exact: true })).toBeVisible()
      await expect(menu.getByRole('menuitem', { name: 'Export', exact: true })).toBeVisible()
      for (const gone of ['Add shape', 'Tools', 'Object']) await expect(menu.getByRole('menuitem', { name: gone, exact: true })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await addMenu(page, 'Export')
      const exp = page.getByRole('menu', { name: 'Export' })
      await expect(exp.getByTestId('export-gcode-3mf')).toBeVisible()
      await expect(exp.getByTestId('export-save-project')).toHaveCount(0)
      await expect(exp.getByTestId('export-locked-project')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await shutSheet(page)
    })

    test('a finger on the model selects it or turns the view, and never moves it', async ({ page }) => {
      await boot(page, 'slice')
      await shutSheet(page)
      const before = (await state(page)).plate.map((p) => p.transform.join(','))
      const box = (await page.locator('.vp-canvas').boundingBox())!
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      // a tap, then a press and drag starting on the model
      await page.touchscreen.tap(x, y)
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 60, y + 20, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(300)
      expect((await state(page)).plate.map((p) => p.transform.join(','))).toEqual(before)
    })

    test('the Vault and the printers are a tap away', async ({ page }) => {
      await boot(page, 'slice')
      await shutSheet(page)
      await goTab(page, 'printers')
      await expect(page.locator('.app[data-workspace="printers"]')).toBeVisible()
      await goTab(page, 'feed').catch(() => goTab(page, 'library'))
      await expect(page.locator('.app[data-workspace="library"], .app[data-workspace="feed"]')).toBeVisible()
      await goTab(page, 'prepare')
    })
  })

  // ---- Slice after a slice ------------------------------------------------------------------------------------------

  // Slice after a slice: no control sits over another. On a phone Print is on screen with nothing over it, and opening
  // the playback bar moves neither its own toggle nor Print. 390 and 360 share one boot and one slice.
  test('at 390 and 360 px, after a slice nothing overlaps and Print is in reach', async ({ page }) => {
    test.slow()
    await boot(page, 'slice')
    await shutSheet(page)
    const n = await sliceCount(page)
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(sliced(page, n)).toBeVisible({ timeout: 120_000 })
    await expect(page.locator('.vp .dock')).toBeVisible()
    for (const width of [390, 360]) {
      await sized(page, { width, height: 844 }, async () => {
        await panesStill(page)
        const boxes = await controls(page)
        const pairs = boxes.flatMap((a, i) => boxes.slice(i + 1).filter((b) => meet(a, b)).map((b) => `${a.name} / ${b.name}`))
        expect(pairs, `at ${width} px`).toEqual([])
        await printInReach(page)

        // The playback bar opens over the foot of the view: its toggle and Print stay where they were.
        const toggle = page.getByRole('button', { name: 'More playback controls' })
        const before = { toggle: await toggle.boundingBox(), print: await page.getByTestId('danger-slice-print').boundingBox() }
        await toggle.click()
        await expect(page.getByRole('button', { name: 'Fewer playback controls' })).toBeVisible()
        await expect(page.getByRole('radiogroup', { name: 'Playback speed' })).toBeVisible()
        expect(await page.getByRole('button', { name: 'Fewer playback controls' }).boundingBox()).toEqual(before.toggle)
        expect(await page.getByTestId('danger-slice-print').boundingBox()).toEqual(before.print)
        await printInReach(page)
        // shut again, so the second width and the next test start with it shut
        await page.getByRole('button', { name: 'Fewer playback controls' }).click()
        await expect(page.getByRole('button', { name: 'More playback controls' })).toBeVisible()
      })
    }
  })

  // ---- Touch -------------------------------------------------------------------------------------------------------------

  // Touch has no hover: a long press shows a control's tip above the finger, and releasing does not tap the control.
  test('a long press shows the tip and the release does not press the control', async ({ page }, info) => {
    await boot(page, 'slice')
    await viewportReady(page)
    // the object's print toggle in the Slice sheet: a phone views and prints, so it has no plate tools to hold
    await openSheet(page)
    const print = page.getByTestId('object-row').first().getByTestId('object-printable')
    // it starts off the print's list (not pressed), whatever the last test left
    if ((await print.getAttribute('aria-pressed')) !== 'false') await print.click()
    await expect(print).toHaveAttribute('aria-pressed', 'false')
    const cdp = await page.context().newCDPSession(page)
    const centerOf = async (button: ReturnType<Page['locator']>) => {
      const box = (await button.boundingBox())!
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    const touchOn = (button: ReturnType<Page['locator']>) => async (type: 'touchStart' | 'touchEnd') => {
      const { x, y } = await centerOf(button)
      await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
    }
    // A tap is a finger down for 60 ms, as a real one is: Playwright's own tap() lifts in the same millisecond, and Chromium on
    // Linux then sends the click to the toolbar and not the button.
    const tap = async (button: ReturnType<Page['locator']>) => {
      const touch = touchOn(button)
      await touch('touchStart')
      await page.waitForTimeout(60)
      await touch('touchEnd')
    }
    // A short tap presses the toggle and shows no tip. Chromium's touch hit test is stale until the page has had a mouse
    // event, so one click on the row's name comes first, and the tap repeats while the toggle is not pressed. How many
    // taps it took is recorded on the test, so a run that needed several shows up.
    await page.getByTestId('object-row').first().getByTestId('object-select').click()
    let taps = 0
    await expect(async () => {
      if ((await print.getAttribute('aria-pressed')) !== 'true') {
        taps++
        await tap(print)
      }
      await expect(print).toHaveAttribute('aria-pressed', 'true', { timeout: 1500 })
    }).toPass({ timeout: 20_000 })
    info.annotations.push({ type: 'touch-taps', description: String(taps) })
    if (taps > 1) console.log(`touch-tips: the tap took ${taps} tries before the toggle pressed`)
    await expect(page.locator('#sx-tip')).toHaveCount(0)
    // Put it back, then hold.
    await print.click()
    await expect(print).toHaveAttribute('aria-pressed', 'false')
    // the click leaves the mouse over the toggle; away from it, so the tip below can only come from the finger
    await page.mouse.move(1, 1)
    await expect(page.locator('#sx-tip')).toHaveCount(0)
    const hold = touchOn(print)
    await hold('touchStart')
    await expect(page.locator('#sx-tip')).toContainText('leave it out of the print', { timeout: 3000 })
    await hold('touchEnd')
    await expect(page.locator('#sx-tip')).toHaveCount(0)
    // the release did not press it
    await expect(print).toHaveAttribute('aria-pressed', 'false')
    // and a press right after it does: the hold drops only the click its own release makes, not the next one
    await print.click()
    await expect(print).toHaveAttribute('aria-pressed', 'true')
    await print.click()
    await expect(print).toHaveAttribute('aria-pressed', 'false')
    await shutSheet(page)
  })

  // ---- Long names ----------------------------------------------------------------------------------------------------------

  test('a 60-character name ellipsizes closed and reads whole on hover, focus and in the list at 390 px', async ({ page }) => {
    await longNames(page, true)
  })
})

// The same checks at the desktop widths. The phone project never runs this one.
test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop widths')

  test('a 60-character name ellipsizes closed and reads whole on hover, focus and in the list at 1440 and 1100 px', async ({ page }) => {
    test.slow()
    for (const width of [1440, 1100]) {
      await test.step(`at ${width} px`, async () => {
        // A fresh load per width, as each width was its own boot: the preset picker's tip did not show at 1100 after a pass at
        // 1440 on the same page in 2 of 3 runs (cause not found), and does on a fresh load.
        // The window is resized first, so the studio loads at the width it is checked at.
        await sized(page, { width, height: 900 }, async () => {
          await boot(page, 'long', { fresh: true })
          await longNames(page, false)
        })
      })
    }
  })
})

// ---- The view chips after a slice ------------------------------------------------------------------------------------------

// The view switch (Solid, Layer lines, Toolpaths) and the legend chip at phone widths, after a slice: on a phone, and in a
// desktop window as narrow as one (the compact layout, with the mouse). Each chip is whole inside the window and the
// view, none sits over another or over the corner buttons, and pressing a look moves neither chip. Both projects run it.
test('at 390 and 360 px, after a slice every view chip is inside the view and none overlap', async ({ page, isMobile }, info) => {
  test.slow()
  await boot(page, isMobile ? 'slice' : 'window')
  if (isMobile) await shutSheet(page)
  else await page.keyboard.press('Escape')
  const n = await sliceCount(page)
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(sliced(page, n)).toBeVisible({ timeout: 120_000 })
  const switcher = page.locator('.slice-look')
  const chip = page.getByTestId('legend-chip')
  for (const width of [390, 360]) {
    await sized(page, { width, height: 844 }, async () => {
      await panesStill(page)
      await expect(switcher).toBeVisible()
      await expect(chip).toBeVisible()
      const at = await page.locator('.vp').evaluate((vp) => {
        const box = (el: Element) => {
          const r = el.getBoundingClientRect()
          return { x: r.x, y: r.y, w: r.width, h: r.height }
        }
        const chips = [...vp.querySelectorAll('.slice-look, [data-testid="legend-chip"]')].map((el) => ({ name: el.className, ...box(el) }))
        const corner = [...vp.querySelectorAll('.hud-top .hud-col > .hud-row:first-child > *, .hud-top .hud-col.end > *')].map((el) => ({ name: el.className, ...box(el) }))
        const row = vp.querySelector('[data-testid="legend-row"]')!
        return { window: innerWidth, view: box(vp), chips, corner, rowOver: row.scrollWidth - row.clientWidth }
      })
      expect(at.chips, `at ${width} px`).toHaveLength(2)
      const outside = at.chips
        .filter((c) => c.x < Math.max(0, at.view.x) - 0.5 || c.x + c.w > Math.min(at.window, at.view.x + at.view.w) + 0.5)
        .map((c) => `${c.name} ${Math.round(c.x)} to ${Math.round(c.x + c.w)} of ${Math.round(at.view.x)} to ${Math.round(at.view.x + at.view.w)}`)
      expect(outside, `at ${width} px`).toEqual([])
      expect(at.rowOver, `at ${width} px`).toBeLessThanOrEqual(0)
      const pairs = at.chips.flatMap((a, i) => [...at.chips.slice(i + 1), ...at.corner].filter((b) => meet(a, b)).map((b) => `${a.name} / ${b.name}`))
      expect(pairs, `at ${width} px`).toEqual([])
      // Static controls: pressing a look moves neither chip.
      const before = { switcher: await switcher.boundingBox(), chip: await chip.boundingBox() }
      await switcher.getByRole('radio', { name: 'Layer lines' }).click()
      await expect(switcher).toBeVisible()
      expect(await switcher.boundingBox()).toEqual(before.switcher)
      await switcher.getByRole('radio', { name: 'Toolpaths' }).click()
      await expect(chip).toBeVisible()
      await panesStill(page)
      expect({ switcher: await switcher.boundingBox(), chip: await chip.boundingBox() }).toEqual(before)
      if (shotsOn()) {
        for (const scheme of ['dark', 'light']) {
          await setState(page, { scheme })
          await expect(page.locator('html')).toHaveAttribute('data-scheme', scheme)
          await page.screenshot({ path: `${shotsDir(info)}/view-chips-${isMobile ? 'phone' : 'window'}-${width}-${scheme}.png` })
        }
        await setState(page, { scheme: 'dark' })
      }
    })
  }
})

// ---- Helpers the slice and long-name tests share ---------------------------------------------------------------------------

type Box = { name: string; x: number; y: number; w: number; h: number }

/** The boxes of the controls laid over and under the 3D view. */
async function controls(page: Page): Promise<Box[]> {
  return page.locator('.vp').evaluate((vp) => {
    const sel = ['.hud-top .hud-col > *', '.slice-look', '.plate-tools', '.hud-bl > *', '.dock', '.slice-float']
    return sel.flatMap((s) =>
      [...vp.querySelectorAll<HTMLElement>(s)]
        .filter((el) => getComputedStyle(el).opacity !== '0' && getComputedStyle(el).visibility !== 'hidden')
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.height > 0)
        .map(({ el, r }) => ({ name: `${s} ${el.className}`, x: r.x, y: r.y, w: r.width, h: r.height })),
    )
  })
}

const meet = (a: Box, b: Box) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5

/** Waits until no pane or control is sliding after a resize, so the boxes measured are where they stay. */
async function panesStill(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => !document.getAnimations().some((a) => a.playState === 'running' && a instanceof CSSTransition))).toBe(true)
}

/** Print is inside the window and is what a tap on its middle reaches. */
async function printInReach(page: Page): Promise<void> {
  const print = page.getByTestId('danger-slice-print')
  await expect(print).toBeVisible()
  const hit = await print.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return { inside: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth, reached: top !== null && el.contains(top) }
  })
  expect(hit).toEqual({ inside: true, reached: true })
}

async function noSideways(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
  const bodies = page.locator('.pane-body, .sx-dialog-body')
  for (let i = 0; i < (await bodies.count()); i++) {
    const b = bodies.nth(i)
    if (!(await b.isVisible())) continue
    expect(await b.evaluate((el) => el.scrollWidth - el.clientWidth), await b.evaluate((el) => el.className)).toBeLessThanOrEqual(0)
  }
}

const tip = (page: Page) => page.locator('.sx-tip[data-ready]')

/**
 * A 60-character name (the longest a preset rename takes) for a printer and for printer, filament and process presets: it
 * ellipsizes in a closed control, reads whole in the tooltip on hover and focus and in the open list, and nothing runs past
 * the window. On a phone the sheet holds the printer card and a finger has no hover or focus tip.
 */
async function longNames(page: Page, isMobile: boolean): Promise<void> {
  await boot(page, 'long')
  // Saved presets live in the browser's preset store; Settings > Presets reads them from there.
  const presets = ['printer', 'filament', 'process', 'process'].map((kind, i) => ({ id: `e2e-long-${i}`, kind, name: longName(kind, i), values: {}, createdAt: 1, updatedAt: 1 }))
  await page.evaluate(
    (rows) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('slicerx-presets', 1)
        req.onupgradeneeded = () => req.result.createObjectStore('presets', { keyPath: 'id' })
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const tx = req.result.transaction('presets', 'readwrite')
          for (const r of rows) tx.objectStore('presets').put(r)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        }
      }),
    presets,
  )
  // Whatever the last test left open: a dialog, a popover, a sheet.
  for (let i = 0; i < 2; i++) await page.keyboard.press('Escape')
  if (isMobile) await openSheet(page)
  else {
    const opener = page.getByRole('button', { name: 'Open Printer and settings' })
    if (await opener.isVisible()) await opener.click()
  }
  // The printer: the card ellipsizes the name; hover and focus show it whole; the list shows it whole.
  const printer = page.getByTestId('slice-machine-printer')
  const shown = printer.locator('.printer-name')
  await expect(shown).toBeVisible()
  expect(await shown.evaluate((el) => [getComputedStyle(el).textOverflow, el.scrollWidth > el.clientWidth])).toEqual(['ellipsis', true])
  if (!isMobile) {
    // away first: a pointer already over the card from the last width opens no tip
    await page.mouse.move(1, 1)
    await printer.hover()
    await expect(tip(page)).toContainText(LONG)
    // The hover tip closes once the pointer leaves. Only focus moved by the keyboard opens a tip (focus set by code or
    // handed back by a popover does not), so Tab to the card rather than focusing it from script.
    await page.mouse.move(700, 450)
    await expect(tip(page)).toHaveCount(0)
    for (let i = 0; i < 40 && !(await printer.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab')
    await expect(printer).toBeFocused()
    await expect(tip(page)).toContainText(LONG)
  }
  await noSideways(page)
  await printer.click()
  const option = page.locator(`[data-testid="slice-machine-printer-option"][data-printer-id="${PRINTER.id}"] .mc-opt`)
  await expect(option).toContainText(LONG)
  expect(await option.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
  await page.keyboard.press('Escape')

  // The presets: the list shows every name whole, and the compare picker ellipsizes it while closed.
  if (isMobile) await shutSheet(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByTestId('settings-nav-presets').click()
  for (const kind of ['printer', 'filament', 'process']) {
    const row = dialog.locator('.preset-name b', { hasText: longName(kind, kind === 'printer' ? 0 : kind === 'filament' ? 1 : 2) })
    await expect(row).toBeVisible()
    expect(await row.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
  }
  const pick = dialog.locator('#cmp-a')
  await pick.scrollIntoViewIfNeeded()
  await pick.selectOption('e2e-long-2')
  expect(await pick.locator('option:checked').textContent()).toBe(longName('process', 2))
  const face = dialog.locator('.cmp-pick .sx-select-face > span').first()
  await expect(face).toHaveText(longName('process', 2))
  expect(await face.evaluate((el) => [getComputedStyle(el).textOverflow, el.scrollWidth > el.clientWidth])).toEqual(['ellipsis', true])
  if (!isMobile) {
    await page.mouse.move(1, 1)
    await pick.hover()
    await expect(tip(page)).toContainText(longName('process', 2))
  }
  await noSideways(page)
  // shut it, so the next test finds the studio and not the dialog: a menu or a tip can take the first Escape
  const settings = page.getByRole('dialog', { name: 'Settings' })
  for (let i = 0; i < 3 && (await settings.count()); i++) await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
}
