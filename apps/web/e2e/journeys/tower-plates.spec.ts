// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey: a project's prime tower spot per plate. A project made like Bambu Studio's keeps one wipe_tower_x and
// wipe_tower_y entry for each plate; its three plates hold a two-filament object each, so each needs a tower. Opened,
// the shown plate's tower sits at that plate's own spot as the person switches plates, and each plate slices with its
// tower there (the engine reports it, kept). Review pictures with SX_SHOTS=1: the sliced plate 3 at 1440 and 390 wide,
// saved to SX_SHOTS_DIR (test-results/shots by default).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, sliceCount, sliced, viewSized } from '../fixtures'
import { journey as test } from '../journey'
import { pickPlate } from '../plate-project'
import { TOWER_SPOTS, towerPlatesProject } from '../tower-plates-project'
import { examplePlate, openModel, useFileDialogs } from './lib/model'
import { DESKTOP, calm, debugHooks, patch } from './lib/slice'

const P1S = { id: 'e2e-p1s', name: 'Desk P1S', profileId: 'bambu-p1s', vendor: 'Bambu Lab', model: 'P1S', nozzleCount: 1 }
test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, handPrinters: [P1S], printerId: P1S.id } })
test.skip(({ isMobile }) => isMobile, 'Desktop layout; the phone width is a review picture below')
useFileDialogs()

test.beforeAll(async ({ app }) => {
  await debugHooks(app)
})

type Sx = {
  getState(): {
    plates: { id: string }[]
    activePlate: string
    plateLoading: boolean
    tower: { auto: boolean; x: number; y: number }
    slice: { status: string; stale?: boolean; message?: string; result?: { id: string; primeTower?: { x: number; y: number; reason: string } } }
  }
  setState(p: unknown): void
}

/** The tower the shown plate has, which plate that is (from 1), and how many plates there are. */
const shownTower = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __sx: Sx }).__sx.getState()
    return { plate: s.plates.findIndex((p) => p.id === s.activePlate) + 1, plates: s.plates.length, tower: s.tower }
  })

/** The example plate, then the project through Open, once all three plates are in. */
async function openTowerPlates(page: Page): Promise<void> {
  await calm(page)
  // Starting from the example plate gives Open fresh object ids to tell the new project's from, whatever ran before.
  await examplePlate(page)
  await openModel(page, { name: 'Tower plates.3mf', mimeType: 'model/3mf', buffer: towerPlatesProject() }, { asProject: true })
  await expect.poll(async () => (await shownTower(page)).plates, { timeout: 60_000 }).toBe(3)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plateLoading), { timeout: 60_000 }).toBe(false)
}

/** Slices the shown plate and returns the tower the engine reports for it: a slice that finished after this click, not an earlier one. */
async function sliceShown(page: Page): Promise<{ x: number; y: number; reason: string }> {
  const read = () => page.evaluate(() => { const s = (window as unknown as { __sx: Sx }).__sx.getState().slice; return { status: s.status, stale: s.stale ?? false, id: s.result?.id ?? null, message: s.message } })
  const was = (await read()).id
  const count = await sliceCount(page)
  await page.getByRole('button', { name: 'Slice plate' }).first().click()
  await expect.poll(async () => { const s = await read(); return s.status === 'error' || (s.status === 'done' && !s.stale && s.id !== was) }, { timeout: 150_000 }).toBe(true)
  const end = await read()
  expect(end.status, `the slice ended with ${end.message ?? 'no message'}`).toBe('done')
  await expect(sliced(page, count)).toBeVisible({ timeout: 120_000 })
  const tower = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().slice.result?.primeTower)
  expect(tower, 'a two-filament plate has a prime tower').toBeTruthy()
  return tower!
}

test('each plate of an opened project shows its own prime tower spot', async ({ page }) => {
  test.slow()
  await openTowerPlates(page)
  // Plate 1 is shown first with its entry of the lists, and the spot is kept: automatic placement is off.
  expect(await shownTower(page)).toEqual({ plate: 1, plates: 3, tower: { auto: false, ...TOWER_SPOTS[0] } })
  // Forward through the plates, then back to the first: each plate has its own spot every time it is shown.
  for (const n of [2, 3, 1, 3, 2]) {
    await pickPlate(page, n)
    expect(await shownTower(page), `plate ${n} shows its own tower spot`).toEqual({ plate: n, plates: 3, tower: { auto: false, ...TOWER_SPOTS[n - 1] } })
  }
})

test('each plate slices with its tower at its own spot', async ({ page }, info) => {
  test.slow()
  await openTowerPlates(page)
  for (const n of [1, 2, 3]) {
    if (n > 1) await pickPlate(page, n)
    const spot = TOWER_SPOTS[n - 1]!
    const tower = await sliceShown(page)
    expect(tower.reason, `plate ${n}'s tower is kept where the project put it`).toBe('kept')
    expect(tower.x, `plate ${n} tower x`).toBeCloseTo(spot.x, 0)
    expect(tower.y, `plate ${n} tower y`).toBeCloseTo(spot.y, 0)
  }
  // Review pictures of plate 3 with its tower drawn: the desktop window, then the phone's width.
  if (process.env['SX_SHOTS']) {
    const dir = process.env['SX_SHOTS_DIR'] ?? join(info.project.outputDir, 'shots')
    mkdirSync(dir, { recursive: true })
    const shot = async (width: number, height: number) => {
      await page.setViewportSize({ width, height })
      await viewSized(page)
      await page.mouse.move(0, 0)
      await page.waitForTimeout(900)
      // The test build's own notices (software WebGL, no geometry engine) would cover the view.
      await patch(page, { toast: null })
      await page.evaluate(() => (window as unknown as { __vp: { zoomToBed?(o: unknown): void } }).__vp.zoomToBed?.({ animate: false }))
      await page.waitForTimeout(400)
      await patch(page, { toast: null })
      await page.screenshot({ path: join(dir, `tower-plate-3-${width}.png`) })
    }
    try {
      await shot(1440, 900)
      await shot(390, 844)
    } finally {
      await page.setViewportSize(DESKTOP)
    }
  }
})
