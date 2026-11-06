// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey: the Bambu Lab H3C, one extruder with nine hotends. With the H3C picked, a person adds a 2.85 mm TPU
// filament and prints one box in it beside a PLA box. The Filament block shows each filament on its tool: the TPU on
// the TPU tool with the line that says why, and the note that the TPU tool's number is not settled. Picking a tool by
// hand reaches the slice, and the slice puts each filament on the tool shown. A filament's chamber temperature over the H3C's
// 65 C is held to 65 C in the Filament dialog and in the slice, and says so. Review pictures with SX_SHOTS=1: the
// Filament block and the Filament dialog's Chamber temperature at 1440 and 390 wide, saved to SX_SHOTS_DIR (test-results/shots by default).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openSheet } from '../fixtures'
import { journey as test } from '../journey'
import { boxOnPlate, calm, command, debugHooks, DESKTOP, patch, startSlice, state } from './lib/slice'
import { shotsDir, shotsOn } from './lib/session'

const H3C = { id: 'e2e-h3c', name: 'Desk H3C', profileId: 'bambu-h3c', vendor: 'Bambu Lab', model: 'H3C', nozzleCount: 9 }
const PHONE = { width: 390, height: 844 }
test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, handPrinters: [H3C], printerId: H3C.id } })
test.skip(({ isMobile }) => isMobile, 'Desktop project; the phone width is checked by resizing below')

test.beforeAll(async ({ app }) => {
  await debugHooks(app)
})

type Sx = {
  getState(): {
    plate: { id: string; handle: { parts: { name: string }[] }; slotOverrides?: Record<string, number> }[]
    plates: { id: string; settings: { hotendMap?: number[] } }[]
    activePlate: string
    overrides: Record<string, unknown>
    profile: { printerId: string; limits: { chamberMaxC?: number } } | null
    slice: { status: string; message?: string; result?: { warnings?: { code: string; message: string }[]; filamentMap?: { nozzles: number[]; auto: boolean } } }
  }
  setState(p: unknown): void
}
const sx = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())

async function shot(page: Page, name: string): Promise<void> {
  if (!shotsOn()) return
  const dir = shotsDir(test.info())
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, name) })
}

/**
 * Resizes the window and waits for the panes to follow. The app turns its side panes into sheets at 900 px and less on
 * a media query change, which the browser reports on a later frame, so right after the resize the old panes are still
 * there. A shut sheet is inert, and a slot in one takes no focus, so a step taken too early finds the wrong panes:
 * openSheet sees no sheet tab yet and opens nothing.
 */
async function resize(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size)
  if (size.width <= 900) await expect(page.locator('.sheet-tab[data-panel="slice-sidebar"]')).toBeAttached()
  else await expect(page.locator('aside.pane.sheet, aside.pane[inert]')).toHaveCount(0)
}

/** Opens the Filament dialog of slot `n` from the rail, as a person does with the keyboard. */
async function filamentDialog(page: Page, n: number) {
  const slot = page.locator(`[data-testid="slice-filament-slot"][data-slot="${n}"]`)
  await slot.focus()
  // A slot in an inert pane (a shut sheet) does not take focus, and the key below would open no menu.
  await expect(slot).toBeFocused()
  await page.keyboard.press('Shift+F10')
  await page.getByTestId('slice-filament-edit').click()
  const dialog = page.getByRole('dialog', { name: new RegExp(`Filament ${n}`) })
  await expect(dialog).toBeVisible()
  return dialog
}

/** Adds filament 2 through the rail and picks Bambu TPU 75A (2.85 mm) for it in the Filament dialog. */
async function addTpu285(page: Page): Promise<void> {
  if ((await page.locator('[data-testid="slice-filament-slot"][data-slot="2"]').count()) === 0) await page.getByTestId('slice-filament-add').first().click()
  const dialog = await filamentDialog(page, 2)
  await dialog.getByLabel('Brand').selectOption('Bambu Lab')
  await dialog.getByLabel('Material').selectOption('TPU')
  await dialog.getByLabel('Product').selectOption({ label: 'Bambu TPU 75A(2.85mm)' })
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

/** Two boxes, the second printed in filament 2. */
async function twoBoxes(page: Page): Promise<void> {
  await boxOnPlate(page)
  await command(page, 'Add a box')
  await expect.poll(async () => (await state(page)).plate.length).toBe(2)
  await page.evaluate(() => {
    const w = window as unknown as { __sx: Sx }
    const s = w.__sx.getState()
    const [a, b] = s.plate
    w.__sx.setState({ plate: [a, { ...b, slotOverrides: Object.fromEntries(b!.handle.parts.map((p) => [p.name, 2])) }] })
  })
}

test('the H3C puts each filament on its tool and keeps 2.85 mm TPU on the TPU tool', async ({ page }) => {
  test.slow()
  await resize(page, DESKTOP)
  await calm(page, 'advanced', { keepPrinter: true })
  await expect.poll(async () => (await sx(page)).profile?.printerId, { timeout: 60_000 }).toBe('bambu-h3c')
  await twoBoxes(page)
  await addTpu285(page)

  // Each filament in use on its tool: PLA on tool 1, the 2.85 mm TPU on tool 8, which no other filament may take.
  const rows = page.locator('.hotend-map')
  await expect(rows).toBeVisible()
  await expect(rows.getByLabel('Tool for filament 1')).toHaveValue('1')
  await expect(rows.getByLabel('Tool for filament 2')).toHaveValue('8')
  await expect(rows.getByLabel('Tool for filament 2')).toBeDisabled()
  await expect(rows.locator('[data-slot="2"]')).toContainText('2.85 mm TPU prints only on the TPU tool')
  const note = page.getByTestId('hotend-tpu-note')
  await expect(note).toContainText('tool 8')
  await expect(note).toContainText('tool 7')
  for (const raw of ['TPU285', 'nozzle_volume', 'tpu_slip']) expect(await rows.innerText()).not.toContain(raw)
  await rows.scrollIntoViewIfNeeded()
  await shot(page, 'h3c-tools-1440.png')

  // A pick by hand: filament 1 on tool 3. The select stays where it was, and the slice prints it there.
  const pick = rows.getByLabel('Tool for filament 1')
  const before = await pick.boundingBox()
  await pick.selectOption('3')
  expect(await pick.boundingBox()).toEqual(before)
  await expect.poll(async () => { const s = await sx(page); return s.plates.find((p) => p.id === s.activePlate)?.settings.hotendMap }).toEqual([3, 8])
  await startSlice(page)
  const done = await sx(page)
  expect(done.slice.status, done.slice.message).toBe('done')
  expect(done.slice.result?.filamentMap).toMatchObject({ nozzles: [2, 7], auto: false })

  // The phone width: the same rows in the slice sheet.
  await resize(page, PHONE)
  await openSheet(page)
  const phoneRows = page.locator('.hotend-map')
  await phoneRows.scrollIntoViewIfNeeded()
  await expect(phoneRows.getByLabel('Tool for filament 2')).toBeVisible()
  await expect(phoneRows.getByLabel('Tool for filament 2')).toHaveValue('8')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await shot(page, 'h3c-tools-390.png')
  await resize(page, DESKTOP)
})

test('the H3C holds a chamber temperature over 65 C to 65 C, in the field and in the slice', async ({ page }) => {
  test.slow()
  await resize(page, DESKTOP)
  await calm(page, 'advanced', { keepPrinter: true })
  await expect.poll(async () => (await sx(page)).profile?.printerId, { timeout: 60_000 }).toBe('bambu-h3c')
  if ((await state(page)).plate.length === 0) await boxOnPlate(page)
  expect((await sx(page)).profile?.limits.chamberMaxC).toBe(65)

  // The filament's Chamber temperature: typing 70 C keeps 65 C, and the line under the field says why.
  let dialog = await filamentDialog(page, 1)
  const field = dialog.getByTestId('slot-chamber')
  await field.fill('70')
  await field.press('Enter')
  await expect(field).toHaveValue('65')
  await expect(dialog).toContainText('This printer heats its chamber to 65 C at most.')
  expect(await dialog.innerText()).not.toContain('chamber_temperature')
  await dialog.locator('#slot-chamber-hint').scrollIntoViewIfNeeded()
  await shot(page, 'h3c-chamber-1440.png')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()

  // A value over the limit that came in another way (a project): the line says what slicing uses, and the slice holds
  // the chamber to 65 C with a warning.
  await patch(page, { overrides: { ...(await sx(page)).overrides, chamber_temperature: [70] } })
  dialog = await filamentDialog(page, 1)
  await expect(dialog.getByTestId('slot-chamber')).toHaveValue('70')
  await expect(dialog).toContainText('70 C is over the 65 C this printer heats its chamber to. Slicing uses 65 C.')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await startSlice(page)
  const hot = await sx(page)
  expect(hot.slice.status, hot.slice.message).toBe('done')
  expect(hot.slice.result?.warnings?.some((w) => w.code === 'safety_limit' && /chamber/.test(w.message) && /65 C/.test(w.message)), JSON.stringify(hot.slice.result?.warnings)).toBe(true)

  // The phone width: the same field and line in the dialog.
  await resize(page, PHONE)
  await openSheet(page)
  dialog = await filamentDialog(page, 1)
  await dialog.locator('#slot-chamber-hint').scrollIntoViewIfNeeded()
  await expect(dialog.getByTestId('slot-chamber')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await shot(page, 'h3c-chamber-390.png')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await patch(page, { overrides: {} })
  await resize(page, DESKTOP)
})
