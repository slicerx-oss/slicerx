// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PrinterHost } from '@slicerx/contracts'
import { expect, test } from './fixtures'
import { PRINTERS } from './bridge-brands'
import { hub, logOf, sawToast, sheetFor, start, useBridge } from './bridge-hub'

useBridge(['snapmaker-u1'], async () => {
  await hub.admin.settings.set({ experimentalConnectors: true })
  await PRINTERS['snapmaker-u1'].add()
})

const printerActions = async () => (await logOf('snapmaker-u1')).filter((line) => line !== 'webcams list')

test('U1 planning warns about different material and never uploads or starts', async () => {
  const host = hub.admin as unknown as PrinterHost
  const before = await printerActions()
  const plan = await host.planToolheads!('u1', [{ tool: 0, material: 'ABS', color: '#ffffff' }])
  expect(plan.ready).toBe(false)
  expect(plan.assignments[0]?.status).toBe('choice_required')
  expect(plan.assignments[0]?.materialMismatch).toBe(true)
  expect(plan.requiresConfirmation).toBe(true)
  expect(await printerActions()).toEqual(before)
})

test('U1 cancel sends nothing after a material mismatch is selected', async ({ page }) => {
  test.slow()
  const sheet = await sheetFor(page, 'U1 Bay')
  const before = await printerActions()
  await sheet.locator('#ps-toolhead-0').selectOption('2')
  await expect(sheet.locator('.ps-map-row .ps-row-warn')).toBeVisible()
  await expect(sheet.getByText('Checking toolhead choices', { exact: true })).toBeHidden()
  await sheet.getByRole('switch', { name: "Don't ask when everything matches" }).click()
  await expect(sheet.getByRole('group', { name: 'Choose toolheads' })).toBeVisible()
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).click()
  await sawToast(page, /Nothing was sent/)
  expect(await printerActions()).toEqual(before)
})

test('U1 single-filament send has no mapping question without spool data', async ({ page }) => {
  test.slow()
  const control = async (omitSpoolData: boolean) => {
    const response = await fetch(`http://127.0.0.1:${hub.controlPort}/u1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ omitSpoolData }) })
    expect(response.ok).toBe(true)
  }
  await control(true)
  try {
    const sheet = await sheetFor(page, 'U1 Bay')
    await expect(sheet.getByRole('group', { name: 'Choose toolheads' })).toHaveCount(0)
    const before = await printerActions()
    await sheet.getByRole('button', { name: 'More ways to send' }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Upload only', exact: true }).click()
    await sheet.getByRole('button', { name: 'Upload only', exact: true }).click()
    await sawToast(page, /It has not started/)
    const log = (await printerActions()).slice(before.length)
    expect(log.some((line) => line.startsWith('upload '))).toBe(true)
    expect(log.some((line) => line.startsWith('start ') || line.includes('SET_PRINT_EXTRUDER_MAP'))).toBe(false)
  } finally {
    await control(false)
  }
})

test('U1 upload-only uses the chosen loaded head without starting', async ({ page }) => {
  test.slow()
  const sheet = await sheetFor(page, 'U1 Bay')
  await expect(sheet.getByRole('group', { name: 'Choose toolheads' })).toBeVisible()
  const before = await printerActions()
  await sheet.locator('#ps-toolhead-0').selectOption('4')
  expect(await printerActions()).toEqual(before)
  await sheet.getByRole('button', { name: 'More ways to send' }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Upload only', exact: true }).click()
  await sheet.getByRole('button', { name: 'Upload only', exact: true }).click()
  await sawToast(page, /It has not started/)
  const log = (await printerActions()).slice(before.length)
  expect(log.some((line) => line.startsWith('upload '))).toBe(true)
  expect(log.some((line) => line.startsWith('start ') || line.includes('SET_PRINT_EXTRUDER_MAP'))).toBe(false)
})

test('U1 applies and verifies the map only after the person starts', async ({ page }) => {
  test.slow()
  const sheet = await sheetFor(page, 'U1 Bay')
  await sheet.locator('#ps-toolhead-0').selectOption('4')
  const before = await printerActions()
  await start(sheet)
  await sawToast(page, /started on U1 Bay/, { timeout: 30_000 })
  const log = (await printerActions()).slice(before.length)
  const upload = log.findIndex((line) => line.startsWith('upload '))
  const mapping = log.findIndex((line) => line.includes('SET_PRINT_EXTRUDER_MAP'))
  const started = log.findIndex((line) => line.startsWith('start '))
  expect(upload).toBeGreaterThanOrEqual(0)
  expect(mapping).toBeGreaterThan(upload)
  expect(started).toBeGreaterThan(mapping)
})
