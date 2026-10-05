// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The drawn prime tower is hit by the viewport's ray, and the inline settings plan renders.
import { type Page } from '@playwright/test'
import { expect, plateReady, tab, test, viewportReady } from './fixtures'

interface Vp {
  camera: { position: { clone(): { set(x: number, y: number, z: number): { applyMatrix4(m: unknown): { project(c: unknown): { x: number; y: number } } } } } }
  stage: { bedRoot: { matrixWorld: unknown } }
  canvas: HTMLCanvasElement
}
type Sx = { getState(): { tower: { auto: boolean; x: number; y: number }; towerSelected: boolean; slice: { status: string; result?: { primeTower?: { x: number; y: number; width: number; depth: number } } } } }

const screen = (page: Page, x: number, y: number, z = 0.1) =>
  page.evaluate(([x, y, z]) => {
    const vp = (window as unknown as { __vp: Vp }).__vp
    const v = vp.camera.position.clone().set(x as number, y as number, z as number).applyMatrix4(vp.stage.bedRoot.matrixWorld).project(vp.camera)
    const r = vp.canvas.getBoundingClientRect()
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }
  }, [x, y, z] as const)

test('the viewport ray hits the prime tower, and the settings plan renders', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Needs a pointer')
  test.slow()
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  await viewportReady(page)
  await page.getByRole('button', { name: 'Change', exact: true }).click()
  await page.getByRole('list', { name: 'Choose a printer' }).getByRole('button', { name: /Bay 2/ }).click()
  await page.getByRole('button', { name: /^Slice/ }).first().click()
  await expect(page.locator('.sx-tab[aria-current=page]')).toContainText('Preview', { timeout: 120_000 })
  await tab(page, 'prepare').click()
  const state = () => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())
  const t = (await state()).slice.result!.primeTower!
  // Find a screen point the viewport's own ray hits the tower at, from the middle of the drawn tower, high up on the box.
  const findSpot = async () => {
    const at = await screen(page, t.x + t.width / 2, t.y + t.depth / 2, 5)
    return page.evaluate(([cx, cy]) => {
      const vp = (window as unknown as { __vp: { pickFn(e: { clientX: number; clientY: number }): { entry: { id: string } } | null } }).__vp
      const got: { x: number; y: number }[] = []
      for (let dx = -300; dx <= 300; dx += 4) for (let dy = -300; dy <= 300; dy += 4) if (vp.pickFn({ clientX: (cx as number) + dx, clientY: (cy as number) + dy })?.entry.id === 'prime-tower') got.push({ x: (cx as number) + dx, y: (cy as number) + dy })
      const mean = (k: 'x' | 'y') => got.reduce((n, p) => n + p[k], 0) / Math.max(1, got.length)
      return { n: got.length, x: mean('x'), y: mean('y') }
    }, [at.x, at.y] as const)
  }
  // The 3D view takes a moment to show the plate again after the tab change; poll until the ray reaches the tower.
  await expect.poll(async () => (await findSpot()).n, { timeout: 60_000 }).toBeGreaterThan(20)
  const spot = await findSpot()
  // The viewport's own ray reaches the tower, so the move gizmo can take it. (A real mouse click does not register on the canvas under the
  // headless software renderer, even on the model before any slice, so the move itself is covered by tower.spec.ts through the viewport's events.)
  await page.screenshot({ path: info.outputPath('tower-in-view.png') })
  // The inline settings plan: a nozzle too small for an abrasive filament is a blocker. Set one filament to a CF material.
  await page.evaluate(() => {
    const st = (window as unknown as { __sx: { setState(p: unknown): void } }).__sx
    st.setState({ slotSetup: { 1: { type: 'PA-CF', brand: '', color: '#222222' } } })
  })
  await expect(page.getByRole('status', { name: 'Setup notes' })).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: info.outputPath('setup-notes.png') })
})
