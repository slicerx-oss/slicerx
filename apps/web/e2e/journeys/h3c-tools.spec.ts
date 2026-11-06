// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey: the Bambu Lab H3C, one extruder with nine hotends. With the H3C picked, a person adds a 2.85 mm TPU
// filament and prints one box in it beside a PLA box. The Filament block shows each filament on its tool: the TPU on
// the TPU tool with the line that says why, and the note that the TPU tool's number is not settled. Picking a tool by
// hand reaches the slice, and the slice puts each filament on the tool shown. A chamber target over the H3C's 65 C is
// held to 65 C in the field and in the slice, and says so. Review pictures with SX_SHOTS=1: the Filament block and the
// Chamber temperature row at 1440 and 390 wide, saved to SX_SHOTS_DIR (test-results/shots by default).
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

/** Adds filament 2 through the rail and picks Bambu TPU 75A (2.85 mm) for it in the Filament dialog. */
async function addTpu285(page: Page): Promise<void> {
  if ((await page.locator('[data-testid="slice-filament-slot"][data-slot="2"]').count()) === 0) await page.getByTestId('slice-filament-add').first().click()
  await page.locator('[data-testid="slice-filament-slot"][data-slot="2"]').focus()
  await page.keyboard.press('Shift+F10')
  await page.getByTestId('slice-filament-edit').click()
  const dialog = page.getByRole('dialog', { name: /Filament 2/ })
  await expect(dialog).toBeVisible()
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

test('the H3C puts each filament on its tool, keeps 2.85 mm TPU on the TPU tool and holds the chamber to 65 C', async ({ page }) => {
  test.slow()
  await page.setViewportSize(DESKTOP)
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
  await expect.poll(async () => (await sx(page)).plates.find((p) => p.id === (await sx(page)).activePlate)?.settings.hotendMap).toEqual([3, 8])
  await startSlice(page)
  const done = await sx(page)
  expect(done.slice.status, done.slice.message).toBe('done')
  expect(done.slice.result?.filamentMap).toMatchObject({ nozzles: [2, 7], auto: false })

  // The chamber: the H3C heats to 65 C at most. Typing 70 C keeps 65 C and says so under the field.
  expect(done.profile?.limits.chamberMaxC).toBe(65)
  await page.locator('#expert-search').fill('Chamber temperature')
  const field = page.locator('#set-chamber_temperature')
  await expect(field).toBeVisible()
  await field.fill('70')
  await field.press('Enter')
  await expect(field).toHaveValue('65')
  const row = page.locator('[data-testid="slice-setting-row"][data-key="chamber_temperature"]')
  await expect(row).toContainText('This printer heats its chamber to 65 C at most.')
  await row.scrollIntoViewIfNeeded()
  await shot(page, 'h3c-chamber-1440.png')

  // A target over the limit that came in some other way (a project): the row says what slicing uses, and the slice
  // holds the chamber to 65 C with a warning.
  await patch(page, { overrides: { ...(await sx(page)).overrides, chamber_temperature: [70] } })
  await expect(row).toContainText('70 C is over the 65 C this printer heats its chamber to. Slicing uses 65 C.')
  await startSlice(page)
  const hot = await sx(page)
  expect(hot.slice.status, hot.slice.message).toBe('done')
  expect(hot.slice.result?.warnings?.some((w) => w.code === 'safety_limit' && /chamber/.test(w.message) && /65 C/.test(w.message)), JSON.stringify(hot.slice.result?.warnings)).toBe(true)

  // The phone width: the same rows in the slice sheet.
  await page.setViewportSize(PHONE)
  await openSheet(page)
  const phoneRows = page.locator('.hotend-map')
  await phoneRows.scrollIntoViewIfNeeded()
  await expect(phoneRows.getByLabel('Tool for filament 2')).toHaveValue('8')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await shot(page, 'h3c-tools-390.png')
  await page.locator('#expert-search').fill('Chamber temperature')
  await page.locator('[data-testid="slice-setting-row"][data-key="chamber_temperature"]').scrollIntoViewIfNeeded()
  await shot(page, 'h3c-chamber-390.png')
  await page.setViewportSize(DESKTOP)
})
