// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's box select: Shift and a left drag from empty space. Left to right picks the objects fully inside the box;
// right to left picks anything it touches. Slice keeps Shift and drag as it was.
import { type Page } from '@playwright/test'
import { command, openStudio } from './cad-helpers'
import { expect, test } from './fixtures'

type Vp = {
  camera: { position: { clone(): { set(x: number, y: number, z: number): { applyMatrix4(m: unknown): { project(c: unknown): { x: number; y: number } } } } } }
  stage: { bedRoot: { matrixWorld: unknown } }
  canvas: HTMLCanvasElement
}

const screen = (page: Page, x: number, y: number, z: number) =>
  page.evaluate(([x, y, z]) => {
    const vp = (window as unknown as { __vp: Vp }).__vp
    const v = vp.camera.position.clone().set(x as number, y as number, z as number).applyMatrix4(vp.stage.bedRoot.matrixWorld).project(vp.camera)
    const r = vp.canvas.getBoundingClientRect()
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }
  }, [x, y, z] as const)

const selected = (page: Page) => page.evaluate(() => (window as unknown as { __sx: { getState(): { selectedIds: string[]; plate: { id: string; name: string }[] } } }).__sx.getState()).then((s) => s.selectedIds.length)

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.keyboard.down('Shift')
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await expect(page.getByTestId('model-box-select')).toHaveAttribute('data-dir', to.x >= from.x ? 'inside' : 'touch')
  await page.mouse.up()
  await page.keyboard.up('Shift')
}

test.describe('Model box select', () => {
  test.skip(({ isMobile }) => isMobile, 'Needs a mouse')

  test('left to right picks what is inside, right to left what it touches', async ({ page }) => {
    await openStudio(page)
    await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
    // Three 20 mm boxes in a row along X, centered at 80, 120 and 160 mm.
    for (let i = 0; i < 3; i++) await command(page, 'Add a box')
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: unknown[] } } }).__sx.getState().plate.length)).toBe(3)
    await page.evaluate(() => {
      const sx = (window as unknown as { __sx: { getState(): { plate: { transform: number[] }[] }; setState(p: unknown): void } }).__sx
      sx.setState({ plate: sx.getState().plate.map((p, i) => ({ ...p, transform: p.transform.map((v, k) => (k === 12 ? 80 + 40 * i : k === 13 ? 128 : v)) })) })
    })
    await page.locator('.sx-tab[data-mode="design"]').click()
    // The top view, so bed X and Y run straight across the screen.
    await page.mouse.move(700, 450)
    await page.keyboard.press('1')
    await page.waitForTimeout(800)
    await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ selection: null, selectedIds: [] }))
    // Bed X 60 to 145 holds the first two boxes (70 to 90, 110 to 130) and not the third (150 to 170).
    const p0 = await screen(page, 60, 100, 0)
    const p1 = await screen(page, 145, 160, 0)
    await drag(page, { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y) }, { x: Math.max(p0.x, p1.x), y: Math.max(p0.y, p1.y) })
    await expect.poll(() => selected(page)).toBe(2)
    // Right to left from inside the third box, the same height: it touches all three.
    const p2 = await screen(page, 165, 128, 0)
    await drag(page, { x: p2.x, y: Math.max(p0.y, p1.y) }, { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y) })
    await expect.poll(() => selected(page)).toBe(3)
  })
})
