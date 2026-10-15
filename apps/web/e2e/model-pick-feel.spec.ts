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

/**
 * The screen point `px` pixels inside the box's top face from the middle of its front top edge, measured square to
 * that edge on screen: the pick radius is a distance from the edge, and the top face is foreshortened, so a step
 * toward the face's center would land nearer the edge than its length.
 */
async function nearFrontEdge(page: Page, id: string, px: number): Promise<{ x: number; y: number }> {
  const b = await bounds(page, id)
  const ends: [V3, V3] = [[b.min[0], b.min[1], b.max[2]], [b.max[0], b.min[1], b.max[2]]]
  const center: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]]
  return page.evaluate(
    ({ ends, center, px }) => {
      const vp = (window as unknown as { __vp: { screenOf(p: number[]): [number, number] } }).__vp
      const a = vp.screenOf(ends[0])
      const e = vp.screenOf(ends[1])
      const c = vp.screenOf(center)
      const m: [number, number] = [(a[0] + e[0]) / 2, (a[1] + e[1]) / 2]
      const len = Math.hypot(e[0] - a[0], e[1] - a[1])
      // the edge's normal on screen, turned toward the face
      let n: [number, number] = [-(e[1] - a[1]) / len, (e[0] - a[0]) / len]
      if (n[0] * (c[0] - m[0]) + n[1] * (c[1] - m[1]) < 0) n = [-n[0], -n[1]]
      return { x: m[0] + n[0] * px, y: m[1] + n[1] * px }
    },
    { ends, center, px },
  )
}

/**
 * Frames the view once it draws the object and its camera has stopped: the view swaps a new plate in a frame after the
 * store has it, and that swap can move the camera, so a screen point read before then would point somewhere else.
 */
async function settledFit(page: Page, id: string): Promise<void> {
  await expect.poll(() => page.evaluate((id) => (window as unknown as { __vp: { drawnObjects(): string[] } }).__vp.drawnObjects().includes(id), id)).toBe(true)
  const at = () => page.evaluate(() => (window as unknown as { __vp: { screenOf(p: number[]): [number, number] } }).__vp.screenOf([0, 0, 0]).map((v) => Math.round(v)).join(','))
  // Model opens with an eased move to its own view, and a fit keeps the angle the camera has: one taken partway
  // through that move (a slow machine draws it slowly) frames from another angle on every run. So wait for Model to
  // show and the move to end before framing.
  await expect(filter(page, 'face')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __vp: { rig: { move: unknown } } }).__vp.rig.move === null)).toBe(true)
  await page.evaluate(() => (window as unknown as { __vp: { view(v: string, o?: unknown): void } }).__vp.view('fit', { animate: false }))
  // still for a second: a panel that opens with Model moves the view's frame a little later
  let last = ''
  let still = 0
  await expect
    .poll(async () => {
      const now = await at()
      still = now === last ? still + 1 : 0
      last = now
      return still >= 4
    }, { intervals: [250], timeout: 15_000 })
    .toBe(true)
}

async function framedBox(page: Page): Promise<string> {
  const id = await freshBox(page)
  await page.locator('.sx-tab[data-mode="design"]').click()
  await settledFit(page, id)
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

// Review shots: before (flag off, as main is) and after (flag on), the pointer resting 3 px in from the box's front top
// edge, in both themes, at the project's width. SX_SHOTS=1 only.
test.describe('Model pick feel shots', () => {
  for (const scheme of ['dark', 'light'] as const) {
    for (const feel of [false, true]) {
      test(`shots: ${feel ? 'after' : 'before'} in ${scheme}`, async ({ page }, info) => {
        test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
        test.slow()
        const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
        if (feel) await withFeel(page)
        await openStudio(page, { settingsMode: 'developer', scheme, themeFollowsSystem: false })
        const design = page.locator('.sx-tab[data-mode="design"]')
        const id = await freshBox(page)
        if (await design.isVisible()) await design.click()
        await settledFit(page, id)
        const near = await nearFrontEdge(page, id, 3)
        await page.mouse.move(near.x - 30, near.y - 30)
        await page.mouse.move(near.x, near.y, { steps: 4 })
        await page.waitForTimeout(1200)
        await page.screenshot({ path: `${dir}/pick-filter-${feel ? 'after' : 'before'}-${info.project.name === 'phone' ? 390 : 1440}-${scheme}.png` })
      })
    }
  }
})
