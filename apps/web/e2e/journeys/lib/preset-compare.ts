// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Steps for the Compare presets journey: two saved process presets that differ in a few settings, Settings > Presets,
// and the pickers of the Compare section.
import { type Locator, type Page } from '@playwright/test'
import { closeSheet, expect } from '../../fixtures'

export const DRAFT = 'Draft fast 0.28'
export const FINE = 'Fine detail 0.12'
/** A name of 78 characters, longer than the status line has room for at any width. */
export const LONG = 'Draft fast 0.28 for the workshop Voron with the hardened 0.6 mm nozzle and PEI'

const preset = (id: string, name: string, values: Record<string, unknown>) => ({ id, kind: 'process', name, values, createdAt: 1, updatedAt: 1 })
/** Seven settings differ; Raft layers is 1 on Draft, so the row reads "1 layer". */
export const PRESETS = [
  preset('e2e-cmp-draft', DRAFT, { layer_height: 0.28, raft_layers: 1, outer_wall_speed: 200, wall_loops: 2, sparse_infill_density: '10%', top_shell_layers: 3, bottom_shell_layers: 2 }),
  preset('e2e-cmp-fine', FINE, { layer_height: 0.12, raft_layers: 2, outer_wall_speed: 60, wall_loops: 4, sparse_infill_density: '25%', top_shell_layers: 7, bottom_shell_layers: 5 }),
  preset('e2e-cmp-long', LONG, { layer_height: 0.28, raft_layers: 1, outer_wall_speed: 200, wall_loops: 2 }),
]

/** Puts the two presets in the browser's preset store, which Settings > Presets reads when it opens. */
export async function seedPresets(page: Page): Promise<void> {
  await page.evaluate(
    (rows) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('slicerx-presets', 1)
        req.onupgradeneeded = () => req.result.createObjectStore('presets', { keyPath: 'id' })
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const tx = req.result.transaction('presets', 'readwrite')
          for (const r of rows) tx.objectStore('presets').put(r)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        }
      }),
    PRESETS,
  )
}

/** Opens Settings > Presets (shutting a phone's sheet first) and returns the dialog. */
export async function openPresets(page: Page): Promise<Locator> {
  for (let i = 0; i < 2; i++) await page.keyboard.press('Escape')
  await closeSheet(page).catch(() => undefined)
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByTestId('settings-nav-presets').click()
  return dialog
}

/** Compares Draft with Fine in the open dialog; `all` turns Show all on. */
export async function compareDraftFine(dialog: Locator, all = false): Promise<void> {
  await dialog.locator('#cmp-a').scrollIntoViewIfNeeded()
  await dialog.locator('#cmp-a').selectOption('e2e-cmp-draft')
  await dialog.locator('#cmp-b').selectOption('preset:e2e-cmp-fine')
  await expect(dialog.getByTestId('preset-compare-row').first()).toBeVisible()
  if (all) await dialog.getByTestId('preset-compare-all').click()
}

/** Compares the preset with the long name with Fine in the open dialog. */
export async function compareLongFine(dialog: Locator): Promise<void> {
  await dialog.locator('#cmp-a').scrollIntoViewIfNeeded()
  await dialog.locator('#cmp-a').selectOption('e2e-cmp-long')
  await dialog.locator('#cmp-b').selectOption('preset:e2e-cmp-fine')
  await expect(dialog.getByTestId('preset-compare-row').first()).toBeVisible()
}

/** Closes the Settings dialog. */
export async function shutSettings(page: Page): Promise<void> {
  const settings = page.getByRole('dialog', { name: 'Settings' })
  for (let i = 0; i < 3 && (await settings.count()); i++) await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
}
