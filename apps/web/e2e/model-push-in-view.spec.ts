// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Push and pull in the view, with a real mouse and keyboard: a face picked first gets a thin arrow with a Distance box
// at its tip and the operation under the value. Typing replaces the value, Enter applies, Escape closes the tool and
// leaves the model alone, a negative value turns into Cut, and a drag on the arrow sets the distance. It works with the
// right pane shut, and with it open the pane's field and the box stay in step. A finger does the same on a phone.
import type { Page } from '@playwright/test'
import { bounds, command, freshBox, openStudio, toolPanel } from './cad-helpers'
import { appReady, expect, test } from './fixtures'

type V3 = [number, number, number]
type Sx = { getState(): { rails: Record<string, Record<string, boolean>>; subPicks: { kind: string }[]; objectTool: string | null; plate: { id: string }[] }; setState(p: unknown): void }

const sx = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())

/** A bed point (mm) on screen, in client pixels. */
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

/** A fresh box in Model, framed, with the camera still. */
async function framedBox(page: Page): Promise<string> {
  const id = await freshBox(page)
  await page.locator('.sx-tab[data-mode="design"]').click()
  await expect.poll(() => page.evaluate((id) => (window as unknown as { __vp: { drawnObjects(): string[] } }).__vp.drawnObjects().includes(id), id)).toBe(true)
  await page.evaluate(() => (window as unknown as { __vp: { view(v: string, o?: unknown): void } }).__vp.view('fit', { animate: false }))
  await settled(page)
  return id
}

/** The middle of the box's top face on screen. */
async function topMiddle(page: Page, id: string): Promise<{ x: number; y: number }> {
  const b = await bounds(page, id)
  const [x, y] = await screenOf(page, [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]])
  return { x, y }
}

const shutPane = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __sx: Sx }).__sx
    const rails = s.getState().rails
    s.setState({ rails: { ...rails, 'prepare-design': { ...rails['prepare-design'], right: false } } })
  })

const height = async (page: Page, id: string) => {
  const b = await bounds(page, id)
  return Math.round((b.max[2] - b.min[2]) * 100) / 100
}

/** Select first: a click on the top face, then Push and pull, with the pane shut or left open. */
async function pickThenPush(page: Page, id: string, pane: 'open' | 'shut'): Promise<void> {
  const top = await topMiddle(page, id)
  await page.mouse.click(top.x, top.y)
  await expect(page.getByTestId('model-select-readout')).toHaveText('1 face on Box')
  await command(page, 'Push or pull a face')
  if (pane === 'shut') {
    await expect(page.getByTestId('model-inspector')).toBeVisible()
    await shutPane(page)
    await expect(page.getByTestId('model-inspector')).toBeHidden()
  }
  await settled(page)
  await expect(page.getByTestId('push-view-box')).toBeVisible()
}

test.describe('Push and pull in the view', () => {
  test.skip(({ isMobile }) => isMobile, 'Needs a pointer and a keyboard')

  test('with the pane shut: the box takes the typed value, the chip names the operation, and Enter pulls the face', async ({ page }) => {
    test.slow()
    await openStudio(page)
    const id = await framedBox(page)
    const h0 = await height(page, id)
    await pickThenPush(page, id, 'shut')
    const box = page.getByTestId('push-view-distance')
    // the value is focused and selected, so typing replaces it
    await expect(box).toBeFocused()
    await page.keyboard.type('6')
    await expect(box).toHaveValue('6')
    await expect(page.getByTestId('push-view-op')).toHaveText('Pull out')
    await expect(page.getByTestId('push-arrow')).toBeAttached()
    // the box sits inside the view
    const vp = (await page.locator('.vp').boundingBox())!
    const b = (await page.getByTestId('push-view-box').boundingBox())!
    expect(b.x).toBeGreaterThanOrEqual(vp.x)
    expect(b.x + b.width).toBeLessThanOrEqual(vp.x + vp.width)
    await page.keyboard.press('Enter')
    await expect.poll(() => height(page, id), { timeout: 30_000 }).toBe(h0 + 6)
    // applied and closed: no arrow, no tool
    await expect(page.getByTestId('push-in-view')).toHaveCount(0)
    expect((await sx(page)).objectTool).toBeNull()
  })

  test('a negative value turns into Cut, and Enter cuts', async ({ page }) => {
    test.slow()
    await openStudio(page)
    const id = await framedBox(page)
    const h0 = await height(page, id)
    await pickThenPush(page, id, 'shut')
    await page.keyboard.type('-4')
    await expect(page.getByTestId('push-view-op')).toHaveText('Cut')
    await expect(page.getByTestId('push-view-op')).toHaveAttribute('data-op', 'cut')
    await expect(page.locator('.pp-arrow')).toHaveAttribute('data-tone', 'cut')
    // past the far side it cuts through
    await page.getByTestId('push-view-distance').fill(String(-(h0 + 1)))
    await expect(page.getByTestId('push-view-op')).toHaveText('Cut through')
    await page.getByTestId('push-view-distance').fill('-4')
    await page.getByTestId('push-view-distance').press('Enter')
    await expect.poll(() => height(page, id), { timeout: 30_000 }).toBe(h0 - 4)
  })

  test('Escape closes the tool and leaves the model alone; the face stays picked', async ({ page }) => {
    test.slow()
    await openStudio(page)
    const id = await framedBox(page)
    const before = await bounds(page, id)
    await pickThenPush(page, id, 'shut')
    await page.keyboard.type('9')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('push-in-view')).toHaveCount(0)
    expect((await sx(page)).objectTool).toBeNull()
    expect(await bounds(page, id)).toEqual(before)
    await expect(page.getByTestId('model-select-readout')).toHaveText('1 face on Box')
  })

  test('with the pane open, the pane field and the box stay in step both ways, and Enter in the view applies', async ({ page }) => {
    test.slow()
    await openStudio(page)
    const id = await framedBox(page)
    const h0 = await height(page, id)
    await pickThenPush(page, id, 'open')
    const panel = toolPanel(page)
    const field = panel.locator('#push-dist')
    const box = page.getByTestId('push-view-distance')
    await page.keyboard.type('3')
    await expect(field).toHaveValue('3')
    await field.fill('-2.5')
    await expect(box).toHaveValue('-2.5')
    await expect(page.getByTestId('push-view-op')).toHaveText('Cut')
    // the pane's apply names the same operation
    await expect(panel.getByRole('button', { name: 'Cut', exact: true })).toBeVisible()
    await box.fill('7')
    await expect(field).toHaveValue('7')
    await expect(panel.getByRole('button', { name: 'Pull out', exact: true })).toBeVisible()
    await box.press('Enter')
    await expect.poll(() => height(page, id), { timeout: 30_000 }).toBe(h0 + 7)
    await expect(panel).toHaveCount(0)
  })

  test('a drag on the arrow sets the distance, and Enter applies what the drag set', async ({ page }) => {
    test.slow()
    await openStudio(page)
    const id = await framedBox(page)
    const h0 = await height(page, id)
    await pickThenPush(page, id, 'shut')
    const tip = (await page.getByTestId('push-arrow-tip').boundingBox())!
    const at = { x: tip.x + tip.width / 2, y: tip.y + tip.height / 2 }
    // the top face's normal points up on screen in the framed view: drag up to pull out
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x, at.y - 60, { steps: 8 })
    const mid = Number(await page.getByTestId('push-view-distance').inputValue())
    expect(mid).toBeGreaterThan(0)
    await expect(page.getByTestId('push-view-op')).toHaveText('Pull out')
    await page.mouse.up()
    const d = Number(await page.getByTestId('push-view-distance').inputValue())
    expect(d).toBeGreaterThan(0)
    // the arrow grew with the distance
    const tip2 = (await page.getByTestId('push-arrow-tip').boundingBox())!
    expect(tip2.y).toBeLessThan(tip.y - 20)
    // and back down past the face: a cut
    await page.mouse.move(tip2.x + tip2.width / 2, tip2.y + tip2.height / 2)
    await page.mouse.down()
    await page.mouse.move(tip2.x + tip2.width / 2, tip2.y + tip2.height / 2 + 140, { steps: 10 })
    await page.mouse.up()
    const cut = Number(await page.getByTestId('push-view-distance').inputValue())
    expect(cut).toBeLessThan(0)
    await expect(page.getByTestId('push-view-op')).toHaveText(/^Cut/)
    // the box has focus back after the drag; Enter applies
    await expect(page.getByTestId('push-view-distance')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(() => height(page, id), { timeout: 30_000 }).toBeCloseTo(Math.max(0, h0 + cut), 1)
  })
})

test.describe('Push and pull in the view on a phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'Phone only')

  test('a tap picks the face, the box sits in the view, and a typed value applies with Enter', async ({ page }) => {
    test.slow()
    await page.addInitScript(() => {
      if (sessionStorage.getItem('sx-e2e')) return
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.debug', '1')
      localStorage.setItem('slicerx.e2e.cadOnly', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' } }))
    })
    await page.goto('./')
    await appReady(page)
    await page.locator('html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: 120_000 })
    await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
    await page.getByTestId('phone-add').tap()
    await page.getByRole('menu', { name: 'Add' }).getByRole('menuitem', { name: 'Box' }).first().tap()
    await expect.poll(async () => (await sx(page)).plate.length).toBe(1)
    const id = (await sx(page)).plate[0]!.id
    await page.waitForFunction(() => (window as unknown as { __vp: { rig: { move: unknown } } }).__vp.rig.move === null)
    const h0 = await height(page, id)
    await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ objectTool: 'push' }))
    await settled(page)
    const top = await topMiddle(page, id)
    await page.touchscreen.tap(top.x, top.y)
    const box = page.getByTestId('push-view-box')
    await expect(box).toBeVisible()
    const b = (await box.boundingBox())!
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.x + b.width).toBeLessThanOrEqual(390)
    // the keyboard stays down until the box is tapped; the value is a 44 px target
    const input = page.getByTestId('push-view-distance')
    await expect(input).not.toBeFocused()
    expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await input.tap()
    await input.fill('4')
    await expect(page.getByTestId('push-view-op')).toHaveText('Pull out')
    await input.press('Enter')
    await expect.poll(() => height(page, id), { timeout: 30_000 }).toBe(h0 + 4)
  })
})
