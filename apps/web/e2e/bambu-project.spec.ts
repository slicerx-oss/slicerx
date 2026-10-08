// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Bambu Studio project carries -1 where Bambu Studio picks the value itself (raft_first_layer_expansion,
// tree_support_wall_count). It opens and slices with the real engine, and a value the engine still refuses is dropped
// with a note instead of blocking the slice. The project is made here: a 20 mm cube and Bambu Studio's settings form.
import { expect, type Page } from '@playwright/test'
import { plateReady, test } from './fixtures'
import { projectZip } from './project-zip'

/** Bambu Studio's -1s as it writes them (every value a string), with a raft and supports on so they are used. */
const BAMBU = {
  enable_support: '1',
  raft_layers: '2',
  raft_first_layer_expansion: '-1',
  tree_support_wall_count: '-1',
  support_interface_bottom_layers: '-1',
  prime_tower_brim_width: '-1',
  ironing_fan_speed: ['-1'],
  filament_ramming_volumetric_speed: ['-1'],
  filament_tower_interface_print_temp: ['-1'],
}

async function open(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
}

/** Open (Mod+O) the project: a new project with the file, so its settings come along. */
async function openProject(page: Page, settings: Record<string, unknown>): Promise<void> {
  const buffer = projectZip(settings)
  await expect(async () => {
    const chooser = page.waitForEvent('filechooser', { timeout: 5_000 })
    await page.keyboard.press('ControlOrMeta+o')
    await (await chooser).setFiles({ name: 'a1-mini.3mf', mimeType: 'model/3mf', buffer })
  }).toPass({ timeout: 60_000 })
  await expect(page.locator('.obj-name')).toHaveText(['Cube'], { timeout: 60_000 })
}

async function sliceToPreview(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(page.locator('.sx-tab[aria-current=page]')).toContainText('Preview', { timeout: 120_000 })
  await expect(page.getByText(/config key/)).toHaveCount(0)
}

test("a Bambu Studio project's -1 values open and slice with no error", async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page)
  await openProject(page, BAMBU)
  await sliceToPreview(page)
})

test('a project value the engine refuses is dropped with a note, and the plate still slices', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page)
  await openProject(page, { ...BAMBU, raft_expansion: '-3' })
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(page.getByText(/Setting not imported from a1-mini\.3mf: Raft expansion/)).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.sx-tab[aria-current=page]')).toContainText('Preview', { timeout: 120_000 })
  await expect(page.getByText(/config key/)).toHaveCount(0)
})
