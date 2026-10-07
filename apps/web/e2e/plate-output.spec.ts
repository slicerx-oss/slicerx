// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the plate sends to the engine: arranged objects with a brim pass the engine's own bed check, and
// the plate's filament order reaches the G-code of a two-color plate with its prime tower.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Page } from '@playwright/test'
import { command, openStudio } from './cad-helpers'
import { expect, tab, test } from './fixtures'

type Sx = { getState(): { plate: { name: string }[]; slice: { status: string; error?: unknown } }; setState(p: unknown): void }
const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())
const stepFixtures = join(import.meta.dirname, '..', '..', '..', 'packages', 'app', 'test', 'fixtures', 'step')

test.skip(({ isMobile }) => isMobile, 'Runs at desktop width')

async function drop(page: Page, name: string): Promise<void> {
  const bytes = [...readFileSync(join(stepFixtures, name))]
  await page.evaluate(({ name, bytes }) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(bytes)], name, { type: 'application/step' }))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, { name, bytes })
}

async function sliceDone(page: Page): Promise<void> {
  await page.getByRole('main').getByRole('button', { name: /^Slice/ }).first().click()
  await expect
    .poll(async () => {
      const sl = (await state(page)).slice
      return sl.status === 'error' ? JSON.stringify(sl).slice(0, 600) : sl.status
    }, { timeout: 120_000 })
    .toBe('done')
}

test('objects arranged with a brim slice without the bed check blocking them', async ({ page }) => {
  test.slow()
  await openStudio(page)
  // Several objects from one file, then one more: the arrange packs them with their brims.
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  await drop(page, 'assembly.step')
  await expect.poll(async () => (await state(page)).plate.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2)
  const n = (await state(page)).plate.length
  await command(page, 'Add a cylinder')
  await expect.poll(async () => (await state(page)).plate.length).toBe(n + 1)
  const brim = page.locator('#easy-brim')
  await brim.scrollIntoViewIfNeeded()
  if ((await brim.getAttribute('aria-checked')) !== 'true') await brim.click()
  await expect(brim).toHaveAttribute('aria-checked', 'true')
  await command(page, 'Arrange all objects')
  await sliceDone(page)
  await expect(page.getByText(/past the bed|outside the bed|off the bed/i)).toHaveCount(0)
})

/** The tools the first layer changes to, in order, from exported G-code. */
function firstLayerTools(gcode: string): string[] {
  const marks = [...gcode.matchAll(/^;\s*(?:LAYER_CHANGE|CHANGE_LAYER)\b/gm)].map((m) => m.index!)
  if (marks.length < 2) throw new Error(`no layer marks in the G-code (${marks.length})`)
  return [...gcode.slice(marks[0], marks[1]).matchAll(/^\s*(T\d+)\b/gm)].map((m) => m[1]!)
}

test('a two-color plate keeps its prime tower and the filament order reaches the G-code', async ({ page }) => {
  test.slow()
  await page.addInitScript(() => Reflect.deleteProperty(window, 'showSaveFilePicker'))
  await openStudio(page)
  await page.getByRole('button', { name: 'Change', exact: true }).click()
  await page.getByRole('list', { name: 'Choose a printer' }).getByRole('button', { name: /Bay 2/ }).click()
  const exportGcode = async (): Promise<string> => {
    await sliceDone(page)
    await page.locator('.sx-tab', { hasText: 'Preview' }).click()
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export G-code' }).click()])
    const text = readFileSync(await download.path(), 'utf8')
    await tab(page, 'prepare').click()
    return text
  }
  // A box on filament 1 and a cylinder on filament 2: both print on every layer.
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  await command(page, 'Add a box')
  await command(page, 'Add a cylinder')
  await expect.poll(async () => (await state(page)).plate.length).toBe(2)
  const cylinder = page.locator('li.obj').nth(1)
  await cylinder.locator('.obj-h').click()
  await cylinder.getByLabel(/^Filament for /).first().selectOption('2')
  const plain = await exportGcode()
  expect(plain).toMatch(/;\s*(?:TYPE|FEATURE):\s*Prime tower/i)
  const before = firstLayerTools(plain)

  // Slot 1 first by default: the first layer ends on filament 2. Slot 2 first: it ends on filament 1.
  expect(before.at(-1)).toBe('T1')
  await page.getByRole('button', { name: 'Plate settings' }).click()
  const order = page.getByRole('list', { name: 'Filament order' })
  await expect(order).toBeVisible()
  await order.getByRole('button', { name: 'Print slot 2 earlier' }).click()
  await expect(order.locator('li').first()).toContainText('Slot 2')
  await page.getByRole('group', { name: /settings$/ }).getByRole('button', { name: 'Done' }).click()
  const swapped = await exportGcode()
  expect(swapped).toMatch(/;\s*(?:TYPE|FEATURE):\s*Prime tower/i)
  const after = firstLayerTools(swapped)
  expect(after).not.toEqual(before)
  expect(after.at(-1)).toBe('T0')
  expect(after.indexOf('T1')).toBeLessThan(after.lastIndexOf('T0'))
})
