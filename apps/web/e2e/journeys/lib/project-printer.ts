// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Steps the desktop and phone project printer journeys share (project-printer.spec.ts, phone-project-printer.spec.ts):
// a PrusaSlicer project made for another printer opens on the printer the plate is on, its note offers the printer it
// was made for, closing the note keeps the plate where it is, and Switch to moves it there with the project's settings.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { openSheet } from '../../fixtures'
import { openModel } from './model'
import { BAY_1, expect, setState, sidebarAs } from './shell'

const fixtures = join(import.meta.dirname, '..', '..', '..', '..', '..', 'packages')
/** PrusaSlicer 2.9 projects: an MK4 on its input shaper firmware (printer_model MK4IS) and an MK4S, both 0.4 mm. */
export const MK4 = { name: 'mk4--isl--FSL30.3mf', path: join(fixtures, 'core', 'cli', 'tests', 'fixtures', 'prusa-lift', 'mk4--isl--FSL30.3mf') }
export const MK4S = { name: 'prusaslicer-2.9.6.3mf', path: join(fixtures, 'settings', 'fixtures', 'preset-files', 'prusaslicer-2.9.6.3mf') }

type Sx = { __sx: { getState(): { printerId: string | null; profile: { printerId: string; nozzle: number } | null; overrides: Record<string, unknown> } } }
const state = (page: Page) => page.evaluate(() => { const s = (window as unknown as Sx).__sx.getState(); return { printerId: s.printerId, profile: s.profile ? { printerId: s.profile.printerId, nozzle: s.profile.nozzle } : null, overrides: s.overrides } })

/** Opens a project as the job (in place of the plate's objects) and shows the pane its note is in. */
async function open(page: Page, file: { name: string; path: string }): Promise<void> {
  // The notes an earlier open left on the toast card time out first, so the card shows this open's only.
  await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 30_000 })
  await openModel(page, { name: file.name, mimeType: 'model/3mf', buffer: readFileSync(file.path) }, { asProject: true })
  await openSheet(page)
  await expect(page.getByTestId('open-note')).toBeVisible()
}

/** Light and dark shots of the window as it is, when SX_SHOTS_DIR names a folder. */
async function shots(page: Page, name: string): Promise<void> {
  const dir = process.env['SX_SHOTS_DIR']
  if (!dir) return
  const width = page.viewportSize()?.width ?? 0
  for (const scheme of ['dark', 'light'] as const) {
    await setState(page, { scheme, themeFollowsSystem: false })
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(dir, `${name}-${width}-${scheme}.png`) })
  }
  await setState(page, { scheme: 'dark' })
}

/**
 * On Bay 1 (an X1 Carbon): the MK4 project's note names the MK4 and offers it, the plate stays on Bay 1, and closing the
 * note keeps it there. Opened again, Switch to moves the plate to the MK4 profile with the project's settings.
 */
export async function offerKeepOrSwitch(page: Page): Promise<void> {
  await sidebarAs(page, { mode: 'advanced', printer: BAY_1 })
  const printer = page.locator('[data-section="printer"] .printer-name')
  const note = page.getByTestId('open-note')
  const action = page.getByTestId('open-note-action')

  await open(page, MK4)
  const text = page.getByTestId('open-note-text')
  await expect(text).toHaveText(/^Made for a Prusa Research MK4, 0\.4 mm nozzle\. Applied \d+ settings on Bay 1\./)
  // The printer is the point, so the note takes two lines and shows all of it; the file it came from is under Details.
  expect(await text.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
  await page.getByTestId('open-note-details').click()
  await expect(text).toContainText('From mk4--isl--FSL30.3mf.')
  await page.getByTestId('open-note-details').click()
  await expect(action).toHaveText('Switch to MK4 0.4 mm')
  await expect(printer).toContainText('Bay 1')
  await shots(page, 'offer')
  // Closing the note is a no: the plate stays on Bay 1, on its own profile.
  await page.getByTestId('open-note-dismiss').click()
  await expect(note).toHaveCount(0)
  await expect(printer).toContainText('Bay 1')
  expect(await state(page)).toMatchObject({ printerId: BAY_1, profile: { printerId: 'bambu-x1-carbon', nozzle: 0.4 } })

  await open(page, MK4)
  await action.click()
  await expect(note).toContainText(/Switched to MK4 0\.4 mm\. Applied \d+ settings from the project\./)
  await expect(printer).toHaveText('MK4 0.4')
  await expect(action).toHaveText('Change printer')
  // The switch reviews the project's G-code again without saying so twice: one note about it on the card.
  expect(await page.getByTestId('toast').filter({ hasText: 'has its own printer G-code' }).count()).toBeLessThanOrEqual(1)
  const after = await state(page)
  expect(after.profile).toEqual({ printerId: 'prusa-mk4', nozzle: 0.4 })
  // The project's own lift settings came along: its filament travel slope of 30 degrees.
  expect(after.overrides['filament_travel_slope']).toEqual([30])
  await shots(page, 'switched')
}

/** The MK4S project on Bay 1 offers Bay 3, the person's own MK4S, and Switch to moves the plate there. */
export async function switchToOwnPrinter(page: Page): Promise<void> {
  await sidebarAs(page, { mode: 'advanced', printer: BAY_1 })
  await open(page, MK4S)
  await expect(page.getByTestId('open-note-action')).toHaveText('Switch to Bay 3')
  await expect(page.locator('[data-section="printer"] .printer-name')).toContainText('Bay 1')
  await page.getByTestId('open-note-action').click()
  await expect(page.getByTestId('open-note')).toContainText('Switched to Bay 3.')
  await expect(page.locator('[data-section="printer"] .printer-name')).toContainText('Bay 3')
  expect(await state(page)).toMatchObject({ printerId: 'bay-3', profile: { printerId: 'prusa-mk4s', nozzle: 0.4 } })
}
