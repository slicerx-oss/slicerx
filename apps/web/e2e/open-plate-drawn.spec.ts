// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project with several plates opens on plate 1, and the view draws plate 1: the objects the 3D view draws are the
// shown plate's, as the plate picker and the store say. Showing another plate draws that plate, opening the project
// again while plate 2 is shown starts on plate 1 again, and a project with one plate opens as before.
import { expect, type Page, type TestInfo } from '@playwright/test'
import { expectFileDialog } from './file-dialog'
import { test } from './fixtures'
import { openPlateProject, pickPlate, plateProject } from './plate-project'

const PLATES = ['Bambu - Ivory White', 'Charcoal parts']

type Sx = { getState(): { plates: { id: string; objects: { id: string }[] }[]; plate: { id: string }[]; activePlate: string; plateLoading: boolean; viewportBackend: string } }
type Vp = { drawnObjects(): string[] }

/** The objects the view draws now, each plate's objects, and which plate is shown (from 1). */
async function scene(page: Page): Promise<{ drawn: string[]; plates: string[][]; shown: number; loading: boolean }> {
  return page.evaluate(() => {
    const s = (window as unknown as { __sx: Sx }).__sx.getState()
    const vp = (window as unknown as { __vp?: Vp }).__vp
    const plates = s.plates.map((p) => (p.id === s.activePlate ? s.plate : p.objects).map((o) => o.id))
    const known = new Set(plates.flat())
    return { drawn: (vp?.drawnObjects() ?? []).filter((id) => known.has(id)).sort(), plates: plates.map((ids) => [...ids].sort()), shown: s.plates.findIndex((p) => p.id === s.activePlate) + 1, loading: s.plateLoading }
  })
}

/** Waits for the open to finish and a few frames to be drawn, then expects plate `n` shown and drawn. */
async function expectDrawn(page: Page, n: number, snap?: () => Promise<void>): Promise<void> {
  await expect.poll(async () => (await scene(page)).loading, { timeout: 60_000 }).toBe(false)
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r())))))
  // The picture of the view as the open left it, before anything is checked.
  await snap?.()
  const s = await scene(page)
  expect(s.shown).toBe(n)
  expect(s.plates[n - 1]!.length).toBeGreaterThan(0)
  expect(s.drawn, `the view draws plate ${n}'s objects`).toEqual(s.plates[n - 1])
  await expect(page.getByTestId('plate-picker-current').locator('.pp-no')).toHaveText(`Plate ${n}`)
}

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`)
  await page.screenshot({ path })
  await info.attach(name, { path, contentType: 'image/png' })
}

async function on3d(page: Page): Promise<void> {
  // The 2D fallback draws the plate as it is told; the scene hold this checks is the 3D view's.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().viewportBackend), { timeout: 30_000 }).toMatch(/WebGL2|WebGPU/)
}

test('a project with two plates opens on plate 1 and draws plate 1, and each plate shown is the one drawn', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Runs at desktop width')
  await openPlateProject(page, PLATES)
  await on3d(page)
  await expectDrawn(page, 1, () => shot(page, info, 'open-two-plates'))
  await expect(page.getByTestId('plate-picker-current')).toContainText(PLATES[0]!)
  await pickPlate(page, 2)
  await expectDrawn(page, 2)
  await pickPlate(page, 1)
  await expectDrawn(page, 1)
})

test('opening the project again while plate 2 is shown starts on plate 1 and draws it', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Runs at desktop width')
  await openPlateProject(page, PLATES)
  await expectDrawn(page, 1)
  await pickPlate(page, 2)
  await expectDrawn(page, 2)
  const before = (await scene(page)).plates.flat()
  const chooser = await expectFileDialog(page, () => page.keyboard.press('ControlOrMeta+o'))
  await chooser.setFiles({ name: 'Deck box.3mf', mimeType: 'model/3mf', buffer: plateProject(PLATES) })
  // The project opened from another slicer's file was never saved, so the app asks first; it is not kept. If it then
  // asks how to open the file onto a plate with objects, the whole project replaces what is open.
  await page.getByRole('dialog', { name: 'Save changes first?' }).getByRole('button', { name: "Don't save" }).click()
  const whole = page.getByTestId('project-open-as-project')
  await whole.waitFor({ timeout: 5_000 }).then(() => whole.click(), () => undefined)
  // The new open's objects are on both plates (new ids, so this is not the project that was open).
  await expect.poll(async () => (await scene(page)).plates.map((ids) => ids.length > 0 && !ids.some((id) => before.includes(id))), { timeout: 60_000 }).toEqual([true, true])
  await expectDrawn(page, 1, () => shot(page, info, 'reopen-on-plate-two'))
  expect((await scene(page)).plates).toHaveLength(PLATES.length)
})

test('a project with one plate opens and draws it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  await openPlateProject(page, [PLATES[0]!])
  await expectDrawn(page, 1)
  expect((await scene(page)).plates).toHaveLength(1)
})
