// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// STEP import: a dropped .step file is meshed in its own worker, repaired by the geometry engine, added
// as objects with the names from the file, and slices.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, plateReady, test } from './fixtures'

type Sx = { getState(): { plate: { name: string; parts: { name: string }[] }[]; slice: { status: string; stale?: boolean; result?: { id: string } }; toast: { text: string; kind?: string } | null }; setState(p: unknown): void }

const fixtures = join(import.meta.dirname, '..', '..', '..', 'packages', 'app', 'test', 'fixtures', 'step')

async function drop(page: import('@playwright/test').Page, name: string): Promise<void> {
  const bytes = [...readFileSync(join(fixtures, name))]
  await page.evaluate(({ name, bytes }) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(bytes)], name, { type: 'application/step' }))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, { name, bytes })
}

test('a dropped STEP assembly becomes named objects and slices', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  const state = () => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())

  await drop(page, 'assembly.step')
  await expect(page.locator('.obj-name', { hasText: 'assembly' })).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.obj-name', { hasText: 'cube' })).toBeVisible()
  const plate = (await state()).plate
  expect(plate.find((p) => p.name === 'assembly')?.parts.map((p) => p.name)).toEqual(['assembly base', 'assembly post'])

  // An inch file arrives at its real size, and the toast says it was converted.
  await drop(page, 'bracket-inch.stp')
  await expect(page.locator('.obj-name', { hasText: 'bracket-inch' })).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => (await state()).toast?.text ?? '').toMatch(/Converted from inches to millimeters/)

  // A file with nothing in it is refused in words and adds nothing.
  const before = (await state()).plate.length
  await drop(page, 'empty.step')
  await expect.poll(async () => (await state()).toast?.text ?? '', { timeout: 60_000 }).toMatch(/empty\.step has no solids/)
  expect((await state()).plate.length).toBe(before)

  // Slice a STEP part on its own, centered by the import. (Arranging several objects can leave a brim
  // past the bed edge, which the safety preflight blocks; that is the arrange's business, not STEP's.)
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  await drop(page, 'bracket-inch.stp')
  await expect.poll(async () => (await state()).plate.length, { timeout: 60_000 }).toBe(1)
  // The slice of the bracket, not the earlier one of the assembly: done, current and with a new id. An error shows its
  // message in the failure.
  const earlier = (await state()).slice.result?.id ?? null
  await page.getByRole('main').getByRole('button', { name: /^Slice/ }).click()
  await expect.poll(async () => { const sl = (await state()).slice as { status: string; stale?: boolean; error?: unknown; result?: { id: string } }; if (sl.status === 'error') return JSON.stringify(sl).slice(0, 400); return sl.status === 'done' && !sl.stale && sl.result?.id !== earlier ? 'done' : sl.status }, { timeout: 120_000 }).toBe('done')
})
