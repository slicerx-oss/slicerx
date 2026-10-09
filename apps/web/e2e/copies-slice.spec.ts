// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Four copies of the two-color demo model, arranged: auto slice finishes with an estimate and Print is ready.
import { expect, test } from '@playwright/test'
import { plateReady } from './fixtures'
import { command } from './cad-helpers'

type Sx = { getState(): { plate: unknown[]; slice: { status: string; stale?: boolean; message?: string; result?: { id: string } } } }

test('four arranged copies slice to an estimate', async ({ page, isMobile }) => {
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
  const state = () => page.evaluate(() => { const s = (window as unknown as { __sx: Sx }).__sx.getState(); return { n: s.plate.length, status: s.slice.status, stale: s.slice.stale ?? false, id: s.slice.result?.id ?? null, message: s.slice.message ?? null } })
  await expect.poll(async () => (await state()).status, { timeout: 120_000 }).toBe('done')
  const single = (await state()).id
  await page.locator('.obj-name', { hasText: 'Layered X' }).first().click()
  for (let i = 0; i < 3; i++) await command(page, 'Add an instance of the selected object')
  await command(page, 'Arrange all objects')
  expect((await state()).n).toBe(4)
  // Two filaments, so the plate slices as one: its automatic brim must still be each object's own. Sized for the
  // whole plate it runs off the bed, and the safety preflight blocks the slice. The slice of the four, not the one before.
  await expect.poll(async () => { const s = await state(); return (s.status === 'done' && !s.stale && s.id !== single) || s.status === 'error' }, { timeout: 120_000 }).toBe(true)
  expect((await state()).message).toBeNull()
  await expect(page.getByRole('button', { name: /^Print( on .+)?$/ })).toBeEnabled()
})
