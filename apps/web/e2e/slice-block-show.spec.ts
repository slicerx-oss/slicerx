// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Show me on the Slice footer's blocks. A strike that holds Print back goes to its layer and spot in the toolpaths;
// a slice the safety check refused turns the view to the spot it names and picks the object there.
import { type Page } from '@playwright/test'
import { openStudio } from './cad-helpers'
import { expect, sliceCount, sliced, test } from './fixtures'

type Sx = { getState(): Record<string, unknown> & { layerHi: number; sliceLook: string; strikePick: number | null; selectedIds: string[]; plate: { id: string; name: string }[]; slice: { status: string; result?: Record<string, unknown> } }; setState(p: unknown): void }
type Vp = { getCamera(): { target: number[] } }
const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())
const target = (page: Page) => page.evaluate(() => (window as unknown as { __vp: Vp }).__vp.getCamera().target)
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) < 0.5)

/** A gantry strike on layer 3 (0 based), deepest at 120, 110, 8 mm, put on the finished slice. */
async function strike(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sx = (window as unknown as { __sx: Sx }).__sx
    const s = sx.getState()
    const id = s.plate[0]!.id
    // Its moment is the middle of layer 3, so playback stops on the strike's own layer.
    const lt = (s.slice.result!['layerTimeS'] as ArrayLike<number>)
    const timeS = lt[0]! + lt[1]! + lt[2]! + lt[3]! / 2
    const hit = { kind: 'gantry', severity: 'hit', part: 'gantry', objectId: id, hitId: id, layer: 3, segment: 0, timeS, lastLayer: 4, at: [120, 110, 0.8], point: [120, 110, 8], worstLayer: 3, worstPoint: [120, 110, 8], depthMm: 2, hitHeightMm: 12, limitMm: 10 }
    sx.setState({ slice: { ...s.slice, result: { ...s.slice.result, collisions: [hit], collisionFixes: [] } } })
  })
}

/** An excluded area of 20 mm around the first object's place, so the safety check refuses the plate's next slice. */
async function refuse(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sx = (window as unknown as { __sx: Sx }).__sx
    const s = sx.getState()
    const t = (s.plate[0] as unknown as { transform: number[] }).transform
    const [x, y] = [t[12]!, t[13]!]
    const c = (dx: number, dy: number) => `${(x + dx).toFixed(1)}x${(y + dy).toFixed(1)}`
    sx.setState({ overrides: { ...(s['overrides'] as object), bed_exclude_area: [c(-10, -10), c(10, -10), c(10, 10), c(-10, 10)] } })
  })
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(page.getByTestId('slice-estimate-error')).toBeVisible({ timeout: 120_000 })
}

test('Show me on a strike opens the toolpaths at its layer and centers the view on it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await openStudio(page, { settingsMode: 'simple' })
  const n = await sliceCount(page)
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(sliced(page, n)).toBeVisible({ timeout: 120_000 })
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ sliceLook: 'solid' }))
  await strike(page)
  const show = page.getByTestId('slice-block-show')
  await expect(show).toHaveText('Show me')
  await show.click()
  await expect.poll(async () => { const s = await state(page); return `${s.sliceLook} ${s.layerHi} ${s.strikePick}` }).toBe('toolpaths 4 0')
  // Playback runs to the strike's moment and stays on its layer.
  await page.waitForTimeout(1000)
  expect((await state(page)).layerHi).toBe(4)
  await expect.poll(async () => near(await target(page), [120, 110, 8])).toBe(true)
})

test("Show me on a refused slice centers the view on the spot the refusal names", async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await openStudio(page, { settingsMode: 'simple' })
  const n = await sliceCount(page)
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(sliced(page, n)).toBeVisible({ timeout: 120_000 })
  await refuse(page)
  const text = (await page.getByTestId('slice-estimate-error').textContent()) ?? ''
  const m = /from layer (\d+) \(X(-?[\d.]+) Y(-?[\d.]+)/.exec(text)
  expect(m, text).not.toBeNull()
  const before = await target(page)
  await page.getByTestId('slice-error-show').click()
  // The example plate's printer counts from 0, 0, so the machine X and Y are the plate's; layer 1 is the bed.
  const spot = [Number(m![2]), Number(m![3]), 0]
  expect(near(before, spot)).toBe(false)
  await expect.poll(async () => near(await target(page), spot)).toBe(true)
  const s = await state(page)
  expect(s.selectedIds.map((id) => s.plate.find((p) => p.id === id)?.name)).toEqual(['Layered X'])
})

// Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
test('shots: Show me on the Slice footer blocks, light and dark', async ({ page }, info) => {
  test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
  test.slow()
  const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
  const width = page.viewportSize()?.width ?? 0
  await openStudio(page, { settingsMode: 'simple' })
  const n = await sliceCount(page)
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(sliced(page, n)).toBeVisible({ timeout: 120_000 })
  const shot = async (name: string) => {
    // The test build's own notices (software WebGL, no geometry engine) would cover the view.
    await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ toast: null }))
    await page.mouse.move(0, 0)
    await page.waitForTimeout(900)
    await page.screenshot({ path: `${dir}/${name}-${width}.png` })
  }
  for (const scheme of ['light', 'dark'] as const) {
    await page.evaluate((scheme) => (window as unknown as { __sx: Sx }).__sx.setState({ scheme, themeFollowsSystem: false, sliceLook: 'solid', layerHi: 1e9 }), scheme)
    await strike(page)
    await expect(page.getByTestId('slice-block-show')).toBeVisible()
    await page.evaluate(() => (window as unknown as { __vp: { zoomToBed?(o: unknown): void } }).__vp.zoomToBed?.({ animate: false }))
    await shot(`strike-before-${scheme}`)
    await page.getByTestId('slice-block-show').click()
    await shot(`strike-after-${scheme}`)
  }
  await refuse(page)
  for (const scheme of ['light', 'dark'] as const) {
    await page.evaluate((scheme) => (window as unknown as { __sx: Sx }).__sx.setState({ scheme, themeFollowsSystem: false, selectedIds: [], selection: null }), scheme)
    await page.evaluate(() => (window as unknown as { __vp: { zoomToBed?(o: unknown): void } }).__vp.zoomToBed?.({ animate: false }))
    await shot(`refused-before-${scheme}`)
    await page.getByTestId('slice-error-show').click()
    await shot(`refused-after-${scheme}`)
  }
})
