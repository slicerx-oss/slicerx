// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Helpers for specs that press or drag on the 3D view: where a bed point is on screen, and a wait until a press at a
// screen point reaches the canvas. Something drawn over the point (a panel, the layer strip) takes the press, and
// nothing moves. A toast does not: toasts let presses through (styles.css).
import { expect, type Page } from '@playwright/test'

interface Projector {
  camera: { position: { clone(): { set(x: number, y: number, z: number): { applyMatrix4(m: unknown): { project(c: unknown): { x: number; y: number } } } } } }
  stage: { bedRoot: { matrixWorld: unknown } }
  canvas: HTMLCanvasElement
}
type Slicing = { getState(): { slice: { status: string; stale?: boolean } } }

/** Where a bed point (mm) is on screen, in page pixels. */
export const screenOf = (page: Page, x: number, y: number, z = 0) =>
  page.evaluate(([x, y, z]) => {
    const vp = (window as unknown as { __vp: Projector }).__vp
    const v = vp.camera.position.clone().set(x as number, y as number, z as number).applyMatrix4(vp.stage.bedRoot.matrixWorld).project(vp.camera)
    const r = vp.canvas.getBoundingClientRect()
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }
  }, [x, y, z] as const)

/** Whether the canvas is the topmost element at a screen point. */
export const onCanvas = (page: Page, x: number, y: number) =>
  page.evaluate(([x, y]) => document.elementFromPoint(x!, y!) === document.querySelector('.vp-canvas'), [x, y] as const)

/** Waits until a press at the point reaches the canvas. Returns the point. */
export async function pressable<T extends { x: number; y: number }>(page: Page, at: T): Promise<T> {
  await expect.poll(() => onCanvas(page, at.x, at.y), { message: `something covers the spot to press (${Math.round(at.x)}, ${Math.round(at.y)})` }).toBe(true)
  return at
}

/** The middle of the canvas, once a press there reaches it. */
export async function canvasCenter(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('.vp-canvas').first().boundingBox()
  if (!box) throw new Error('no canvas')
  return pressable(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
}

/**
 * Where a bed point is on screen once the view has settled for a press. A plate change slices on its own; when that
 * slice lands, the toolpath look's legend, layer strip and playback bar come up over the view and the camera frames
 * the plate again in the space they leave, so a press aimed before then lands somewhere else and turns the view. This
 * waits for the slice to be current, then for the same spot twice, further apart than the view's second look at its
 * overlays (600 ms), then for the canvas to be what is on that spot.
 */
export async function aim(page: Page, x: number, y: number, z: number): Promise<{ x: number; y: number }> {
  const sliced = () => page.evaluate(() => { const s = (window as unknown as { __sx: Slicing }).__sx.getState().slice; return s.status === 'done' && !s.stale })
  await expect.poll(sliced, { timeout: 60_000 }).toBe(true)
  return pressable(page, await steady(page, x, y, z))
}

/**
 * Where a bed point is on screen once the camera has stopped: the same spot twice, further apart than the view's
 * second look at its overlays (600 ms). A camera move the view eases (zoom to the selection, a view preset) takes as
 * long as the page needs to draw it, which on a slow renderer is far longer than its nominal time. Wait on a point away
 * from where the camera eases to: a zoom toward a point keeps that point still on screen while the camera moves.
 */
export async function steady(page: Page, x: number, y: number, z: number): Promise<{ x: number; y: number }> {
  let at = await screenOf(page, x, y, z)
  let since = Date.now()
  await expect
    .poll(async () => {
      const again = await screenOf(page, x, y, z)
      // The poll asks once right away, and two looks inside one frame always agree, so a look counts only once the
      // one before it is far enough back.
      if (Date.now() - since < 600) return false
      const still = Math.hypot(again.x - at.x, again.y - at.y) < 0.5
      at = again
      since = Date.now()
      return still
    }, { intervals: [700] })
    .toBe(true)
  return at
}
