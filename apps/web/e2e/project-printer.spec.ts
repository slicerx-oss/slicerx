// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Bambu Studio P1S 0.2 project opens as its own printer, as Bambu Studio opens it: no question on an empty plate, the
// P1S 0.2 profile, and the project's own start G-code in the slice. Moving the plate to the person's A1 mini takes the
// A1 mini's G-code (none of the project's M290 or M500) and says which settings stayed behind. Added to a plate that
// has objects, the project asks first. The project is made here: a 20 mm cube and Bambu Studio's settings form.
import { readFileSync } from 'node:fs'
import { expect, type Page } from '@playwright/test'
import { plateReady, tab, test } from './fixtures'
import { projectZip } from './project-zip'

const START = 'G28\nM290 Z0.02 ; baby step from the project\nM500\nG1 Z5 F3000\n'

const P1S = {
  printer_settings_id: 'Bambu Lab P1S 0.2 nozzle',
  printer_model: 'Bambu Lab P1S',
  printer_variant: '0.2',
  nozzle_diameter: ['0.2'],
  layer_height: '0.08',
  wall_loops: '3',
  different_settings_to_system: ['layer_height;wall_loops', '', ''],
  machine_start_gcode: START,
}

const A1_MINI = { id: 'e2e-a1-mini', name: 'Desk A1 mini', profileId: 'bambu-a1-mini', vendor: 'Bambu Lab', model: 'A1 mini', nozzleCount: 1 }

async function open(page: Page): Promise<void> {
  await page.addInitScript((a1) => {
    Reflect.deleteProperty(window, 'showSaveFilePicker')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, handPrinters: [a1], printerId: a1.id }))
  }, A1_MINI)
  await page.goto('./')
  await plateReady(page)
  await expect(page.locator('[data-section="printer"] .printer-name')).toContainText('A1 mini')
}

/** Picks the file in the dialog that `key` opens: Mod+O opens a new project, Mod+I adds to the plate. */
async function choose(page: Page, open: () => Promise<void>, settings: Record<string, unknown>): Promise<void> {
  await expect(async () => {
    const chooser = page.waitForEvent('filechooser', { timeout: 5_000 })
    await open()
    await (await chooser).setFiles({ name: 'keychain.3mf', mimeType: 'model/3mf', buffer: projectZip(settings, {}, [118, 118]) })
  }).toPass({ timeout: 60_000 })
}

async function sliceAndExport(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(page.locator('.sx-tab[aria-current=page]')).toContainText('Preview', { timeout: 120_000 })
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('Export G-code')
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.sx-palette-item', { hasText: /^Export G-code/ }).first().click()])
  return readFileSync(await download.path(), 'utf8')
}

test('a P1S 0.2 project opens as its own printer, and the A1 mini slices it with its own G-code', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page)
  await choose(page, () => page.keyboard.press('ControlOrMeta+o'), P1S)
  await expect(page.locator('.obj-name')).toHaveText(['Cube'], { timeout: 60_000 })
  // Toasts stack; the note is the one that names the printer.
  await expect(page.getByTestId('toast').filter({ hasText: 'Opened as P1S' })).toContainText('Opened as P1S 0.2 mm from the project.')
  await expect(page.locator('[data-section="printer"] .printer-name')).toContainText('P1S 0.2 from keychain.3mf')
  await expect(page.getByTestId('project-gcode-dialog')).toHaveCount(0)
  const own = await sliceAndExport(page)
  expect(own).toContain('M290 Z0.02 ; baby step from the project')
  expect(own).toMatch(/^; layer_height = 0\.08$/m)
  // The person's A1 mini, from the note's Change printer.
  await tab(page, 'prepare').click()
  await page.locator('[data-section="printer"]').getByRole('button', { name: 'Change' }).click()
  await page.locator('[data-section="printer"] ul.choose').getByRole('button', { name: /Desk A1 mini/ }).click()
  await expect(page.getByTestId('toast').filter({ hasText: 'Slicing for the A1 mini' })).toContainText("Slicing for the A1 mini with its own G-code. Not carried over, made for the project's 0.2 mm nozzle: layer height.")
  const theirs = await sliceAndExport(page)
  expect(theirs).not.toContain('baby step from the project')
  expect(theirs).not.toMatch(/^M500/m)
  expect(theirs).not.toMatch(/^; layer_height = 0\.08$/m)
  expect(theirs).toMatch(/^; wall_loops = 3$/m)
})

test('a project added to a plate with objects asks, and geometry only keeps the printer', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page)
  await choose(page, () => page.getByTestId('objects-add-model').click(), P1S)
  const dialog = page.getByTestId('project-open-dialog')
  await expect(dialog).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('project-open-as-project')).toBeVisible()
  await page.getByTestId('project-open-geometry-only').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.obj-name')).toHaveText(['Layered X', 'Cube'], { timeout: 60_000 })
  await expect(page.locator('[data-section="printer"] .printer-name')).toContainText('A1 mini')
})
