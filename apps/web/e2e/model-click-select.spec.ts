// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model picks with real mouse clicks, not events sent to the view: a click on a face picks it with no tool open and with
// Push and pull open, the pill names the face, the Push and pull panel agrees with the pill, and a tool opened with
// the right pane shut opens the pane, so it hears its clicks and shows its controls.
import type { Page } from '@playwright/test'
import { bounds, command, freshBox, openStudio, toolPanel } from './cad-helpers'
import { expect, test } from './fixtures'

type V3 = [number, number, number]

/** A bed point (mm) on screen, in client pixels. */
function screenOf(page: Page, p: V3): Promise<[number, number]> {
  return page.evaluate((p) => (window as unknown as { __vp: { screenOf(p: number[]): [number, number] } }).__vp.screenOf(p), p)
}

/** Frames the box once the view draws it, and waits until the camera stops moving. */
async function framedBox(page: Page): Promise<string> {
  const id = await freshBox(page)
  await page.locator('.sx-tab[data-mode="design"]').click()
  await expect.poll(() => page.evaluate((id) => (window as unknown as { __vp: { drawnObjects(): string[] } }).__vp.drawnObjects().includes(id), id)).toBe(true)
  await page.evaluate(() => (window as unknown as { __vp: { view(v: string, o?: unknown): void } }).__vp.view('fit', { animate: false }))
  await settled(page)
  return id
}

/** Waits until the view's frame stops moving (a pane opening resizes it a little later). */
async function settled(page: Page): Promise<void> {
  let last = ''
  let still = 0
  await expect
    .poll(async () => {
      const now = (await screenOf(page, [0, 0, 0])).map((v) => Math.round(v)).join(',')
      still = now === last ? still + 1 : 0
      last = now
      return still >= 4
    }, { intervals: [250], timeout: 15_000 })
    .toBe(true)
}

/** The middle of the box's top face on screen. */
async function topMiddle(page: Page, id: string): Promise<{ x: number; y: number }> {
  const b = await bounds(page, id)
  const [x, y] = await screenOf(page, [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]])
  return { x, y }
}

/** The screen point `px` pixels inside the top face, square off the middle of its front top edge on screen. */
async function offFrontEdge(page: Page, id: string, px: number): Promise<{ x: number; y: number }> {
  const b = await bounds(page, id)
  const a = await screenOf(page, [b.min[0], b.min[1], b.max[2]])
  const e = await screenOf(page, [b.max[0], b.min[1], b.max[2]])
  const c = await topMiddle(page, id)
  const m = [(a[0] + e[0]) / 2, (a[1] + e[1]) / 2] as const
  const len = Math.hypot(e[0] - a[0], e[1] - a[1])
  let n = [-(e[1] - a[1]) / len, (e[0] - a[0]) / len]
  if (n[0]! * (c.x - m[0]) + n[1]! * (c.y - m[1]) < 0) n = [-n[0]!, -n[1]!]
  return { x: m[0] + n[0]! * px, y: m[1] + n[1]! * px }
}

const filter = (page: Page, kind: string) => page.locator(`[data-testid="model-select-filter"][data-kind="${kind}"]`)
const subPicks = (page: Page) => page.evaluate(() => (window as unknown as { __sx: { getState(): { subPicks: { kind: string }[] } } }).__sx.getState().subPicks.map((p) => p.kind))

test.describe('Model click to select', () => {
  test.skip(({ isMobile }) => isMobile, 'Needs a pointer')

  test('Model starts on Face, and a click on a face picks it', async ({ page }) => {
    test.slow()
    await openStudio(page)
    const id = await framedBox(page)
    await expect(filter(page, 'face')).toHaveAttribute('aria-pressed', 'true')
    await expect(filter(page, 'object')).toHaveAttribute('aria-pressed', 'false')
    const top = await topMiddle(page, id)
    await page.mouse.click(top.x, top.y)
    await expect(page.getByTestId('model-select-readout')).toHaveText('1 face on Box')
    expect(await subPicks(page)).toEqual(['face'])
    // The click picked; it did not move the box.
    const b = await bounds(page, id)
    const again = await bounds(page, id)
    expect(again).toEqual(b)
  })

  test('on a slow machine, the face lights once the pointer rests inside it after an edge', async ({ page }) => {
    test.slow()
    await openStudio(page)
    const id = await framedBox(page)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
    const hover = () =>
      page.evaluate(() => {
        const vp = (window as unknown as { __vp: { edgeMarks: { lines: { hover: unknown[] } }; faceKey: string } }).__vp
        return { edge: vp.edgeMarks.lines.hover.length > 0, face: vp.faceKey !== '' }
      })
    try {
      for (let i = 0; i < 4; i++) {
        const near = await offFrontEdge(page, id, 3)
        const inside = await topMiddle(page, id)
        await page.mouse.move(near.x, near.y - 30)
        await page.mouse.move(near.x, near.y, { steps: 3 })
        await expect.poll(hover).toEqual({ edge: true, face: false })
        // one move inside, then the pointer rests: the late edge answer must not leave the face unlit
        await page.mouse.move(inside.x, inside.y)
        await expect.poll(hover, { timeout: 10_000 }).toEqual({ edge: false, face: true })
      }
    } finally {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    }
  })

  test('Body picks the whole body with a click', async ({ page }) => {
    test.slow()
    await openStudio(page)
    const id = await framedBox(page)
    await filter(page, 'object').click()
    const top = await topMiddle(page, id)
    await page.mouse.click(top.x, top.y)
    await expect(page.getByTestId('model-select-readout')).toHaveText('Box')
    expect(await subPicks(page)).toEqual([])
  })

  test('with Push and pull open, a click on a face picks it, and the pill and the panel agree', async ({ page }) => {
    test.slow()
    await openStudio(page)
    const id = await framedBox(page)
    const readout = page.getByTestId('model-select-readout')
    await command(page, 'Push or pull a face')
    const panel = toolPanel(page)
    await expect(panel).toContainText('No face yet')
    // the new box is selected as a whole; no face yet
    await expect(readout).toHaveText('Box')
    const top = await topMiddle(page, id)
    await page.mouse.click(top.x, top.y)
    await expect(panel).toContainText('A face is picked')
    await expect(readout).toHaveText('1 face on Box')
  })

  test('select first: a face picked before Push and pull stays named while the panel uses it', async ({ page }) => {
    test.slow()
    await openStudio(page)
    const id = await framedBox(page)
    const readout = page.getByTestId('model-select-readout')
    const top = await topMiddle(page, id)
    await page.mouse.click(top.x, top.y)
    await expect(readout).toHaveText('1 face on Box')
    await command(page, 'Push or pull a face')
    const panel = toolPanel(page)
    await expect(panel).toContainText('A face is picked')
    await expect(readout).toHaveText('1 face on Box')
    // Escape closes the tool and leaves the model alone; the face stays picked.
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(readout).toHaveText('1 face on Box')
  })

  test('Push and pull with the right pane shut: the pane opens, a click picks the face, and Enter pulls it', async ({ page }) => {
    test.slow()
    await openStudio(page)
    const id = await framedBox(page)
    const readout = page.getByTestId('model-select-readout')
    const pane = page.getByTestId('model-inspector')
    await page.evaluate(() => {
      const sx = (window as unknown as { __sx: { getState(): { rails: Record<string, Record<string, boolean>> }; setState(p: unknown): void } }).__sx
      const rails = sx.getState().rails
      sx.setState({ rails: { ...rails, 'prepare-design': { ...rails['prepare-design'], right: false } } })
    })
    await expect(pane).toBeHidden()
    await command(page, 'Push or pull a face')
    const panel = toolPanel(page)
    await expect(panel).toContainText('No face yet')
    await expect(pane).toBeVisible()
    await settled(page)
    const before = await bounds(page, id)
    const top = await topMiddle(page, id)
    await page.mouse.click(top.x, top.y)
    await expect(panel).toContainText('A face is picked')
    await expect(readout).toHaveText('1 face on Box')
    await panel.locator('#push-dist').fill('5')
    await panel.locator('#push-dist').press('Enter')
    await expect.poll(async () => Math.round((await bounds(page, id)).max[2] - before.max[2]), { timeout: 30_000 }).toBe(5)
  })
})

// Review shots: Push and pull opened with the right pane shut, then a click on the box's top face, in both themes at the
// project's width. Before the fix the pane stays shut and the pill reads "Nothing selected"; after it the pane opens with
// the tool and the pill names the face. SX_SHOTS=1 only.
test.describe('Model click to select shots', () => {
  for (const scheme of ['dark', 'light'] as const) {
    test(`shots: push and pull with the pane shut in ${scheme}`, async ({ page }, info) => {
      test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
      test.skip(info.project.name === 'phone', 'Desktop pane')
      test.slow()
      const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
      await openStudio(page, { scheme, themeFollowsSystem: false })
      const id = await framedBox(page)
      await page.evaluate(() => {
        const sx = (window as unknown as { __sx: { getState(): { rails: Record<string, Record<string, boolean>> }; setState(p: unknown): void } }).__sx
        const rails = sx.getState().rails
        sx.setState({ rails: { ...rails, 'prepare-design': { ...rails['prepare-design'], right: false } } })
      })
      await command(page, 'Push or pull a face')
      await page.waitForTimeout(800)
      await settled(page)
      const top = await topMiddle(page, id)
      await page.mouse.click(top.x, top.y)
      await page.mouse.move(top.x + 60, top.y + 60)
      await page.waitForTimeout(1500)
      await page.screenshot({ path: `${dir}/push-pane-shut-1440-${scheme}.png` })
    })
  }
})
