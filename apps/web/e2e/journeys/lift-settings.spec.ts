// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The lift settings a person edits by hand: Z hop type in Printer settings and a filament's own travel slope in the
// Filament dialog. Both show plain labels, change nothing above them when set, and reach the slice request the app sends
// to the slicer; the filament's slope comes back when the saved project is opened again. The same steps run again at
// phone width.
import { readFileSync } from 'node:fs'
import type { Page, Request } from '@playwright/test'
import { addMenu, openSheet } from '../fixtures'
import { openModel } from './lib/model'
import { BAY_1, expect, setState, sidebarAs, sidebarDone, sliceNow, test } from './lib/shell'

const PHONE = { width: 390, height: 844 }

type Store = { __sx: { getState(): { overrides: Record<string, unknown>; slice: { status: string } } } }
const overrides = (page: Page) => page.evaluate(() => (window as unknown as Store).__sx.getState().overrides)

async function printerDialog(page: Page) {
  await page.getByTestId('slice-machine-printer').click()
  await page.getByTestId('slice-machine-printer-settings').click()
  const dialog = page.getByRole('dialog', { name: /Printer settings/ })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('radio', { name: 'Extruder and retraction' }).click()
  return dialog
}

async function filamentDialog(page: Page) {
  await page.locator('[data-testid="slice-filament-slot"][data-slot="1"]').focus()
  await page.keyboard.press('Shift+F10')
  await page.getByTestId('slice-filament-edit').click()
  const dialog = page.getByRole('dialog', { name: /Filament 1/ })
  await expect(dialog).toBeVisible()
  return dialog
}

/** Picks Ramp as the Z hop type and checks the row: plain labels only, the select stays put, the hint shows below. */
async function setRamp(page: Page): Promise<void> {
  const dialog = await printerDialog(page)
  const height = dialog.getByLabel(/^Z hop height/)
  await expect(height).toBeVisible()
  if (Number(await height.inputValue()) <= 0) {
    await height.fill('0.4')
    await height.press('Enter')
  }
  const select = dialog.getByLabel('Z hop type', { exact: true })
  await select.scrollIntoViewIfNeeded()
  const before = await select.boundingBox()
  await select.selectOption('Ramp Lift')
  await expect(select).toHaveValue('Ramp Lift')
  await expect(dialog.locator('li[data-key="z_hop_types"] .sx-select-face')).toHaveText('Ramp')
  await expect(dialog.getByText('Ramp is written as Slope when you export for Bambu Studio or OrcaSlicer.')).toBeVisible()
  expect(await select.boundingBox()).toEqual(before)
  // Plain labels: no stored values or setting keys anywhere in the dialog.
  const text = await dialog.innerText()
  for (const raw of ['Ramp Lift', 'Slope Lift', 'z_hop_types']) expect(text).not.toContain(raw)
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

/** Types 15 into the filament's Travel slope and checks the field: the body font with tabular figures, the hint. */
async function setSlope(page: Page): Promise<void> {
  const dialog = await filamentDialog(page)
  const field = dialog.getByLabel(/^Travel slope/)
  await field.scrollIntoViewIfNeeded()
  await expect(field).toBeInViewport()
  await expect(field).toHaveAttribute('placeholder', 'Printer value')
  await expect(dialog.getByText(/^Uses the printer's travel slope, \d+(\.\d+)?°\./)).toBeVisible()
  const before = await field.boundingBox()
  await field.fill('15')
  await field.press('Enter')
  await expect(dialog.getByText('Climbs at 15° for this filament.')).toBeVisible()
  expect(await field.boundingBox()).toEqual(before)
  const style = await field.evaluate((el) => {
    const probe = document.createElement('span')
    probe.style.fontFamily = 'var(--f-body)'
    document.body.append(probe)
    const body = getComputedStyle(probe).fontFamily
    probe.remove()
    const cs = getComputedStyle(el)
    return { font: cs.fontFamily, body, numeric: cs.fontVariantNumeric }
  })
  expect(style.font).toBe(style.body)
  expect(style.numeric).toContain('tabular-nums')
  // Nothing in the dialog runs off its side, and the page never scrolls sideways.
  const sideways = await dialog.evaluate((el) => {
    const doc = document.scrollingElement!
    const boxes = [el, ...el.querySelectorAll('*')].filter((n) => (n as HTMLElement).scrollWidth > (n as HTMLElement).clientWidth + 1 && getComputedStyle(n).overflowX !== 'visible')
    return { page: doc.scrollWidth > doc.clientWidth + 1, boxes: boxes.length }
  })
  expect(sideways).toEqual({ page: false, boxes: 0 })
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

/** Slices and reads the config of the request the app sent to the slicer. */
async function slicedConfig(page: Page, requests: string[]): Promise<Record<string, unknown>> {
  const before = requests.length
  await sliceNow(page)
  await expect.poll(() => requests.length).toBeGreaterThan(before)
  return (JSON.parse(requests.at(-1)!) as { config: Record<string, unknown> }).config
}

/** Saves the project as a download: headless Chromium has no save dialog, so the app falls back to one. */
async function saveProject(page: Page): Promise<Buffer> {
  await page.evaluate(() => Reflect.deleteProperty(window, 'showSaveFilePicker'))
  await addMenu(page, 'Export')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Save project/ }).click()])
  return readFileSync(await download.path())
}

/**
 * After a save and an open: the filament's travel slope comes back from the project. Printer settings do not, since a
 * project opens on the printer the person has (its printer values stay in the file), so Z hop type is left out here.
 */
async function checkKept(page: Page): Promise<void> {
  const kept = await overrides(page)
  // The project file writes the slope as text; the app reads either.
  expect(Number((kept['filament_travel_slope'] as unknown[])[0])).toBe(15)
  const filament = await filamentDialog(page)
  await expect(filament.getByLabel(/^Travel slope/)).toHaveValue('15')
  await expect(filament.getByText('Climbs at 15° for this filament.')).toBeVisible()
  await filament.getByRole('button', { name: 'Done', exact: true }).click()
}

test.describe('lift settings', () => {
  test('Z hop type and a filament travel slope reach the slice, the slope survives a save and reopen, on a desktop and a phone', async ({ page }) => {
    test.slow()
    const requests: string[] = []
    const capture = (r: Request) => {
      if (r.method() === 'POST' && /\/slices\//.test(r.url())) requests.push(r.postData() ?? '')
    }
    page.on('request', capture)
    const home = page.viewportSize()!
    try {
      for (const size of [home, PHONE]) {
        await page.setViewportSize(size)
        await sidebarAs(page, { mode: 'advanced', printer: BAY_1 })
        await setState(page, { overrides: {} })
        await setRamp(page)
        await setSlope(page)
        const config = await slicedConfig(page, requests)
        // One Ramp per extruder, and filament 1's own slope with any other filament left on the printer's value.
        const types = config['z_hop_types'] as string[]
        expect(types.length).toBeGreaterThan(0)
        expect(new Set(types)).toEqual(new Set(['Ramp Lift']))
        const slopes = config['filament_travel_slope'] as unknown[]
        expect(slopes[0]).toBe(15)
        expect(slopes.slice(1).every((v) => v === 'nil')).toBe(true)
        // Save, reload the app, and open the saved project: the filament's slope comes back from the file.
        const saved = await saveProject(page)
        await page.reload()
        await setState(page, { settingsMode: 'advanced' })
        await openModel(page, { name: 'lift.sx3mf', mimeType: 'application/octet-stream', buffer: saved }, { asProject: true })
        await openSheet(page)
        await checkKept(page)
        await sidebarDone(page)
      }
    } finally {
      page.off('request', capture)
      await setState(page, { overrides: {}, printerSettingsOpen: false, slotDialog: null })
      await page.setViewportSize(home)
    }
  })
})
