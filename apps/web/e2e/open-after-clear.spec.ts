// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opening a design from another tab, as the Vault's Open does: the app switches to the plate view and opens the design
// as a new project. A plate the person emptied stays empty when the plate view comes back, so the example never returns
// under the design; the untouched example plate is replaced. Neither case asks about unsaved work. (The demo catalog
// has no files to download, so the Vault's own button is covered by test/seed-example.test.ts, through the same
// openModelBytes it calls.)
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type FileChooser, type Page } from '@playwright/test'
import { plateReady, pnpmSync, tab } from './fixtures'

const root = join(import.meta.dirname, '..', '..', '..')
let starters = ''

test.beforeAll(() => {
  // The starters are made in code; the output never goes in git.
  starters = mkdtempSync(join(tmpdir(), 'sx-starters-'))
  pnpmSync(['--filter', '@slicerx/store', 'exec', 'tsx', '../app/scripts/vault-starters.ts', starters], root)
})

// The file dialogs each page opened, oldest first. The listener is on from the start, so every dialog is intercepted.
// Waiting for one only around the key press turns interception on at the same time as the press, and on a busy page
// the press can open the dialog first: it then opens for real, the headless browser cancels it at once, and the press
// looks lost.
const choosers = new WeakMap<Page, FileChooser[]>()

async function open(page: Page): Promise<void> {
  const seen: FileChooser[] = []
  choosers.set(page, seen)
  page.on('filechooser', (c) => seen.push(c))
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
}

/** Open (Mod+O) from wherever the app is: a new project with the file. */
async function openFile(page: Page, file: string): Promise<void> {
  const seen = choosers.get(page)!
  const before = seen.length
  await page.keyboard.press('ControlOrMeta+o')
  await expect.poll(() => seen.length, { timeout: 60_000 }).toBe(before + 1)
  await seen[before]!.setFiles(join(starters, file))
}

const names = (page: Page) => page.locator('.obj-name')

test('an emptied plate stays empty when the plate view comes back, and an opened design lands alone, with no prompt', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page)
  // Delete every object.
  await names(page).first().click()
  await page.keyboard.press('Delete')
  await expect(names(page)).toHaveCount(0)
  // The Vault tab and back: the example does not come back.
  await tab(page, 'feed').click()
  await expect(page.locator('.lib-hero h2')).toBeVisible({ timeout: 60_000 })
  await tab(page, 'prepare').click()
  await expect(page.locator('[data-section="objects"]')).toBeVisible()
  await page.waitForTimeout(3000)
  await expect(names(page)).toHaveCount(0)
  // Open from the Vault tab: the plate view opens with the design alone.
  await tab(page, 'feed').click()
  await openFile(page, 'temperature-tower.sx3mf')
  await expect(names(page)).toHaveText(['Temperature tower'], { timeout: 60_000 })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.waitForTimeout(3000)
  await expect(names(page)).toHaveText(['Temperature tower'])
})

test('the untouched example plate is replaced by an opened design, with no prompt', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page)
  await expect(names(page)).toHaveText(['Layered X'])
  await tab(page, 'feed').click()
  await openFile(page, 'cable-clip.sx3mf')
  await expect(names(page)).toHaveText(['Cable clip'], { timeout: 60_000 })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // A second design replaces the first, still with no prompt: nothing changed in between.
  await openFile(page, 'wall-hook.sx3mf')
  await expect(names(page)).toHaveText(['Wall hook'], { timeout: 60_000 })
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
