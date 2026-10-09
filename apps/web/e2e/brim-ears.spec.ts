// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Brim ears in the viewport: rectangle select (hidden ears skipped), ear drag and Ctrl+wheel head size.
import { type Page } from '@playwright/test'
import { expect, plateReady, test } from './fixtures'

interface Vp {
  camera: { position: { clone(): { set(x: number, y: number, z: number): { applyMatrix4(m: unknown): { project(c: unknown): { x: number; y: number } } } } } }
  stage: { bedRoot: { matrixWorld: unknown } }
  canvas: HTMLCanvasElement
  brim: { forEachEar(cb: (id: string, i: number, e: { x: number; y: number; z: number }) => void): void }
  emit(e: string, p: unknown): void
}

async function open(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', cadTools: true }))
  })
  await page.goto('./')
  await plateReady(page)
  // The tool appears while the brim type is painted: set it as the Brim type control does.
  await page.evaluate(() => {
    const st = (window as unknown as { __sx: { getState(): { overrides: Record<string, unknown> }; setState(p: unknown): void } }).__sx
    st.setState({ overrides: { ...st.getState().overrides, brim_type: 'painted' } })
  })
  // Select the model, then open the tool: its panel takes the Objects card's place.
  await page.locator('.obj-name', { hasText: 'Layered X' }).click()
  await page.getByRole('toolbar', { name: 'Plate tools' }).getByRole('button', { name: 'Brim ears' }).click()
}

/** Ears the viewport draws, in bed coordinates. */
const ears = (page: Page) =>
  page.evaluate(() => {
    const out: { i: number; x: number; y: number }[] = []
    ;(window as unknown as { __vp: Vp }).__vp.brim.forEachEar((_id, i, e) => out.push({ i, x: e.x, y: e.y }))
    return out
  })

/** Camera position to 3 decimals, so float jitter from damping does not count as a move. */
const camera = (page: Page) =>
  page.evaluate(() => {
    const p = (window as unknown as { __vp: { camera: { position: { x: number; y: number; z: number } } } }).__vp.camera.position
    return [p.x, p.y, p.z].map((n) => Math.round(n * 1000) / 1000)
  })

/** Client coordinates of a bed point. */
const screen = (page: Page, x: number, y: number, z = 0.1) =>
  page.evaluate(([x, y, z]) => {
    const vp = (window as unknown as { __vp: Vp }).__vp
    const v = vp.camera.position.clone().set(x as number, y as number, z as number).applyMatrix4(vp.stage.bedRoot.matrixWorld).project(vp.camera)
    const r = vp.canvas.getBoundingClientRect()
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height }
  }, [x, y, z])

test('rectangle select, ear drag and Ctrl+wheel work on the plate', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Needs a pointer and keyboard')
  test.slow()
  await open(page)
  // The viewport adds its handle once it starts, which on a busy machine can come after the plate's ready mark.
  await page.waitForFunction(() => 'rig' in ((window as unknown as { __vp?: object }).__vp ?? {}), undefined, { timeout: 60_000 })
  // The iso view, low enough that the model hides the ear behind it (the plate opens on a higher view of the whole plate).
  // The camera moves there over half a second of drawn frames, which a busy machine draws late, and the points below are
  // read from the camera: wait for the move to end instead of a fixed time.
  await page.keyboard.press('7')
  await expect
    .poll(() =>
      page.evaluate(() => {
        const rig = (window as unknown as { __vp: { rig: { preset: string | null; move: unknown } } }).__vp.rig
        return rig.preset === 'iso' && rig.move === null
      }),
    )
    .toBe(true)
  const panel = page.locator('[data-section=brim-ears]')
  // Three ears: two on the side the camera sees and one behind the model, placed through the viewport's own event
  // (the same path as a click there).
  const id = await page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: { id: string }[] } } }).__sx.getState().plate[0]!.id)
  const spots: [number, number][] = [[170, 108], [176, 126], [90, 150]]
  for (const [x, y] of spots) await page.evaluate(([id, x, y]) => (window as unknown as { __vp: Vp }).__vp.emit('brimadd', { objectId: id, point: [x, y, 0] }), [id, x, y] as const)
  await expect(panel.getByTestId('brim-ear-count')).toHaveText(/3 ears/)

  // Shift and drag a rectangle over all three: the ear hidden behind the model is skipped, as in Orca.
  const pts = await Promise.all(spots.map(([x, y]) => screen(page, x, y)))
  const left = Math.min(...pts.map((p) => p.x)) - 25
  const right = Math.max(...pts.map((p) => p.x)) + 25
  const top = Math.min(...pts.map((p) => p.y)) - 25
  const bottom = Math.max(...pts.map((p) => p.y)) + 25
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
  const from = await screen(page, before.x, before.y)
  const to = await screen(page, before.x + 12, before.y - 12)
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
  await page.mouse.move(canvas!.x + canvas!.width / 2, canvas!.y + 40)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -120)
  await page.keyboard.up('Control')
  await expect.poll(diameter).toBeCloseTo(size0 + 0.1, 5)
  expect(await camera(page)).toEqual(camBefore)
})
