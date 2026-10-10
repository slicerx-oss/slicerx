// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Auto slice: on by default, no Slice button, Print is the action, an edit makes the numbers stale at once and a new slice follows.
import { expect, test } from '@playwright/test'
import { plateReady } from './fixtures'

type Sx = { getState(): { slice: { status: string; stale?: boolean; result?: { id: string } }; autoSlice: boolean; easy: { detail: number } }; setState(p: unknown): void }

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
  const state = () => page.evaluate(() => { const s = (window as unknown as { __sx: Sx }).__sx.getState(); return { status: s.slice.status, stale: s.slice.stale ?? false, id: s.slice.result?.id ?? null, auto: s.autoSlice } })
  expect((await state()).auto).toBe(true)
  await expect(page.getByRole('main').getByRole('button', { name: /^Slice/ })).toHaveCount(0)
  // The first slice starts on its own. Its progress has the button's place while it runs; then Print is the action.
  await expect.poll(async () => (await state()).status, { timeout: 120_000 }).toBe('done')
  await expect.poll(async () => (await state()).stale, { timeout: 10_000 }).toBe(false)
  await expect(page.getByRole('button', { name: 'Print', exact: true })).toBeVisible()
  // An edit makes the result stale at once, then a new slice (a new id) makes it current again.
  const first = (await state()).id
  // Read in the same turn as the edit, before the new slice can start: a later read can find that slice running.
  const after = await page.evaluate(() => {
    const st = (window as unknown as { __sx: Sx }).__sx
    st.setState({ overrides: { sparse_infill_density: '25%' } })
    const sl = st.getState().slice
    return { status: sl.status, stale: sl.stale ?? false }
  })
  expect(after).toEqual({ status: 'done', stale: true })
  await expect.poll(async () => { const s = await state(); return s.status === 'done' && !s.stale && s.id !== first }, { timeout: 120_000 }).toBe(true)
  // Off: nothing slices on its own and a Slice button shows. The current slice keeps Print, with Slice again under it.
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ autoSlice: false }))
  await expect(page.getByRole('main').getByRole('button', { name: /^Slice/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Print', exact: true })).toBeVisible()
})
