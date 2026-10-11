// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Bambu Studio project carries -1 where Bambu Studio picks the value itself (raft_first_layer_expansion,
// tree_support_wall_count). It opens and slices with the real engine, and a value the engine still refuses is dropped
// with a note instead of blocking the slice. The project is made here: a 20 mm cube and Bambu Studio's settings form.
import { expect, type Page } from '@playwright/test'
import { plateReady, sliceCount, sliced, test } from './fixtures'
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

async function sliceToDone(page: Page): Promise<void> {
  const before = await sliceCount(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(sliced(page, before)).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText(/config key/)).toHaveCount(0)
}

test("a Bambu Studio project's -1 values open and slice with no error", async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page)
  await openProject(page, BAMBU)
  await sliceToDone(page)
})

test('a project value the engine refuses is dropped with a note, and the plate still slices', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page)
  await openProject(page, { ...BAMBU, raft_expansion: '-3' })
  const before = await sliceCount(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(page.getByText(/Setting not imported from a1-mini\.3mf: Raft expansion/)).toBeVisible({ timeout: 120_000 })
  await expect(sliced(page, before)).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText(/config key/)).toHaveCount(0)
})

/** A Bambu Studio project that inherited its walls, with a setting SlicerX does not have. */
const INHERITED = {
  layer_height: '0.2',
  wall_generator: 'classic',
  top_one_wall_type: 'all top',
  different_settings_to_system: ['layer_height', '', ''],
}

type SxState = { setState(p: unknown): void }
/** The store hook (`window.__sx`) is there with localStorage 'slicerx.debug' set. */
const withStoreHook = (page: Page) => page.addInitScript(() => localStorage.setItem('slicerx.debug', '1'))
const setState = (page: Page, patch: unknown) => page.evaluate((p) => (window as unknown as { __sx: SxState }).__sx.setState(p), patch)

test("an opened project's import report shows in Settings > Presets", async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  await withStoreHook(page)
  await open(page)
  await openProject(page, INHERITED)
  await expect(page.getByText(/Settings > Presets lists the 1 setting it did not carry over/)).toBeVisible({ timeout: 30_000 })
  await setState(page, { settingsOpen: true, settingsSection: 'presets' })
  const report = page.locator('.imp-report').filter({ hasText: 'Opened a1-mini.3mf' })
  await expect(report.locator('.imp-sum')).toHaveText(/Opened a1-mini\.3mf: 1 setting did not carry over/)
  await expect(report.locator('.imp-count')).toHaveText(/Project settings, 1 setting did not carry over/)
  await report.locator('summary').click()
  await expect(report.getByText("Walls: aegis walls, kept by SlicerX; the project used its preset's default classic.")).toBeVisible()
})

// Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
test("shots: an opened project's import report, light and dark", async ({ page }, info) => {
  test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
  test.slow()
  const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
  const width = page.viewportSize()?.width ?? 0
  await withStoreHook(page)
  await open(page)
  await openProject(page, INHERITED)
  await setState(page, { settingsOpen: true, settingsSection: 'presets' })
  const report = page.locator('.imp-report').filter({ hasText: 'Opened a1-mini.3mf' })
  await report.locator('summary').click()
  for (const scheme of ['light', 'dark'] as const) {
    await setState(page, { scheme, themeFollowsSystem: false })
    await report.scrollIntoViewIfNeeded()
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
    await page.locator('.settings-dialog').screenshot({ path: `${dir}/project-import-report-${scheme}-${width}.png` })
  }
})
