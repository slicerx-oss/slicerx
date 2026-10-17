// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Picking and drawing in the 3D view, on one page: Model's box select, brim ears, the CAD look, the camera framing a
// pick, the pick filter and its feel, real clicks on faces and edges, the ring menu, the pick filter keys and Select
// Other. Each step starts from an empty Model (a fresh 20 mm box, or two or three of them) and does not count on the
// step before. The phone legs of Select Other are in phone-model.spec.ts, and the held-answer step of click-select is
// in nightly/model-click-select.spec.ts.
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { bounds, command, facePick, freshBox, pick, placeAt, pushTop, toolPanel } from '../cad-helpers'
import { pressable, screenOf } from '../canvas-press'
import { expect, journey as test } from '../journey'
import { bedToScreen, examplePlate, filter, fitView, framedBox, modelReset, nearFrontEdge, openModel, setState, settledView, shutRightPane, stackedSpot, subPicks, twoBoxes, useFileDialogs, useFlags, useStarters } from './lib/model'
import { clearToasts } from './lib/slice'

test.skip(({ isMobile }) => isMobile, 'Needs a pointer and a keyboard')
useFlags()
useFileDialogs()
const starters = useStarters()

type V3 = [number, number, number]
type Sx = { getState(): { plate: { id: string; name: string; transform: number[] }[]; subPicks: { kind: string; objectId: string }[]; selection: string | null; selectedIds: string[]; appearance: Record<string, unknown>; overrides: Record<string, unknown>; objectTool: string | null; scheme: string; themeFollowsSystem: boolean }; setState(p: unknown): void }
const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())
const readout = (page: Page) => page.getByTestId('model-select-readout')
const designTab = (page: Page) => page.locator('.sx-tab[data-mode="design"]')
const sliceTab = (page: Page) => page.locator('.sx-tab[data-mode="slice"]')

/** The camera position to 3 decimals, so float jitter from damping does not count as a move. */
const camera = (page: Page) =>
  page.evaluate(() => {
    const p = (window as unknown as { __vp: { camera: { position: { x: number; y: number; z: number } } } }).__vp.camera.position
    return [p.x, p.y, p.z].map((n) => Math.round(n * 1000) / 1000)
  })

// ---------------------------------------------------------------------------------------------------------------------
// Box select
// ---------------------------------------------------------------------------------------------------------------------

/** Model's box select: Shift and a left drag from empty space. Left to right picks the objects fully inside the box; right to left picks anything it touches. */
test.describe('Model box select', () => {
  const selected = (page: Page) => state(page).then((s) => s.selectedIds.length)

  async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    await pressable(page, from)
    await page.mouse.move(from.x, from.y)
    await page.keyboard.down('Shift')
    await page.mouse.down()
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 })
    await page.mouse.move(to.x, to.y, { steps: 4 })
    await expect(page.getByTestId('model-box-select')).toHaveAttribute('data-dir', to.x >= from.x ? 'inside' : 'touch')
    await page.mouse.up()
    await page.keyboard.up('Shift')
  }

  test('left to right picks what is inside, right to left what it touches', async ({ page }) => {
    await modelReset(page)
    // Three 20 mm boxes in a row along X, centered at 80, 120 and 160 mm.
    for (let i = 0; i < 3; i++) await command(page, 'Add a box')
    await expect.poll(async () => (await state(page)).plate.length).toBe(3)
    await page.evaluate(() => {
      const sx = (window as unknown as { __sx: Sx }).__sx
      sx.setState({ plate: sx.getState().plate.map((p, i) => ({ ...p, transform: p.transform.map((v, k) => (k === 12 ? 80 + 40 * i : k === 13 ? 128 : v)) })) })
    })
    await designTab(page).click()
    // The top view, so bed X and Y run straight across the screen. The camera flies there over frames, which come slowly
    // on a busy machine, so the points are read once it has stopped with bed Y running straight up the screen.
    await page.mouse.move(700, 450)
    await page.keyboard.press('1')
    const moving = () => page.evaluate(() => (window as unknown as { __vp: { stats(): { cameraMoving: boolean } } }).__vp.stats().cameraMoving)
    await expect.poll(async () => !(await moving()) && Math.abs((await screenOf(page, 60, 100, 0)).x - (await screenOf(page, 60, 160, 0)).x) < 1).toBe(true)
    await setState(page, { selection: null, selectedIds: [] })
    // Bed X 60 to 145 holds the first two boxes (70 to 90, 110 to 130) and not the third (150 to 170).
    const p0 = await screenOf(page, 60, 100, 0)
    const p1 = await screenOf(page, 145, 160, 0)
    await drag(page, { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y) }, { x: Math.max(p0.x, p1.x), y: Math.max(p0.y, p1.y) })
    await expect.poll(() => selected(page)).toBe(2)
    // Model frames a new selection, so the pick is cleared and the top view taken again before the points are read.
    await setState(page, { selection: null, selectedIds: [] })
    await page.mouse.move(700, 450)
    await page.keyboard.press('1')
    await page.waitForTimeout(300)
    await expect.poll(async () => !(await moving()) && Math.abs((await screenOf(page, 60, 100, 0)).x - (await screenOf(page, 60, 160, 0)).x) < 1).toBe(true)
    const q0 = await screenOf(page, 60, 100, 0)
    const q1 = await screenOf(page, 145, 160, 0)
    // Right to left from inside the third box, the same height: it touches all three.
    const p2 = await screenOf(page, 165, 128, 0)
    await drag(page, { x: p2.x, y: Math.max(q0.y, q1.y) }, { x: Math.min(q0.x, q1.x), y: Math.min(q0.y, q1.y) })
    await expect.poll(() => selected(page)).toBe(3)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Brim ears
// ---------------------------------------------------------------------------------------------------------------------

/** Brim ears in the viewport: rectangle select (hidden ears skipped), ear drag and Ctrl+wheel head size. */
test.describe('Brim ears', () => {
  interface BrimVp {
    brim: { forEachEar(cb: (id: string, i: number, e: { x: number; y: number; z: number }) => void): void }
    emit(e: string, p: unknown): void
    rig: { preset: string | null; move: unknown }
  }

  /** Ears the viewport draws, in bed coordinates. */
  const ears = (page: Page) =>
    page.evaluate(() => {
      const out: { i: number; x: number; y: number }[] = []
      ;(window as unknown as { __vp: BrimVp }).__vp.brim.forEachEar((_id, i, e) => out.push({ i, x: e.x, y: e.y }))
      return out
    })

  test('rectangle select, ear drag and Ctrl+wheel work on the plate', async ({ page }) => {
    test.slow()
    // The spots below are on the Layered X, whose far side hides the third ear from the iso view.
    await examplePlate(page)
    // The tool appears while the brim type is painted: set it as the Brim type control does.
    await page.evaluate(() => {
      const st = (window as unknown as { __sx: Sx }).__sx
      st.setState({ overrides: { ...st.getState().overrides, brim_type: 'painted' } })
    })
    // Select the model, then open the tool: its panel takes the Objects card's place.
    await page.locator('.obj-name', { hasText: 'Layered X' }).click()
    const toolbar = page.getByRole('toolbar', { name: 'Plate tools' })
    await toolbar.getByRole('button', { name: 'Brim ears' }).click()
    const panel = page.locator('[data-section=brim-ears]')
    try {
      // The iso view, low enough that the model hides the ear behind it (the plate opens on a higher view of the whole plate).
      // The camera moves there over half a second of drawn frames, which a busy machine draws late, and the points below are
      // read from the camera: wait for the move to end instead of a fixed time.
      await page.keyboard.press('7')
      await expect.poll(() => page.evaluate(() => { const rig = (window as unknown as { __vp: BrimVp }).__vp.rig; return rig.preset === 'iso' && rig.move === null })).toBe(true)
      // Three ears: two on the side the camera sees and one behind the model, placed through the viewport's own event
      // (the same path as a click there).
      const id = (await state(page)).plate[0]!.id
      const spots: [number, number][] = [[170, 108], [176, 126], [90, 150]]
      for (const [x, y] of spots) await page.evaluate(([id, x, y]) => (window as unknown as { __vp: BrimVp }).__vp.emit('brimadd', { objectId: id, point: [x, y, 0] }), [id, x, y] as const)
      await expect(panel.getByTestId('brim-ear-count')).toHaveText(/3 ears/)

      // Shift and drag a rectangle over all three: the ear hidden behind the model is skipped, as in Orca.
      const pts = await Promise.all(spots.map(([x, y]) => screenOf(page, x, y, 0.1)))
      const left = Math.min(...pts.map((p) => p.x)) - 25
      const right = Math.max(...pts.map((p) => p.x)) + 25
      const top = Math.min(...pts.map((p) => p.y)) - 25
      const bottom = Math.max(...pts.map((p) => p.y)) + 25
      await pressable(page, { x: left, y: top })
      await page.keyboard.down('Shift')
      await page.mouse.move(left, top)
      await page.mouse.down()
      await page.mouse.move((left + right) / 2, (top + bottom) / 2, { steps: 4 })
      await page.mouse.move(right, bottom, { steps: 4 })
      await page.mouse.up()
      await page.keyboard.up('Shift')
      await expect(panel.getByTestId('brim-ear-count')).toHaveText(/2 selected/)
      // Alt and drag over one of them deselects it.
      const c = { x: pts[0]!.x, y: pts[0]!.y }
      await pressable(page, { x: c.x - 30, y: c.y - 30 })
      await page.keyboard.down('Alt')
      await page.mouse.move(c.x - 30, c.y - 30)
      await page.mouse.down()
      await page.mouse.move(c.x + 30, c.y + 30, { steps: 6 })
      await page.mouse.up()
      await page.keyboard.up('Alt')
      await expect(panel.getByTestId('brim-ear-count')).toHaveText(/1 selected/)

      // Dragging an ear moves it and the camera does not orbit.
      const before = (await ears(page)).find((e) => Math.abs(e.x - 176) < 0.5)!
      const camBefore = await camera(page)
      const from = await screenOf(page, before.x, before.y, 0.1)
      const to = await screenOf(page, before.x + 12, before.y - 12, 0.1)
      await pressable(page, from)
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 })
      await page.mouse.move(to.x, to.y, { steps: 4 })
      await page.mouse.up()
      await expect.poll(async () => {
        const moved = (await ears(page)).find((e) => e.i === before.i)!
        return Math.hypot(moved.x - before.x, moved.y - before.y)
      }, { timeout: 10_000 }).toBeGreaterThan(4)
      expect(await camera(page)).toEqual(camBefore)

      // Ctrl and the wheel change the head diameter by 0.1 mm a notch and do not zoom.
      const diameter = async () => Number(/Head diameter\s+(\d+(?:\.\d)?) mm/.exec(await panel.innerText())?.[1])
      const size0 = await diameter()
      const canvas = await page.locator('.vp-canvas').first().boundingBox()
      // Below the plate toolbar, on bare view.
      await page.mouse.move(canvas!.x + canvas!.width / 2, canvas!.y + 120)
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, -120)
      await page.keyboard.up('Control')
      await expect.poll(diameter).toBeCloseTo(size0 + 0.1, 5)
      expect(await camera(page)).toEqual(camBefore)
    } finally {
      // The next step does not start on a painted brim or with the tool open.
      await page.keyboard.up('Shift')
      await page.keyboard.up('Alt')
      await page.keyboard.up('Control')
      if (await panel.isVisible()) await toolbar.getByRole('button', { name: 'Brim ears' }).click()
      await page.evaluate(() => {
        const st = (window as unknown as { __sx: Sx }).__sx
        const { brim_type: _gone, ...rest } = st.getState().overrides
        st.setState({ overrides: rest })
      })
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// The CAD look
// ---------------------------------------------------------------------------------------------------------------------

/** Model draws its parts in the CAD look, a neutral gray with dark feature edges; Slice keeps the filament look. */
test.describe('Model CAD look', () => {
  type Part = { edges: { visible: boolean }; wide?: { visible: boolean }; mesh: { material: { color: { getHexString(): string } } } }
  type LookVp = { renderMode: string; objects: Map<string, { parts: Part[] }>; pipeline: { gradeMat: { uniforms: { silOn: { value: number } } } } }

  const look = (page: Page) =>
    page.evaluate(() => {
      const vp = (window as unknown as { __vp: LookVp }).__vp
      const parts = [...vp.objects.values()].flatMap((o) => o.parts)
      return { mode: vp.renderMode, silhouette: vp.pipeline.gradeMat.uniforms.silOn.value === 1, edges: parts.every((p) => p.edges.visible || p.wide?.visible === true), wide: parts.every((p) => p.wide?.visible === true), colors: [...new Set(parts.map((p) => p.mesh.material.color.getHexString()))] }
    })

  test('Model draws one gray with its edges, and Slice its filament colors', async ({ page }) => {
    test.slow()
    await sliceTab(page).click()
    await openModel(page, join(starters(), 'x-mark.sx3mf'))
    await designTab(page).click()
    await expect.poll(async () => (await look(page)).mode).toBe('cad')
    const model = await look(page)
    expect(model.edges).toBe(true)
    // drawn wide (1.5 px), not as 1 px GL lines, and outlined where the model meets what is behind it
    expect(model.wide).toBe(true)
    await expect.poll(async () => (await look(page)).silhouette).toBe(true)
    expect(model.colors).toHaveLength(1)
    await sliceTab(page).click()
    await expect.poll(async () => (await look(page)).mode).not.toBe('cad')
    expect((await look(page)).colors).not.toEqual(model.colors)
    expect((await look(page)).wide).toBe(false)
    await expect.poll(async () => (await look(page)).silhouette).toBe(false)
  })

  /** The studio the view draws with, read back from the view itself (the debug handle), so it is what is drawn with and not what the theme says. */
  type Studio = { backdrop: { top: string | null; vignetteOnModels: boolean }; plate: { borderGlow: number; border: string | null }; lighting: { environment: number } }
  const studio = (page: Page) => page.evaluate(() => (window as unknown as { __vp: { look(): Studio } }).__vp.look())

  // The only step where a scheme switch reaches the real 3D view: the unit test (packages/app/test/viewport-look.test.ts) cannot show what a real view draws with.
  test('the 3D view takes the dark or light studio look with the theme, with no reload', async ({ page }) => {
    const was = await state(page)
    try {
      await setState(page, { scheme: 'dark', themeFollowsSystem: false })
      await expect.poll(async () => (await studio(page)).backdrop.top).toBe('#2a2e3a')
      const dark = await studio(page)
      expect(dark.backdrop.vignetteOnModels).toBe(false)
      expect(dark.plate.border).toBeNull()
      expect(dark.plate.borderGlow).toBeLessThan(1)
      expect(dark.lighting.environment).toBeLessThan(1)

      await setState(page, { scheme: 'light', themeFollowsSystem: false })
      await expect.poll(async () => (await studio(page)).backdrop.top).toBe('#e3e6ea')
      expect((await studio(page)).plate.borderGlow).toBe(dark.plate.borderGlow)

      await setState(page, { scheme: 'dark', themeFollowsSystem: false })
      await expect.poll(async () => (await studio(page)).backdrop.top).toBe('#2a2e3a')
    } finally {
      await setState(page, { scheme: was.scheme, themeFollowsSystem: was.themeFollowsSystem })
    }
  })

  // SX_SHOTS=1 also saves the look at 1440 in light and dark on the x-mark and the shelf bracket.
  for (const scheme of ['light', 'dark'] as const) {
    test(`shots: the CAD look in ${scheme}`, async ({ page }, info) => {
      test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
      test.slow()
      const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
      const was = await state(page)
      await setState(page, { scheme, themeFollowsSystem: false })
      try {
        for (const file of ['x-mark.sx3mf', 'shelf-bracket.sx3mf']) {
          await sliceTab(page).click()
          await openModel(page, join(starters(), file))
          await designTab(page).click()
          await expect.poll(async () => (await look(page)).mode).toBe('cad')
          // Nothing selected, framed close, so the gray and its edges are what shows.
          await page.evaluate(() => {
            const w = window as unknown as { __sx: { setState(p: unknown): void }; __vp: { view(v: string, o?: unknown): void } }
            w.__sx.setState({ selection: null, selectedIds: [] })
            w.__vp.view('fit')
          })
          await page.waitForTimeout(1500)
          await page.screenshot({ path: join(dir, `${file.replace('.sx3mf', '')}-model-${scheme}.png`) })
          await sliceTab(page).click()
          await page.waitForTimeout(1500)
          await page.screenshot({ path: join(dir, `${file.replace('.sx3mf', '')}-slice-${scheme}.png`) })
        }
      } finally {
        await setState(page, { scheme: was.scheme, themeFollowsSystem: was.themeFollowsSystem })
      }
    })
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------------------------------------------------

/** Settings > Look and feel > Frame the view: Always frames each new pick in Model, On open and add leaves the camera where it is when the selection changes. */
test.describe('Model framing', () => {
  const pickObject = (page: Page, id: string) => setState(page, { selection: id, selectedIds: [id] })
  /** Whether the camera is in an eased move (a framing runs 520 ms, stepped only on drawn frames). */
  const easing = (page: Page) => page.evaluate(() => (window as unknown as { __vp: { rig?: { move: unknown } } }).__vp.rig?.move != null)
  /** The camera once it has stopped moving: no eased move left, and the same position on two reads in a row. */
  async function stopped(page: Page): Promise<number[]> {
    // a framing starts on the next frame, so give it time to begin before reading
    await page.waitForTimeout(300)
    let last: number[] = []
    await expect
      .poll(async () => {
        const now = (await camera(page)).map((v) => Math.round(v * 10) / 10)
        const still = !(await easing(page)) && now.join() === last.join()
        last = now
        return still
      }, { intervals: [250], timeout: 10_000 })
      .toBe(true)
    return last
  }

  test('Frame the view: Always frames each pick, On open and add keeps the camera still', async ({ page }) => {
    await modelReset(page)
    await designTab(page).click()
    await command(page, 'Add a box')
    await command(page, 'Add a box')
    await expect.poll(async () => (await state(page)).plate.length).toBe(2)
    const [a, b] = (await state(page)).plate.map((e) => e.id)
    expect((await state(page)).appearance['modelFraming']).toBe('selection')
    try {
      await pickObject(page, a!)
      const onA = await stopped(page)
      await pickObject(page, b!)
      const onB = await stopped(page)
      expect(onB).not.toEqual(onA)

      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Settings' })
      await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Look and feel' }).click()
      const row = dialog.getByTestId('set-model-framing')
      await expect(row).toContainText('each time it changes')
      await row.getByRole('radio', { name: 'On open and add' }).click()
      await expect(row).toContainText('Picking leaves the camera where it is')
      expect((await state(page)).appearance['modelFraming']).toBe('open')
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)

      await pickObject(page, a!)
      expect(await stopped(page)).toEqual(onB)
    } finally {
      // The setting is stored with the preferences: the next step finds the default.
      await page.evaluate(() => {
        const st = (window as unknown as { __sx: Sx }).__sx
        st.setState({ appearance: { ...st.getState().appearance, modelFraming: 'selection' } })
      })
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// The pick feel
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The Model feel's pick filter, on by default: Model starts on Face, a real click a few pixels from an edge picks the
 * edge and one well inside the face picks the face, Edge only and Body stay explicit modes, and the developer palette
 * command turns it off and on. Turned off, the filter starts on objects and the face wins, as before.
 */
test.describe('Model pick feel', () => {
  /** Developer mode for a step, with the feel switched by the palette command as a developer does; the step leaves both as it found them. */
  async function withDeveloper(page: Page, run: () => Promise<void>): Promise<void> {
    const before = (await page.evaluate(() => (window as unknown as { __sx: { getState(): { settingsMode: string } } }).__sx.getState().settingsMode))
    // The step before posted its own "feel" toasts; a toast of the same words would make the check below find two.
    await clearToasts(page)
    await setState(page, { settingsMode: 'developer' })
    try {
      await run()
    } finally {
      await page.evaluate(() => localStorage.removeItem('sx.modelFeel'))
      await setState(page, { settingsMode: before })
      await modelReset(page)
    }
  }

  test('starts on Face, and an edge within 6 px of the click wins over the face', async ({ page }) => {
    test.slow()
    const id = await framedBox(page)
    const box = await bounds(page, id)
    await expect(filter(page, 'face')).toHaveAttribute('aria-pressed', 'true')
    await expect(filter(page, 'object')).toHaveAttribute('aria-pressed', 'false')
    await expect(filter(page, 'face')).toHaveAttribute('aria-label', 'Face')
    await expect(filter(page, 'edge')).toHaveAttribute('aria-label', 'Edge only')
    await expect(filter(page, 'object')).toHaveAttribute('aria-label', 'Body')
    // Well inside the face: the face.
    const inside = await nearFrontEdge(page, box, 24)
    await page.mouse.click(inside.x, inside.y)
    await expect(readout(page)).toHaveText('1 face on Box')
    // Three pixels in from the edge: the edge wins.
    const near = await nearFrontEdge(page, box, 3)
    await page.mouse.click(near.x, near.y)
    await expect(readout(page)).toHaveText('1 edge on Box')
    expect(await subPicks(page)).toEqual(['edge'])
    // Ten pixels in: past the radius, the face again.
    const past = await nearFrontEdge(page, box, 10)
    await page.mouse.click(past.x, past.y)
    await expect(readout(page)).toHaveText('1 face on Box')
  })

  test('hover shows what a click would pick: the edge near it, else the face', async ({ page }) => {
    test.slow()
    const id = await framedBox(page)
    const box = await bounds(page, id)
    // The view's own hover state: the dashed edge lines and the lit face.
    const hover = () => page.evaluate(() => {
      const vp = (window as unknown as { __vp: { edgeMarks: { lines: { hover: unknown[] } }; faceKey: string } }).__vp
      return { edge: vp.edgeMarks.lines.hover.length > 0, face: vp.faceKey !== '' }
    })
    const near = await nearFrontEdge(page, box, 3)
    await page.mouse.move(near.x - 40, near.y - 40)
    await page.mouse.move(near.x, near.y, { steps: 4 })
    await expect.poll(hover).toEqual({ edge: true, face: false })
    const inside = await nearFrontEdge(page, box, 24)
    await page.mouse.move(inside.x, inside.y, { steps: 4 })
    await expect.poll(hover).toEqual({ edge: false, face: true })
  })

  test('Edge only and Body are explicit modes', async ({ page }) => {
    test.slow()
    const id = await framedBox(page)
    const box = await bounds(page, id)
    // Edge only: even a click well inside the face picks the edge nearest it.
    await filter(page, 'edge').click()
    const inside = await nearFrontEdge(page, box, 24)
    await page.mouse.click(inside.x, inside.y)
    await expect(readout(page)).toHaveText(/1 edge on Box/)
    // Body: a click near the edge selects the whole body, no face or edge.
    await filter(page, 'object').click()
    const near = await nearFrontEdge(page, box, 3)
    await page.mouse.click(near.x, near.y)
    await expect(readout(page)).toHaveText('Box')
    await expect.poll(async () => (await subPicks(page)).length).toBe(0)
  })

  test('the palette command turns it off and on; off, the filter is objects and labels are as before', async ({ page }) => {
    test.slow()
    await withDeveloper(page, async () => {
      await framedBox(page)
      await command(page, 'Developer: new Model feel')
      await expect(page.getByText('The new Model feel is off.')).toBeVisible()
      await expect(filter(page, 'object')).toHaveAttribute('aria-pressed', 'true')
      await expect(filter(page, 'object')).toHaveAttribute('aria-label', 'Objects')
      expect(await page.evaluate(() => localStorage.getItem('sx.modelFeel'))).toBe('0')
      await command(page, 'Developer: new Model feel')
      await expect(page.getByText('The new Model feel is on.')).toBeVisible()
      expect(await page.evaluate(() => localStorage.getItem('sx.modelFeel'))).toBeNull()
      await expect(filter(page, 'face')).toHaveAttribute('aria-pressed', 'true')
      await expect(filter(page, 'face')).toHaveAttribute('aria-label', 'Face')
    })
  })

  test('turned off, Faces lets the face win as before', async ({ page }) => {
    test.slow()
    await withDeveloper(page, async () => {
      const id = await framedBox(page)
      const box = await bounds(page, id)
      await command(page, 'Developer: new Model feel')
      await expect(page.getByText('The new Model feel is off.')).toBeVisible()
      await expect(filter(page, 'object')).toHaveAttribute('aria-pressed', 'true')
      await page.mouse.move(700, 450)
      await page.keyboard.press('Alt+2')
      const near = await nearFrontEdge(page, box, 3)
      await page.mouse.click(near.x, near.y)
      await expect(readout(page)).toHaveText('1 face on Box')
    })
  })

  // Review shots: before (the feel turned off, as 0.2.7 shipped) and after (the default), the pointer resting 3 px in from the box's front top
  // edge, in both themes, at the project's width. SX_SHOTS=1 only.
  for (const scheme of ['dark', 'light'] as const) {
    for (const feel of [false, true]) {
      test(`shots: ${feel ? 'after' : 'before'} in ${scheme}`, async ({ page }, info) => {
        test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
        test.slow()
        const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
        const was = await state(page)
        await withDeveloper(page, async () => {
          await setState(page, { scheme, themeFollowsSystem: false })
          const id = await framedBox(page)
          if (!feel) await command(page, 'Developer: new Model feel')
          const near = await nearFrontEdge(page, await bounds(page, id), 3)
          await page.mouse.move(near.x - 30, near.y - 30)
          await page.mouse.move(near.x, near.y, { steps: 4 })
          await page.waitForTimeout(1200)
          await page.screenshot({ path: `${dir}/pick-filter-${feel ? 'after' : 'before'}-1440-${scheme}.png` })
        })
        await setState(page, { scheme: was.scheme, themeFollowsSystem: was.themeFollowsSystem })
      })
    }
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// Click to select
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Model picks with real mouse clicks, not events sent to the view: a click on a face picks it with no tool open and with
 * Push and pull open, the pill names the face, the Push and pull panel agrees with the pill, and a tool opened with
 * the right pane shut opens the pane, so it hears its clicks and shows its controls. The step where a delayed edge
 * answer lands under a resting pointer is in nightly/model-click-select.spec.ts.
 */
test.describe('Model click to select', () => {
  /** The middle of the box's top face on screen. */
  async function topMiddle(page: Page, id: string): Promise<{ x: number; y: number }> {
    const b = await bounds(page, id)
    const [x, y] = await bedToScreen(page, [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]])
    return { x, y }
  }

  test('Model starts on Face, and a click on a face picks it', async ({ page }) => {
    test.slow()
    const id = await framedBox(page)
    await expect(filter(page, 'face')).toHaveAttribute('aria-pressed', 'true')
    await expect(filter(page, 'object')).toHaveAttribute('aria-pressed', 'false')
    const top = await topMiddle(page, id)
    await page.mouse.click(top.x, top.y)
    await expect(readout(page)).toHaveText('1 face on Box')
    expect(await subPicks(page)).toEqual(['face'])
    // The click picked; it did not move the box.
    const b = await bounds(page, id)
    const again = await bounds(page, id)
    expect(again).toEqual(b)
  })

  test('Body picks the whole body with a click', async ({ page }) => {
    test.slow()
    const id = await framedBox(page)
    await filter(page, 'object').click()
    const top = await topMiddle(page, id)
    await page.mouse.click(top.x, top.y)
    await expect(readout(page)).toHaveText('Box')
    expect(await subPicks(page)).toEqual([])
  })

  test('with Push and pull open, a click on a face picks it, and the pill and the panel agree', async ({ page }) => {
    test.slow()
    const id = await framedBox(page)
    await command(page, 'Push or pull a face')
    const panel = toolPanel(page)
    await expect(panel).toContainText('No face yet')
    // the new box is selected as a whole; no face yet
    await expect(readout(page)).toHaveText('Box')
    const top = await topMiddle(page, id)
    await page.mouse.click(top.x, top.y)
    await expect(panel).toContainText('A face is picked')
    await expect(readout(page)).toHaveText('1 face on Box')
  })

  test('select first: a face picked before Push and pull stays named while the panel uses it', async ({ page }) => {
    test.slow()
    const id = await framedBox(page)
    const top = await topMiddle(page, id)
    await page.mouse.click(top.x, top.y)
    await expect(readout(page)).toHaveText('1 face on Box')
    await command(page, 'Push or pull a face')
    const panel = toolPanel(page)
    await expect(panel).toContainText('A face is picked')
    await expect(readout(page)).toHaveText('1 face on Box')
    // Escape closes the tool and leaves the model alone; the face stays picked.
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(readout(page)).toHaveText('1 face on Box')
  })

  test('Push and pull with the right pane shut: the pane opens, a click picks the face, and Enter pulls it', async ({ page }) => {
    test.slow()
    const id = await framedBox(page)
    const pane = page.getByTestId('model-inspector')
    await shutRightPane(page)
    await expect(pane).toBeHidden()
    await command(page, 'Push or pull a face')
    const panel = toolPanel(page)
    await expect(panel).toContainText('No face yet')
    await expect(pane).toBeVisible()
    await settledView(page)
    const before = await bounds(page, id)
    const top = await topMiddle(page, id)
    await page.mouse.click(top.x, top.y)
    await expect(panel).toContainText('A face is picked')
    await expect(readout(page)).toHaveText('1 face on Box')
    await panel.locator('#push-dist').fill('5')
    await panel.locator('#push-dist').press('Enter')
    await expect.poll(async () => Math.round((await bounds(page, id)).max[2] - before.max[2]), { timeout: 30_000 }).toBe(5)
  })

  // Review shots: Push and pull opened with the right pane shut, then a click on the box's top face, in both themes at the
  // project's width. Before the fix the pane stays shut and the pill reads "Nothing selected"; after it the pane opens with
  // the tool and the pill names the face. SX_SHOTS=1 only.
  for (const scheme of ['dark', 'light'] as const) {
    test(`shots: push and pull with the pane shut in ${scheme}`, async ({ page }, info) => {
      test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
      test.slow()
      const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
      const was = await state(page)
      await setState(page, { scheme, themeFollowsSystem: false })
      const id = await framedBox(page)
      await shutRightPane(page)
      await command(page, 'Push or pull a face')
      await page.waitForTimeout(800)
      await settledView(page)
      const top = await topMiddle(page, id)
      await page.mouse.click(top.x, top.y)
      await page.mouse.move(top.x + 60, top.y + 60)
      await page.waitForTimeout(1500)
      await page.screenshot({ path: `${dir}/push-pane-shut-1440-${scheme}.png` })
      await setState(page, { scheme: was.scheme, themeFollowsSystem: was.themeFollowsSystem })
    })
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// Edge clicks
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Edge picks with real mouse clicks, not pick events sent to the view: a click on the middle of a box edge picks that
 * edge in Fillet, in Chamfer, with no tool on the default Face filter, and with Edge only. The pill names the edge and
 * the open tool's panel counts it.
 */
test.describe('Model edge click', () => {
  /** The middle of the box's front top edge on screen, where the top face meets the front face. */
  async function frontTopEdge(page: Page, id: string): Promise<{ x: number; y: number }> {
    const b = await bounds(page, id)
    const [x, y] = await bedToScreen(page, [(b.min[0] + b.max[0]) / 2, b.min[1], b.max[2]])
    return { x, y }
  }

  /**
   * The middle of the box's back top edge on screen, where the top face meets the back face the camera cannot see, moved
   * `px` pixels off the box (square to the edge, away from the top face): an outline edge, with nothing behind a click
   * just past it.
   */
  async function backTopEdge(page: Page, id: string, px: number): Promise<{ x: number; y: number }> {
    const b = await bounds(page, id)
    const a = await bedToScreen(page, [b.min[0], b.max[1], b.max[2]])
    const e = await bedToScreen(page, [b.max[0], b.max[1], b.max[2]])
    const c = await bedToScreen(page, [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]])
    const m = [(a[0] + e[0]) / 2, (a[1] + e[1]) / 2] as const
    const len = Math.hypot(e[0] - a[0], e[1] - a[1])
    let n = [-(e[1] - a[1]) / len, (e[0] - a[0]) / len]
    if (n[0]! * (c[0] - m[0]) + n[1]! * (c[1] - m[1]) > 0) n = [-n[0]!, -n[1]!]
    return { x: m[0] + n[0]! * px, y: m[1] + n[1]! * px }
  }

  /** Opens a Modify tool from the ribbon, as a person does. */
  async function ribbon(page: Page, testId: string, data?: string): Promise<void> {
    await page.getByTestId('ribbon-tab-solid').click()
    const button = data ? page.locator(`[data-testid="${testId}"][data-tool="${data}"]`) : page.getByTestId(testId)
    await button.first().click()
  }

  for (const shape of ['Fillet', 'Chamfer'] as const) {
    test(`${shape}: a click on a box edge picks it, and the panel and the pill agree`, async ({ page }) => {
      test.slow()
      const id = await framedBox(page)
      if (shape === 'Fillet') await ribbon(page, 'model-shelf-tool', 'fillet')
      else await ribbon(page, 'ribbon-chamfer')
      const panel = toolPanel(page)
      await expect(panel).toContainText('No edge yet')
      await expect(panel.getByRole('radio', { name: shape })).toBeChecked()
      await settledView(page)
      const at = await frontTopEdge(page, id)
      await page.mouse.move(at.x, at.y - 40)
      await page.mouse.move(at.x, at.y, { steps: 4 })
      await page.mouse.click(at.x, at.y)
      await expect(panel).toContainText('1 edge')
      await expect(panel).not.toContainText('No edge yet')
      await expect(readout(page)).toHaveText('1 edge on Box')
      // A second click on the same edge with Shift takes it out again; the pill follows.
      await page.keyboard.down('Shift')
      await page.mouse.click(at.x, at.y)
      await page.keyboard.up('Shift')
      await expect(panel).toContainText('No edge yet')
      await expect(readout(page)).toHaveText('Box')
    })
  }

  test('Fillet with the right pane shut: the pane opens and a click on an edge picks it', async ({ page }) => {
    test.slow()
    const id = await framedBox(page)
    await shutRightPane(page)
    await expect(page.getByTestId('model-inspector')).toBeHidden()
    await command(page, 'Fillet or chamfer edges')
    const panel = toolPanel(page)
    await expect(panel).toContainText('No edge yet')
    await settledView(page)
    const at = await frontTopEdge(page, id)
    await page.mouse.click(at.x, at.y)
    await expect(panel).toContainText('1 edge')
    await expect(readout(page)).toHaveText('1 edge on Box')
  })

  for (const px of [0, 3]) {
    test(`Fillet: a click ${px ? `${px} px outside` : 'on'} an outline edge picks it`, async ({ page }) => {
      test.slow()
      const id = await framedBox(page)
      await ribbon(page, 'model-shelf-tool', 'fillet')
      const panel = toolPanel(page)
      await expect(panel).toContainText('No edge yet')
      await settledView(page)
      const at = await backTopEdge(page, id, px)
      await page.mouse.click(at.x, at.y)
      await expect(panel).toContainText('1 edge')
      await expect(readout(page)).toHaveText('1 edge on Box')
    })

    test(`no tool, Face: a click ${px ? `${px} px outside` : 'on'} an outline edge picks the edge`, async ({ page }) => {
      test.slow()
      const id = await framedBox(page)
      const at = await backTopEdge(page, id, px)
      await page.mouse.click(at.x, at.y)
      await expect(readout(page)).toHaveText('1 edge on Box')
      expect(await subPicks(page)).toEqual(['edge'])
    })
  }

  test('no tool, Face: a click on an edge picks the edge', async ({ page }) => {
    test.slow()
    const id = await framedBox(page)
    await expect(filter(page, 'face')).toHaveAttribute('aria-pressed', 'true')
    const at = await frontTopEdge(page, id)
    await page.mouse.click(at.x, at.y)
    await expect(readout(page)).toHaveText('1 edge on Box')
    expect(await subPicks(page)).toEqual(['edge'])
  })

  test('no tool, Edge only: a click on an edge picks the edge, and Fillet opens on it', async ({ page }) => {
    test.slow()
    const id = await framedBox(page)
    await filter(page, 'edge').click()
    await expect(filter(page, 'edge')).toHaveAttribute('aria-pressed', 'true')
    const at = await frontTopEdge(page, id)
    await page.mouse.click(at.x, at.y)
    await expect(readout(page)).toHaveText('1 edge on Box')
    expect(await subPicks(page)).toEqual(['edge'])
    // Select first: Fillet takes the picked edge, and the pill still names it.
    await ribbon(page, 'model-shelf-tool', 'fillet')
    const panel = toolPanel(page)
    await expect(panel).toContainText('1 edge')
    await expect(readout(page)).toHaveText('1 edge on Box')
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// The ring menu
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Model's ring menu in the 3D view: a right click opens it at the pointer for what is under it, a part, a face, an
 * edge or empty space; the menu key opens it for what is picked; a touch held still opens it too. Arrows go round,
 * Enter runs, Escape closes, the middle opens the full list (Delete is only there), and nothing around it moves.
 */
test.describe('Model ring menu', () => {
  type Hit = { objectId: string | null; partIndex: number | null; triangle: number | null; point: [number, number, number] | null }

  /** The view's menu event, as a right click on that spot sends it. */
  async function contextAt(page: Page, hit: Hit, screen: [number, number] = [640, 400]): Promise<void> {
    await page.evaluate(({ hit, screen }) => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('contextpick', { ...hit, screen }), { hit, screen })
  }

  const ring = (page: Page) => page.getByTestId('model-ring')
  const slots = (page: Page) => ring(page).locator('.sx-ring-slot').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))

  test('a part, a face, an edge and empty space each get their ring', async ({ page }) => {
    await modelReset(page)
    const id = await freshBox(page)
    await designTab(page).click()
    await expect(page.getByTestId('model-shelf')).toBeVisible()
    const shelfBefore = await page.getByTestId('model-shelf').boundingBox()
    // Model starts on Face; Body picks whole objects
    await page.mouse.move(700, 450)
    await page.keyboard.press('Alt+1')

    // a part: the object is selected and its ring opens at the pointer
    const top = await facePick(page, id, [0, 0, 1])
    await contextAt(page, top, [700, 380])
    await expect(ring(page)).toHaveAttribute('data-target', 'object')
    expect(await slots(page)).toEqual(['model-ring-cut', 'model-ring-array', 'model-ring-duplicate', 'model-ring-drop', 'model-ring-rename', 'model-ring-lock'])
    const box = (await ring(page).boundingBox())!
    expect(Math.abs(box.x + box.width / 2 - 700)).toBeLessThan(2)
    expect(Math.abs(box.y + box.height / 2 - 380)).toBeLessThan(2)
    // nothing around it moved
    expect(await page.getByTestId('model-shelf').boundingBox()).toEqual(shelfBefore)
    // keys: the first verb has focus, the arrows go round, Escape closes
    await expect(page.getByTestId('model-ring-cut')).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('model-ring-array')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(ring(page)).toHaveCount(0)

    // More: the full list, with Delete there and nowhere on the ring
    await contextAt(page, top)
    await expect(page.getByTestId('danger-model-ring-delete')).toHaveCount(0)
    await page.getByTestId('model-ring-more').click()
    await expect(page.getByTestId('model-ring-list')).toBeVisible()
    await expect(page.getByTestId('danger-model-ring-delete')).toBeVisible()
    await page.keyboard.press('Escape')

    // a face: with Faces in the pick filter, the right click picks the face and opens the face ring
    await page.keyboard.press('Alt+2')
    await contextAt(page, top)
    await expect(ring(page)).toHaveAttribute('data-target', 'face')
    expect(await slots(page)).toEqual(['model-ring-push', 'model-ring-sketch', 'model-ring-shell', 'model-ring-lay', 'model-ring-text', 'model-ring-measure'])
    // the picked face shows as an outline over a light fill, not a solid one
    await page.keyboard.press('Escape')
    await expect(ring(page)).toHaveCount(0)
    await contextAt(page, top)
    expect(await subPicks(page)).toEqual(['face'])
    // a click runs the verb: Push and pull opens with the face
    await page.getByTestId('model-ring-push').click()
    await expect(ring(page)).toHaveCount(0)
    await expect(page.locator('[data-section="cad-tool"]')).toContainText('Push')
    await page.getByTestId('model-tool-cancel').click()
    await expect.poll(async () => (await state(page)).objectTool).toBeNull()

    // an edge
    await page.keyboard.press('Alt+3')
    await contextAt(page, top)
    await expect(ring(page)).toHaveAttribute('data-target', 'edge')
    expect(await slots(page)).toEqual(['model-ring-fillet', 'model-ring-chamfer', 'model-ring-measure'])
    await page.keyboard.press('Escape')
    await expect(ring(page)).toHaveCount(0)

    // empty space
    await page.keyboard.press('Alt+1')
    await contextAt(page, { objectId: null, partIndex: null, triangle: null, point: null })
    await expect(ring(page)).toHaveAttribute('data-target', 'empty')
    expect(await slots(page)).toEqual(['model-ring-shape', 'model-ring-model', 'model-ring-arrange', 'model-ring-fit', 'model-ring-all', 'model-ring-paste'])
    // Add shape opens the list with the shapes
    await page.getByTestId('model-ring-shape').click()
    await expect(page.getByTestId('model-ring-list-shape-box')).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('a real right click on the model, the menu key, and a touch held still', async ({ page }) => {
    await modelReset(page)
    await freshBox(page)
    await designTab(page).click()
    const canvas = page.locator('canvas.vp-canvas').first()
    await expect(canvas).toBeVisible()
    const c = (await canvas.boundingBox())!
    // a touch held still for half a second, as the touch screen sends it
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    const point = { x: c.x + c.width / 2, y: c.y + c.height / 2 }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
    await page.waitForTimeout(700)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await cdp.detach()
    // on the box it opens Select Other, whose More actions is the ring
    await expect(page.getByTestId('select-other')).toBeVisible()
    await page.getByTestId('select-other-more').click()
    await expect(ring(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(ring(page)).toHaveCount(0)
    // right click in the middle of the view, where the box is
    await pressable(page, { x: c.x + c.width / 2, y: c.y + c.height / 2 })
    await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2, { button: 'right' })
    await expect(ring(page)).toBeVisible()
    await page.keyboard.press('Escape')
    // the menu key with the view focused: the ring for what is selected, in the middle of the view
    await canvas.focus()
    await page.keyboard.press('Shift+F10')
    await expect(ring(page)).toBeVisible()
    await page.keyboard.press('Escape')
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// The pick filter keys
// ---------------------------------------------------------------------------------------------------------------------

/** Model's pick filter: Alt+2 picks faces and Alt+3 edges, the pill says what is picked, Esc clears it, and a tool opened next starts from the pick (select, then the tool). */
test.describe('Model pick filter', () => {
  test('faces: pick, add with Shift, clear with Esc, and Push starts from the face', async ({ page }) => {
    await modelReset(page)
    const id = await freshBox(page)
    await designTab(page).click()
    await page.mouse.move(700, 450)
    await page.keyboard.press('Alt+2')
    await expect(filter(page, 'face')).toHaveAttribute('aria-pressed', 'true')
    await expect(filter(page, 'object')).toHaveAttribute('aria-pressed', 'false')
    await pick(page, await facePick(page, id, [0, 0, 1]))
    await expect(readout(page)).toHaveText('1 face on Box')
    await pick(page, { ...(await facePick(page, id, [1, 0, 0])), shift: true })
    await expect(readout(page)).toHaveText('2 faces on Box')
    await page.keyboard.press('Escape')
    await expect(readout(page)).toHaveText('Box')
    // Select, then the tool: Push and pull opens with the face already picked.
    await pick(page, await facePick(page, id, [0, 0, 1]))
    await expect(readout(page)).toHaveText('1 face on Box')
    await command(page, 'Push or pull a face')
    await expect(toolPanel(page)).toContainText('A face is picked')
    // the pill keeps naming the face the tool works on
    await expect(readout(page)).toHaveText('1 face on Box')
  })

  test('edges: Alt+3 picks the edge next to the click, and Fillet starts from it', async ({ page }) => {
    test.slow()
    await modelReset(page)
    // The Position fields are Slice's.
    await sliceTab(page).click()
    const id = await freshBox(page)
    await placeAt(page, 100, 100)
    const b = await bounds(page, id)
    await designTab(page).click()
    await page.mouse.move(700, 450)
    await page.keyboard.press('Alt+3')
    await pick(page, await facePick(page, id, [0, 0, 1], [b.max[0] - 0.3, (b.min[1] + b.max[1]) / 2, b.max[2]] as V3))
    await expect(readout(page)).toHaveText('1 edge on Box')
    await command(page, 'Fillet or chamfer edges')
    await expect(toolPanel(page)).toContainText('1 edge')
  })

  test('made by: one face names the step that made it, the name selects the object, and the crumb opens the step', async ({ page }) => {
    test.slow()
    await modelReset(page)
    const id = await freshBox(page)
    await designTab(page).click()
    const made = page.getByTestId('model-select-made-by')
    // A box no step has changed: its faces are the ones it started with.
    await page.mouse.move(700, 450)
    await page.keyboard.press('Alt+2')
    await pick(page, await facePick(page, id, [0, 0, 1]))
    await expect(readout(page)).toHaveText('1 face on Box')
    await expect(made).toHaveText('from the original mesh')
    // The name selects the object alone.
    await page.getByTestId('model-select-object').click()
    await expect(readout(page)).toHaveText('Box')
    await expect(made).toHaveCount(0)
    // The top a pull moved was made by the pull, and the tree marks that step.
    await page.keyboard.press('Alt+1')
    await pushTop(page, id, 5)
    await page.keyboard.press('Escape')
    await page.mouse.move(700, 450)
    await page.keyboard.press('Alt+2')
    await pick(page, await facePick(page, id, [0, 0, 1]))
    await expect(made).toHaveText('made by Pull 5 mm')
    await expect(page.locator('[data-testid="model-tree-step"][data-made-by]')).toHaveAttribute('data-index', '0')
    // The step's menu picks every face it made.
    await page.keyboard.press('Escape')
    await page.locator('[data-testid="model-tree-step"][data-index="0"]').click({ button: 'right', position: { x: 60, y: 10 } })
    await page.getByTestId('model-ctx-faces').click()
    await expect(readout(page)).toContainText(/faces? on Box/)
    await page.keyboard.press('Escape')
    await pick(page, await facePick(page, id, [0, 0, 1]))
    await expect(made).toHaveText('made by Pull 5 mm')
    // Two faces have no one maker to name.
    await pick(page, { ...(await facePick(page, id, [1, 0, 0])), shift: true })
    await expect(made).toHaveCount(0)
    await pick(page, await facePick(page, id, [0, 0, 1]))
    await made.click()
    await expect(toolPanel(page)).toBeVisible()
    await expect(page.locator('[data-testid="model-tree-step"][data-index="0"]')).toHaveAttribute('data-editing', 'true')
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Select Other
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Model's Select Other with a real mouse: holding the pointer still on a spot for half a second opens a list of
 * everything under it (what a click picks first, then the faces front to back, then the bodies), a row under the
 * pointer shows what it picks and choosing it picks it; the list takes arrow keys and Enter, Alt+S opens it at the
 * pointer and Escape closes it, giving focus back to the view; a plain click on the same spot again steps to the next
 * thing under it and around. Two boxes, one behind the other, put several things under one spot. The finger on a phone
 * is in phone-model.spec.ts.
 */
test.describe('Select Other with a mouse and keys', () => {
  const list = (page: Page) => page.getByTestId('select-other')
  const rows = (page: Page) => page.getByTestId('select-other-row')

  async function setup(page: Page) {
    await modelReset(page)
    await freshBox(page)
    const { front, back } = await twoBoxes(page, () => command(page, 'Add a box'))
    const ids = { front, back }
    // the front box picked already: Model frames the view on a new pick, and the spot must stay put
    await setState(page, { selection: ids.front, selectedIds: [ids.front] })
    await designTab(page).click()
    await expect(filter(page, 'face')).toHaveAttribute('aria-pressed', 'true')
    await fitView(page, [ids.front, ids.back])
    return { ...ids, spot: await stackedSpot(page, ids.front, ids.back) }
  }

  test('holding the pointer still opens the list of everything under it, front to back; a row picks it', async ({ page }) => {
    test.slow()
    const { back, spot } = await setup(page)
    await page.mouse.move(spot.x, spot.y)
    await page.mouse.down()
    await page.waitForTimeout(800)
    await expect(list(page)).toBeVisible()
    // the top face, the back box's face behind it, then both bodies
    await expect.poll(async () => (await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))).join(',')).toBe('face,face,body,body')
    await expect(rows(page).first()).toHaveAccessibleName(/^Top face on /)
    await page.mouse.up()
    // the press was a hold, not a click: the list stays and nothing is picked
    await expect(list(page)).toBeVisible()
    expect((await state(page)).subPicks).toEqual([])
    // a row under the pointer shows what it would pick in the view
    await rows(page).nth(1).hover()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __vp: { pickedFaces: unknown[] } }).__vp.pickedFaces.length)).toBeGreaterThan(0)
    await rows(page).nth(3).click()
    await expect(list(page)).toBeHidden()
    const s = await state(page)
    expect(s.selectedIds).toEqual([back])
    expect(s.subPicks).toEqual([])
    await expect(readout(page)).toHaveText(s.plate.find((p) => p.id === back)!.name)
  })

  test('the list takes arrow keys and Enter; Alt+S opens it at the pointer and Escape closes it, focus back in the view', async ({ page }) => {
    test.slow()
    const { back, spot } = await setup(page)
    await page.mouse.move(spot.x - 30, spot.y - 30)
    await page.mouse.move(spot.x, spot.y, { steps: 4 })
    await page.locator('canvas.vp-canvas').focus()
    await page.keyboard.press('Alt+S')
    await expect(list(page)).toBeVisible()
    await expect(rows(page).first()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(rows(page).nth(1)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(list(page)).toBeHidden()
    await expect.poll(async () => (await state(page)).subPicks.map((p) => `${p.kind} ${p.objectId}`)).toEqual([`face ${back}`])
    await expect(readout(page)).toHaveText(/^1 face on /)
    // Escape closes it, picks nothing and gives focus back to the view
    await page.keyboard.press('Alt+S')
    await expect(list(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(list(page)).toBeHidden()
    await expect(page.locator('canvas.vp-canvas')).toBeFocused()
    expect((await state(page)).subPicks.map((p) => `${p.kind} ${p.objectId}`)).toEqual([`face ${back}`])
  })

  test('clicking the same spot again steps to the next thing under it, and around', async ({ page }) => {
    test.slow()
    const { front, back, spot } = await setup(page)
    const tag = page.getByTestId('select-other-tag')
    const names = Object.fromEntries((await state(page)).plate.map((p) => [p.id, p.name]))
    await page.mouse.click(spot.x, spot.y)
    await expect(tag).toContainText('1 of 4')
    await expect(readout(page)).toHaveText(`1 face on ${names[front]}`)
    const want = [
      ['2 of 4', `1 face on ${names[back]}`],
      ['3 of 4', names[front]!],
      ['4 of 4', names[back]!],
      ['1 of 4', `1 face on ${names[front]}`],
    ]
    for (const [n, words] of want) {
      // slower than a double click
      await page.waitForTimeout(400)
      await page.mouse.click(spot.x, spot.y)
      await expect(tag).toContainText(n!)
      await expect(readout(page)).toHaveText(words!)
    }
    // a click elsewhere starts over, and the tag goes when the pointer moves away
    await page.mouse.move(spot.x + 200, spot.y + 200, { steps: 4 })
    await expect(tag).toBeHidden()
  })
})
