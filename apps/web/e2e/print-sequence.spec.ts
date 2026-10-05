// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Print by object on a plate arranged by layer: the boxes sit a few millimeters apart, too close for the toolhead, so
// Print is held back with a message that names them. Arranged again by object they are kept the extruder clearance
// apart, the background slice finishes and Print is ready.
import { expect, test } from '@playwright/test'
import { plateReady } from './fixtures'
import { command } from './cad-helpers'

type Sx = {
  getState(): { plate: { id: string }[]; plates: { id: string; settings: Record<string, unknown> }[]; activePlate: string; slice: { status: string; stale?: boolean; message?: string } }
  setState(p: unknown): void
}

test('a plate too close to print by object holds Print back until it is arranged', async ({ page, isMobile }) => {
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
  const state = () => page.evaluate(() => { const s = (window as unknown as { __sx: Sx }).__sx.getState(); return { n: s.plate.length, status: s.slice.status, stale: s.slice.stale ?? false, message: s.slice.message ?? null } })
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  for (const n of [1, 2]) {
    await command(page, 'Add a box')
    await expect.poll(async () => (await state()).n).toBe(n)
  }
  await command(page, 'Arrange all objects')
  await expect.poll(async () => (await state()).n).toBe(2)
  const print = page.getByRole('button', { name: 'Print', exact: true })
  await expect.poll(async () => { const s = await state(); return s.status === 'done' && !s.stale }, { timeout: 120_000 }).toBe(true)
  await expect(print).toBeEnabled()

  // The plate prints by object: the boxes are too close for the toolhead.
  await page.evaluate(() => {
    const st = (window as unknown as { __sx: Sx }).__sx
    const s = st.getState()
    st.setState({ plates: s.plates.map((p) => (p.id === s.activePlate ? { ...p, settings: { ...p.settings, sequence: 'by-object' } } : p)) })
  })
  const alert = page.getByRole('alert').filter({ hasText: 'Printing by object is not safe' })
  await expect(alert.first()).toBeVisible()
  await expect(alert.first()).toContainText(/mm apart; printing by object needs \d+ mm between objects/)
  await expect(print).toBeDisabled()
  await expect.poll(async () => (await state()).message ?? '').toMatch(/^Printing by object is not safe/)

  // Arranged by object, they keep the clearance: the slice runs and Print is ready.
  await command(page, 'Arrange all objects')
  await expect(alert).toHaveCount(0)
  await expect.poll(async () => { const s = await state(); return s.status === 'done' && !s.stale }, { timeout: 120_000 }).toBe(true)
  await expect(print).toBeEnabled()
})
