// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Look and feel > Frame the view: Always frames each new pick in Model, On open and add leaves the camera
// where it is when the selection changes.
import { type Page } from '@playwright/test'
import { command, openStudio } from './cad-helpers'
import { expect, test } from './fixtures'

type Sx = { getState(): { plate: { id: string }[]; appearance: { modelFraming: string } }; setState(p: unknown): void }
const camera = (page: Page) =>
  page.evaluate(() => {
    const p = (window as unknown as { __vp: { camera: { position: { x: number; y: number; z: number } } } }).__vp.camera.position
    return [p.x, p.y, p.z].map((v) => Math.round(v * 10) / 10)
  })
const pickObject = (page: Page, id: string) => page.evaluate((i) => (window as unknown as { __sx: Sx }).__sx.setState({ selection: i, selectedIds: [i] }), id)
/** Whether the camera is in an eased move (a framing runs 520 ms, stepped only on drawn frames). */
const easing = (page: Page) => page.evaluate(() => (window as unknown as { __vp: { rig?: { move: unknown } } }).__vp.rig?.move != null)
/** The camera once it has stopped moving: no eased move left, and the same position on two reads in a row. */
async function settled(page: Page): Promise<number[]> {
  // a framing starts on the next frame, so give it time to begin before reading
  await page.waitForTimeout(300)
  let last: number[] = []
  await expect
    .poll(async () => {
      const now = await camera(page)
      const still = !(await easing(page)) && now.join() === last.join()
      last = now
      return still
    }, { intervals: [250], timeout: 10_000 })
    .toBe(true)
  return last
}

test('Frame the view: Always frames each pick, On open and add keeps the camera still', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await page.setViewportSize({ width: 1440, height: 900 })
  await openStudio(page)
  await page.locator('.sx-tab[data-mode="design"]').click()
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  await command(page, 'Add a box')
  await command(page, 'Add a box')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate.length)).toBe(2)
  const [a, b] = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate.map((e) => e.id))
  expect(await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().appearance.modelFraming)).toBe('selection')

  await pickObject(page, a!)
  const onA = await settled(page)
  await pickObject(page, b!)
  const onB = await settled(page)
  expect(onB).not.toEqual(onA)

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Look and feel' }).click()
  const row = dialog.getByTestId('set-model-framing')
  await expect(row).toContainText('each time it changes')
  await row.getByRole('radio', { name: 'On open and add' }).click()
  await expect(row).toContainText('Picking leaves the camera where it is')
  expect(await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().appearance.modelFraming)).toBe('open')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  await pickObject(page, a!)
  expect(await settled(page)).toEqual(onB)
})
