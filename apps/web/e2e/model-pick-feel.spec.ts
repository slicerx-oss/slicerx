// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The new Model feel's pick filter (developer flag): Model starts on Face, a real click a few pixels from an edge picks
// the edge and one well inside the face picks the face, Edge only and Body stay explicit modes, and the palette
// command turns it over. Without the flag the filter starts on objects and the face wins, as before.
import type { Page } from '@playwright/test'
import { bounds, command, freshBox, openStudio } from './cad-helpers'
import { expect, test } from './fixtures'

type V3 = [number, number, number]

/** Turns the flag on before the app starts, as the palette command leaves it. */
async function withFeel(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('sx.modelFeel', '1'))
}

/** Frames the box, then the screen points `px` pixels inside its top face from the middle of its front top edge. */
async function nearFrontEdge(page: Page, id: string, px: number): Promise<{ x: number; y: number }> {
  const b = await bounds(page, id)
  const cx = (b.min[0] + b.max[0]) / 2
  const edge: V3 = [cx, b.min[1], b.max[2]]
  const center: V3 = [cx, (b.min[1] + b.max[1]) / 2, b.max[2]]
  return page.evaluate(
    ({ edge, center, px }) => {
      const vp = (window as unknown as { __vp: { screenOf(p: number[]): [number, number] } }).__vp
      const m = vp.screenOf(edge)
      const c = vp.screenOf(center)
      const len = Math.hypot(c[0] - m[0], c[1] - m[1])
      return { x: m[0] + ((c[0] - m[0]) / len) * px, y: m[1] + ((c[1] - m[1]) / len) * px }
    },
    { edge, center, px },
  )
}

async function framedBox(page: Page): Promise<string> {
  const id = await freshBox(page)
  await page.locator('.sx-tab[data-mode="design"]').click()
  await page.evaluate(() => (window as unknown as { __vp: { view(v: string, o?: unknown): void } }).__vp.view('fit', { animate: false }))
  return id
}

const filter = (page: Page, kind: string) => page.locator(`[data-testid="model-select-filter"][data-kind="${kind}"]`)

test.describe('Model pick feel (developer flag)', () => {
  test.skip(({ isMobile }) => isMobile, 'Needs a pointer and a keyboard')

  test('starts on Face, and an edge within 6 px of the click wins over the face', async ({ page }) => {
    test.slow()
    await withFeel(page)
    await openStudio(page, { settingsMode: 'developer' })
    const id = await framedBox(page)
    const readout = page.getByTestId('model-select-readout')
    await expect(filter(page, 'face')).toHaveAttribute('aria-pressed', 'true')
    await expect(filter(page, 'object')).toHaveAttribute('aria-pressed', 'false')
    await expect(filter(page, 'face')).toHaveAttribute('aria-label', 'Face')
    await expect(filter(page, 'edge')).toHaveAttribute('aria-label', 'Edge only')
    await expect(filter(page, 'object')).toHaveAttribute('aria-label', 'Body')
    // Well inside the face: the face.
    const inside = await nearFrontEdge(page, id, 24)
    await page.mouse.click(inside.x, inside.y)
    await expect(readout).toHaveText('1 face on Box')
    // Three pixels in from the edge: the edge wins.
    const near = await nearFrontEdge(page, id, 3)
    await page.mouse.click(near.x, near.y)
    await expect(readout).toHaveText('1 edge on Box')
    const picks = await page.evaluate(() => (window as unknown as { __sx: { getState(): { subPicks: { kind: string }[] } } }).__sx.getState().subPicks.map((p) => p.kind))
    expect(picks).toEqual(['edge'])
    // Ten pixels in: past the radius, the face again.
    const past = await nearFrontEdge(page, id, 10)
    await page.mouse.click(past.x, past.y)
    await expect(readout).toHaveText('1 face on Box')
  })

  test('hover shows what a click would pick: the edge near it, else the face', async ({ page }) => {
    test.slow()
    await withFeel(page)
    await openStudio(page, { settingsMode: 'developer' })
    const id = await framedBox(page)
    // The view's own hover state: the dashed edge lines and the lit face.
    const hover = () => page.evaluate(() => {
      const vp = (window as unknown as { __vp: { edgeMarks: { lines: { hover: unknown[] } }; faceKey: string } }).__vp
      return { edge: vp.edgeMarks.lines.hover.length > 0, face: vp.faceKey !== '' }
    })
    const near = await nearFrontEdge(page, id, 3)
    await page.mouse.move(near.x - 40, near.y - 40)
    await page.mouse.move(near.x, near.y, { steps: 4 })
    await expect.poll(hover).toEqual({ edge: true, face: false })
    const inside = await nearFrontEdge(page, id, 24)
    await page.mouse.move(inside.x, inside.y, { steps: 4 })
    await expect.poll(hover).toEqual({ edge: false, face: true })
  })

  test('Edge only and Body are explicit modes', async ({ page }) => {
    test.slow()
    await withFeel(page)
    await openStudio(page, { settingsMode: 'developer' })
    const id = await framedBox(page)
    const readout = page.getByTestId('model-select-readout')
    // Edge only: even a click well inside the face picks the edge nearest it.
    await filter(page, 'edge').click()
    const inside = await nearFrontEdge(page, id, 24)
    await page.mouse.click(inside.x, inside.y)
    await expect(readout).toHaveText(/1 edge on Box/)
    // Body: a click near the edge selects the whole body, no face or edge.
    await filter(page, 'object').click()
    const near = await nearFrontEdge(page, id, 3)
    await page.mouse.click(near.x, near.y)
    await expect(readout).toHaveText('Box')
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { subPicks: unknown[] } } }).__sx.getState().subPicks.length)).toBe(0)
  })

  test('the palette command turns it off and on; off, the filter is objects and labels are as before', async ({ page }) => {
    test.slow()
    await withFeel(page)
    await openStudio(page, { settingsMode: 'developer' })
    await framedBox(page)
    await command(page, 'Developer: new Model feel')
    await expect(page.getByText('The new Model feel is off.')).toBeVisible()
    await expect(filter(page, 'object')).toHaveAttribute('aria-pressed', 'true')
    await expect(filter(page, 'object')).toHaveAttribute('aria-label', 'Objects')
    expect(await page.evaluate(() => localStorage.getItem('sx.modelFeel'))).toBeNull()
    await command(page, 'Developer: new Model feel')
    await expect(page.getByText('The new Model feel is on.')).toBeVisible()
    await expect(filter(page, 'face')).toHaveAttribute('aria-pressed', 'true')
    await expect(filter(page, 'face')).toHaveAttribute('aria-label', 'Face')
  })

  test('without the flag, Faces lets the face win as before', async ({ page }) => {
    test.slow()
    await openStudio(page, { settingsMode: 'developer' })
    const id = await framedBox(page)
    await expect(filter(page, 'object')).toHaveAttribute('aria-pressed', 'true')
    await page.mouse.move(700, 450)
    await page.keyboard.press('Alt+2')
    const near = await nearFrontEdge(page, id, 3)
    await page.mouse.click(near.x, near.y)
    await expect(page.getByTestId('model-select-readout')).toHaveText('1 face on Box')
  })
})
