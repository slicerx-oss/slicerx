// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Edge picks with real mouse clicks, not pick events sent to the view: a click on the middle of a box edge picks that
// edge in Fillet, in Chamfer, with no tool on the default Face filter, and with Edge only. The pill names the edge and
// the open tool's panel counts it.
import type { Page } from '@playwright/test'
import { bounds, command, freshBox, openStudio, toolPanel } from './cad-helpers'
import { expect, test } from './fixtures'

type V3 = [number, number, number]

function screenOf(page: Page, p: V3): Promise<[number, number]> {
  return page.evaluate((p) => (window as unknown as { __vp: { screenOf(p: number[]): [number, number] } }).__vp.screenOf(p), p)
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

/** A box in Model, drawn and framed, with the camera still. */
async function framedBox(page: Page): Promise<string> {
  const id = await freshBox(page)
  await page.locator('.sx-tab[data-mode="design"]').click()
  await expect.poll(() => page.evaluate((id) => (window as unknown as { __vp: { drawnObjects(): string[] } }).__vp.drawnObjects().includes(id), id)).toBe(true)
  await page.evaluate(() => (window as unknown as { __vp: { view(v: string, o?: unknown): void } }).__vp.view('fit', { animate: false }))
  await settled(page)
  return id
}

/** The middle of the box's front top edge on screen, where the top face meets the front face. */
async function frontTopEdge(page: Page, id: string): Promise<{ x: number; y: number }> {
  const b = await bounds(page, id)
  const [x, y] = await screenOf(page, [(b.min[0] + b.max[0]) / 2, b.min[1], b.max[2]])
  return { x, y }
}

/**
 * The middle of the box's back top edge on screen, where the top face meets the back face the camera cannot see, moved
 * `px` pixels off the box (square to the edge, away from the top face): an outline edge, with nothing behind a click
 * just past it.
 */
async function backTopEdge(page: Page, id: string, px: number): Promise<{ x: number; y: number }> {
  const b = await bounds(page, id)
  const a = await screenOf(page, [b.min[0], b.max[1], b.max[2]])
  const e = await screenOf(page, [b.max[0], b.max[1], b.max[2]])
  const c = await screenOf(page, [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]])
  const m = [(a[0] + e[0]) / 2, (a[1] + e[1]) / 2] as const
  const len = Math.hypot(e[0] - a[0], e[1] - a[1])
  let n = [-(e[1] - a[1]) / len, (e[0] - a[0]) / len]
  if (n[0]! * (c[0] - m[0]) + n[1]! * (c[1] - m[1]) > 0) n = [-n[0]!, -n[1]!]
  return { x: m[0] + n[0]! * px, y: m[1] + n[1]! * px }
}

const readout = (page: Page) => page.getByTestId('model-select-readout')
const filter = (page: Page, kind: string) => page.locator(`[data-testid="model-select-filter"][data-kind="${kind}"]`)
const subPicks = (page: Page) => page.evaluate(() => (window as unknown as { __sx: { getState(): { subPicks: { kind: string }[] } } }).__sx.getState().subPicks.map((p) => p.kind))

/** Opens a Modify tool from the ribbon, as a person does. */
async function ribbon(page: Page, testId: string, data?: string): Promise<void> {
  await page.getByTestId('ribbon-tab-solid').click()
  const button = data ? page.locator(`[data-testid="${testId}"][data-tool="${data}"]`) : page.getByTestId(testId)
  await button.first().click()
}

test.describe('Model edge click', () => {
  test.skip(({ isMobile }) => isMobile, 'Needs a pointer')

  for (const shape of ['Fillet', 'Chamfer'] as const) {
    test(`${shape}: a click on a box edge picks it, and the panel and the pill agree`, async ({ page }) => {
      test.slow()
      await openStudio(page)
      const id = await framedBox(page)
      if (shape === 'Fillet') await ribbon(page, 'model-shelf-tool', 'fillet')
      else await ribbon(page, 'ribbon-chamfer')
      const panel = toolPanel(page)
      await expect(panel).toContainText('No edge yet')
      await expect(panel.getByRole('radio', { name: shape })).toBeChecked()
      await settled(page)
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
    await openStudio(page)
    const id = await framedBox(page)
    await page.evaluate(() => {
      const sx = (window as unknown as { __sx: { getState(): { rails: Record<string, Record<string, boolean>> }; setState(p: unknown): void } }).__sx
      const rails = sx.getState().rails
      sx.setState({ rails: { ...rails, 'prepare-design': { ...rails['prepare-design'], right: false } } })
    })
    await expect(page.getByTestId('model-inspector')).toBeHidden()
    await command(page, 'Fillet or chamfer edges')
    const panel = toolPanel(page)
    await expect(panel).toContainText('No edge yet')
    await settled(page)
    const at = await frontTopEdge(page, id)
    await page.mouse.click(at.x, at.y)
    await expect(panel).toContainText('1 edge')
    await expect(readout(page)).toHaveText('1 edge on Box')
  })

  for (const px of [0, 3]) {
    test(`Fillet: a click ${px ? `${px} px outside` : 'on'} an outline edge picks it`, async ({ page }) => {
      test.slow()
      await openStudio(page)
      const id = await framedBox(page)
      await ribbon(page, 'model-shelf-tool', 'fillet')
      const panel = toolPanel(page)
      await expect(panel).toContainText('No edge yet')
      await settled(page)
      const at = await backTopEdge(page, id, px)
      await page.mouse.click(at.x, at.y)
      await expect(panel).toContainText('1 edge')
      await expect(readout(page)).toHaveText('1 edge on Box')
    })

    test(`no tool, Face: a click ${px ? `${px} px outside` : 'on'} an outline edge picks the edge`, async ({ page }) => {
      test.slow()
      await openStudio(page)
      const id = await framedBox(page)
      const at = await backTopEdge(page, id, px)
      await page.mouse.click(at.x, at.y)
      await expect(readout(page)).toHaveText('1 edge on Box')
      expect(await subPicks(page)).toEqual(['edge'])
    })
  }

  test('no tool, Face: a click on an edge picks the edge', async ({ page }) => {
    test.slow()
    await openStudio(page)
    const id = await framedBox(page)
    await expect(filter(page, 'face')).toHaveAttribute('aria-pressed', 'true')
    const at = await frontTopEdge(page, id)
    await page.mouse.click(at.x, at.y)
    await expect(readout(page)).toHaveText('1 edge on Box')
    expect(await subPicks(page)).toEqual(['edge'])
  })

  test('no tool, Edge only: a click on an edge picks the edge, and Fillet opens on it', async ({ page }) => {
    test.slow()
    await openStudio(page)
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
