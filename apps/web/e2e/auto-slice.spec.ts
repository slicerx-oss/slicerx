// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Auto slice: on by default, no Slice button, Print is the action, an edit makes the numbers stale at once and a new slice follows.
import { expect, test } from '@playwright/test'
import { plateReady } from './fixtures'

type Sx = { getState(): { slice: { status: string; stale?: boolean }; autoSlice: boolean; easy: { detail: number } }; setState(p: unknown): void }

test('slices in the background after an edit, and the Slice button returns when Auto slice is off', async ({ page, isMobile }) => {
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
  const state = () => page.evaluate(() => { const s = (window as unknown as { __sx: Sx }).__sx.getState(); return { status: s.slice.status, stale: s.slice.stale ?? false, auto: s.autoSlice } })
  expect((await state()).auto).toBe(true)
  await expect(page.getByRole('button', { name: /^Slice/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Print', exact: true })).toBeVisible()
  // The first slice starts on its own.
  await expect.poll(async () => (await state()).status, { timeout: 120_000 }).toBe('done')
  await expect.poll(async () => (await state()).stale, { timeout: 10_000 }).toBe(false)
  // An edit makes the result stale at once, then a new slice makes it current again.
  await page.evaluate(() => { const st = (window as unknown as { __sx: Sx }).__sx; st.setState({ overrides: { sparse_infill_density: '25%' } }) })
  expect((await state()).status === 'done' ? (await state()).stale : true).toBe(true)
  await expect.poll(async () => { const s = await state(); return s.status === 'done' && !s.stale }, { timeout: 120_000 }).toBe(true)
  // Off: nothing slices on its own and the Slice button shows.
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ autoSlice: false }))
  await expect(page.getByRole('button', { name: /^Slice/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Print', exact: true })).toHaveCount(0)
})
