// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The operation preview, one look for every Model tool that previews, with a real mouse and keyboard: added material
// is tinted and removed material is a ghost seen through the part, and an edit that fails keeps the last good preview
// on screen with the error next to the tool. Push and pull (a pull, a cut, a distance that does not read), fillet and
// chamfer (a size the engine refuses, typed on the keyboard), dark and light, and push and pull with a finger on a phone.
import type { Page } from '@playwright/test'
import { bounds, command, facePick, freshBox, openStudio, pick, placeAt, steps, toolPanel } from './cad-helpers'
import { appReady, expect, test } from './fixtures'

type V3 = [number, number, number]
type Shown = { added: boolean; removed: boolean; look: { add: string; cut: string; addFill: number; cutFill: number } }
type Sx = { getState(): { rails: Record<string, Record<string, boolean>>; plate: { id: string }[] }; setState(p: unknown): void }

const sx = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())
/** What the view's operation preview draws now. */
const shown = (page: Page) => page.evaluate(() => (window as unknown as { __vp: { operationPreview(): Shown } }).__vp.operationPreview())
const screenOf = (page: Page, p: V3) => page.evaluate((p) => (window as unknown as { __vp: { screenOf(p: number[]): [number, number] } }).__vp.screenOf(p), p)

/** Waits until the view's frame stops moving. */
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

/** A fresh 20 mm box in Model, framed, with the camera still. */
async function framedBox(page: Page, at?: [number, number]): Promise<string> {
  const id = await freshBox(page)
  if (at) await placeAt(page, at[0], at[1])
  await page.locator('.sx-tab[data-mode="design"]').click()
  await expect.poll(() => page.evaluate((id) => (window as unknown as { __vp: { drawnObjects(): string[] } }).__vp.drawnObjects().includes(id), id)).toBe(true)
  await page.evaluate(() => (window as unknown as { __vp: { view(v: string, o?: unknown): void } }).__vp.view('fit', { animate: false }))
  await settled(page)
  return id
}

const height = async (page: Page, id: string) => {
  const b = await bounds(page, id)
  return Math.round((b.max[2] - b.min[2]) * 100) / 100
}

/** A click on the top face of the box, then Push and pull. */
async function pushOnTop(page: Page, id: string): Promise<void> {
  const b = await bounds(page, id)
  const [x, y] = await screenOf(page, [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]])
  await page.mouse.click(x, y)
  await expect(page.getByTestId('model-select-readout')).toHaveText('1 face on Box')
  await command(page, 'Push or pull a face')
  await expect(page.getByTestId('push-view-box')).toBeVisible()
}

test.describe('Operation preview on a desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'Needs a pointer and a keyboard')

  test('push and pull: a pull is tinted, a cut is a ghost, and a distance that does not read keeps the last good preview', async ({ page }) => {
    test.slow()
    await openStudio(page)
    const id = await framedBox(page)
    const h0 = await height(page, id)
    await pushOnTop(page, id)
    const box = page.getByTestId('push-view-distance')
    await expect(box).toBeFocused()
    await page.keyboard.type('6')
    await expect.poll(() => shown(page)).toMatchObject({ added: true, removed: false })
    // removed material is fainter than added material, so it reads as a ghost through the part
    const look = (await shown(page)).look
    expect(look.cutFill).toBeLessThan(look.addFill)
    expect(look.add).not.toBe(look.cut)

    await box.press('ControlOrMeta+a')
    await page.keyboard.type('-4')
    await expect(page.getByTestId('push-view-op')).toHaveText('Cut')
    await expect.poll(() => shown(page)).toMatchObject({ added: false, removed: true })
    const tip = (await page.getByTestId('push-arrow-tip').boundingBox())!

    // a distance that does not read: the cut stays on screen, the arrow stays put, and the box says why
    await page.keyboard.type('x')
    await expect(box).toHaveValue('-4x')
    const error = page.getByTestId('push-view-error')
    await expect(error).toHaveText('Type a number, such as 5 or -3. Showing the last good preview.')
    await expect(box).toHaveAttribute('aria-invalid', 'true')
    expect(await shown(page)).toMatchObject({ removed: true })
    const kept = (await page.getByTestId('push-arrow-tip').boundingBox())!
    expect(Math.abs(kept.y - tip.y)).toBeLessThan(2)
    await expect(page.locator('.pp-arrow')).toHaveAttribute('data-tone', 'cut')
    // Enter does nothing while the box does not read
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('push-in-view')).toBeVisible()
    expect(await height(page, id)).toBe(h0)

    // fixed: the error goes, and Enter cuts
    await page.keyboard.press('Backspace')
    await expect(error).toHaveCount(0)
    await expect(box).not.toHaveAttribute('aria-invalid', 'true')
    await page.keyboard.press('Enter')
    await expect.poll(() => height(page, id), { timeout: 30_000 }).toBe(h0 - 4)
    await expect.poll(() => shown(page)).toMatchObject({ added: false, removed: false })
  })

  test('push and pull with the pane open: the panel shows the same error and the last good preview stays', async ({ page }) => {
    test.slow()
    await openStudio(page)
    const id = await framedBox(page)
    await pushOnTop(page, id)
    const panel = toolPanel(page)
    const field = panel.locator('#push-dist')
    await field.fill('3')
    await expect.poll(() => shown(page)).toMatchObject({ added: true })
    await field.fill('3..')
    await expect(panel.getByTestId('op-preview-error')).toContainText('Showing the last good preview.')
    await expect(page.getByTestId('push-view-error')).toContainText('Showing the last good preview.')
    expect(await shown(page)).toMatchObject({ added: true })
    // clearing the box clears the preview and the error
    await field.fill('')
    await expect(panel.getByTestId('op-preview-error')).toHaveCount(0)
    await expect.poll(() => shown(page)).toMatchObject({ added: false, removed: false })
  })

  for (const kind of ['Fillet', 'Chamfer'] as const) {
    test(`${kind.toLowerCase()}: the removed edge is a ghost, and a size the engine refuses keeps the last good preview`, async ({ page }) => {
      test.slow()
      await openStudio(page)
      const id = await framedBox(page, [100, 100])
      await command(page, 'Fillet or chamfer edges')
      const panel = toolPanel(page)
      await expect(panel).toContainText('No edge yet')
      if (kind === 'Chamfer') await panel.getByRole('radio', { name: 'Chamfer' }).click()
      // the top face beside its +X edge picks that edge (as cad.spec.ts picks it); sizes are typed on the keyboard
      const b = await bounds(page, id)
      await pick(page, await facePick(page, id, [0, 0, 1], [b.max[0] - 0.3, (b.min[1] + b.max[1]) / 2, b.max[2]]))
      await expect(panel).toContainText('1 edge')
      const size = panel.locator('#edge-size')
      await size.click()
      await size.press('ControlOrMeta+a')
      await page.keyboard.type('2')
      // a convex edge loses material: only the ghost shows
      await expect.poll(() => shown(page), { timeout: 30_000 }).toMatchObject({ removed: true })
      const verb = panel.getByRole('button', { name: kind === 'Fillet' ? 'Round' : 'Bevel', exact: true })
      await expect(verb).toBeEnabled()

      // far bigger than the box: the engine refuses it, and the 2 mm preview stays with the error in the panel
      await size.press('ControlOrMeta+a')
      await page.keyboard.type('50')
      const error = panel.getByTestId('op-preview-error')
      await expect(error).toContainText('Showing the last good preview.', { timeout: 30_000 })
      expect(await shown(page)).toMatchObject({ removed: true })
      await expect(verb).toBeDisabled()

      // a size that does not read says so, and the preview still stays
      await size.press('ControlOrMeta+a')
      await page.keyboard.type('0')
      await expect(error).toHaveText(`Type a ${kind === 'Fillet' ? 'radius' : 'distance'} above 0 mm. Showing the last good preview.`)
      expect(await shown(page)).toMatchObject({ removed: true })

      // a good size again: the error goes and Enter applies it
      await size.press('ControlOrMeta+a')
      await page.keyboard.type('1')
      await expect(error).toHaveCount(0, { timeout: 30_000 })
      await expect(verb).toBeEnabled()
      await size.press('Enter')
      await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: `${kind} 1 mm`, state: 'done' }])
    })
  }

  test('the preview takes the light studio colors', async ({ page }) => {
    test.slow()
    await openStudio(page, { scheme: 'light', themeFollowsSystem: false })
    const id = await framedBox(page)
    await pushOnTop(page, id)
    await page.keyboard.type('-3')
    await expect.poll(() => shown(page)).toMatchObject({ removed: true })
    const light = (await shown(page)).look
    expect(light.cut).toBe('#d32f2f')
    expect(light.cutFill).toBeLessThan(light.addFill)
  })
})

test.describe('Operation preview on a phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'Phone only')

  test('a cut typed with a finger is a ghost, and a value that does not read keeps it with the error under the value', async ({ page }) => {
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
    const b = await bounds(page, id)
    const [x, y] = await screenOf(page, [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]])
    await page.touchscreen.tap(x, y)
    const input = page.getByTestId('push-view-distance')
    await expect(input).toBeVisible()
    await input.tap()
    await input.fill('-3')
    await expect.poll(() => shown(page)).toMatchObject({ removed: true, added: false })
    await input.fill('-3,,')
    const error = page.getByTestId('push-view-error')
    await expect(error).toHaveText('Type a number, such as 5 or -3. Showing the last good preview.')
    expect(await shown(page)).toMatchObject({ removed: true })
    // the box and its error stay inside the phone's view
    const box = (await page.getByTestId('push-view-box').boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    await input.fill('-3')
    await expect(error).toHaveCount(0)
    await input.press('Enter')
    await expect.poll(() => height(page, id), { timeout: 30_000 }).toBe(h0 - 3)
  })
})
