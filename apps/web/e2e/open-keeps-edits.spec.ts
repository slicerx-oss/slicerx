// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An edit made while a project opens is kept: the open marks only its own changes saved, so the next open asks about
// the edit. The edit lands the moment the opened object appears, before the project's settings are applied, which a
// real drop cannot be timed to do; the app's store hook makes it, the way a drop adds its model.
import { expect, type Page } from '@playwright/test'
import { plateReady, test } from './fixtures'
import { projectZip } from './project-zip'

type Store = {
  getState(): { plate: { id: string; name: string }[] }
  setState(p: unknown): void
  subscribe(fn: (s: { plate: { id: string; name: string }[] }) => void): () => void
}

async function open(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
}

/** Open (Mod+O) a project file: a 20 mm cube with print settings, which are applied after the cube appears. */
async function openProject(page: Page, name: string): Promise<void> {
  await expect(async () => {
    const chooser = page.waitForEvent('filechooser', { timeout: 5_000 })
    await page.keyboard.press('ControlOrMeta+o')
    await (await chooser).setFiles({ name, mimeType: 'model/3mf', buffer: projectZip({ layer_height: '0.16', wall_loops: '3' }) })
  }).toPass({ timeout: 60_000 })
}

test('a model added while a project opens stays, and the next open asks to save first', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page)
  // As soon as the opened cube shows, a second model lands, between the open's own steps.
  await page.evaluate(() => {
    const sx = (window as unknown as { __sx: Store }).__sx
    const stop = sx.subscribe((s) => {
      const cube = s.plate.find((p) => p.name === 'Cube')
      if (!cube) return
      stop()
      queueMicrotask(() => sx.setState({ plate: [...sx.getState().plate, { ...cube, id: 'dropped', name: 'Dropped cube' }] }))
    })
  })
  await openProject(page, 'first.3mf')
  await expect(page.locator('.obj-name')).toHaveText(['Cube', 'Dropped cube'], { timeout: 60_000 })
  // The next open asks, and Cancel keeps both.
  await openProject(page, 'second.3mf')
  await expect(page.getByTestId('unsaved-dialog')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('unsaved-cancel').click()
  await expect(page.locator('.obj-name')).toHaveText(['Cube', 'Dropped cube'])
})

test('a project opened on its own opens the next one with no question', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page)
  await openProject(page, 'first.3mf')
  await expect(page.locator('.obj-name')).toHaveText(['Cube'], { timeout: 60_000 })
  await openProject(page, 'second.3mf')
  await expect(page.locator('.obj-name')).toHaveText(['Cube'], { timeout: 60_000 })
  await expect(page.getByTestId('unsaved-dialog')).toHaveCount(0)
})
