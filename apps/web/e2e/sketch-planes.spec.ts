// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Sketching starts on an origin plane like it does in Fusion: the planes show at the origin, and picking one turns
// the camera square on to it.
import { type Page } from '@playwright/test'
import { command, openStudio, pick, toolPanel } from './cad-helpers'
import { expect, test } from './fixtures'

/** The way the camera looks, in bed coordinates (Z up). */
const looking = (page: Page) =>
  page.evaluate(() => {
    type M = { clone(): M; invert(): M }
    type V = { x: number; y: number; z: number; transformDirection(m: M): V }
    const vp = (window as unknown as { __vp: { camera: { position: { constructor: new () => V }; getWorldDirection(v: V): V }; stage: { bedRoot: { matrixWorld: M } } } }).__vp
    const d = vp.camera.getWorldDirection(new vp.camera.position.constructor()).transformDirection(vp.stage.bedRoot.matrixWorld.clone().invert())
    return [d.x, d.y, d.z].map((v) => Math.round(v * 100) / 100 + 0)
  })

test('the XZ origin plane takes a sketch, with the camera square on to it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await openStudio(page)
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('Click an origin plane (XY, XZ or YZ)')
  await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, originPlane: 'xz' })
  await expect(panel).toContainText('The XZ plane')
  // XZ faces the front (-Y), so the camera looks back along +Y
  await expect.poll(() => looking(page), { timeout: 5000 }).toEqual([0, 1, 0])
  await expect(panel.getByRole('radiogroup', { name: 'Drawing tool' })).toBeVisible()
})

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

test('the plane names follow their corners when the camera turns and zooms', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await openStudio(page)
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
