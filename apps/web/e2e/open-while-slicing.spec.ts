// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opening a design over a plate that is still slicing: the slice is for a plate that is gone, so it stops, and the new
// design loads at once instead of waiting for the slicer to finish the old plate.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type FileChooser, type Page } from '@playwright/test'
import { plateReady, pnpmSync } from './fixtures'

type Sx = { getState(): { slice: { status: string; result?: { layerZ: ArrayLike<number> } } }; setState(p: unknown): void }

const root = join(import.meta.dirname, '..', '..', '..')
let starters = ''

test.beforeAll(() => {
  // The starters are made in code; the output never goes in git.
  starters = mkdtempSync(join(tmpdir(), 'sx-starters-'))
  pnpmSync(['--filter', '@slicerx/store', 'exec', 'tsx', '../app/scripts/vault-starters.ts', starters], root)
})

// Every file dialog the page opens, oldest first, intercepted from the start.
const choosers = new WeakMap<Page, FileChooser[]>()

async function open(page: Page): Promise<void> {
  const seen: FileChooser[] = []
  choosers.set(page, seen)
  page.on('filechooser', (c) => seen.push(c))
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    // The test starts the slice itself.
    sessionStorage.setItem('sx-no-auto-slice', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
}

/** Open (Mod+O): a new project with the file. */
async function openFile(page: Page, file: string): Promise<void> {
  const seen = choosers.get(page)!
  const before = seen.length
  await page.keyboard.press('ControlOrMeta+o')
  await expect.poll(() => seen.length, { timeout: 60_000 }).toBe(before + 1)
  await seen[before]!.setFiles(join(starters, file))
}

/** A drop adds the file to the plate. */
async function drop(page: Page, file: string): Promise<void> {
  const bytes = [...readFileSync(join(starters, file))]
  await page.evaluate(({ file, bytes }) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(bytes)], file))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, { file, bytes })
}

const status = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().slice.status)

test('a design opened over a plate that is slicing loads at once, and the old slice stops', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page)
  await openFile(page, 'temperature-tower.sx3mf')
  await expect(page.locator('.obj-name')).toHaveText(['Temperature tower'], { timeout: 60_000 })
  // An edit, so opening asks about unsaved work, and very thin solid layers, so the slice runs well past the open.
  await drop(page, 'calibration-cube-20mm.sx3mf')
  await expect(page.locator('.obj-name', { hasText: '20 mm calibration cube' })).toBeVisible({ timeout: 60_000 })
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ overrides: { layer_height: '0.04', sparse_infill_density: '100%' } }))
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect.poll(() => status(page)).toBe('running')
  await openFile(page, 'cable-clip.sx3mf')
  await page.getByRole('dialog').getByRole('button', { name: "Don't save" }).click()
  const asked = Date.now()
  await expect(page.locator('.obj-name')).toHaveText(['Cable clip'], { timeout: 60_000 })
  const ms = Date.now() - asked
  console.log(`open-while-slicing: the clip loaded ${ms} ms after Don't save`)
  expect(ms).toBeLessThan(5_000)
  // The old plate's slice never lands on the new one.
  await page.waitForTimeout(3000)
  expect(await status(page)).toBe('idle')
  // The slicer is free for the new design, and what it shows is the clip (8 mm tall), not the old 71 mm tower.
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect.poll(() => status(page), { timeout: 120_000 }).toBe('done')
  const top = await page.evaluate(() => { const z = (window as unknown as { __sx: Sx }).__sx.getState().slice.result!.layerZ; return z[z.length - 1] })
  expect(top).toBeLessThan(10)
})
