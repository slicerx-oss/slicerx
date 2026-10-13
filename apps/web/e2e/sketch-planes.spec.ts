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
