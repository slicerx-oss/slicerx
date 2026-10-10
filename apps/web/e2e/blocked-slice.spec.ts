// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A slice the engine refuses (a part off the bed) must not leave the last slice's toolpaths on the plate, where they
// would look like the refused slice worked, and nothing from it can be exported.
import { expect, plateReady, sliceCount, sliced, test } from './fixtures'

type Sx = { getState(): { plate: { transform: number[] }[]; slice: { status: string }; preview: unknown }; setState(p: object): void }
type Vp = { stats(): { segments: number } }

test('a refused slice clears the toolpaths of the slice before it', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', sliceLook: 'toolpaths', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  const n = await sliceCount(page)
  await page.getByRole('button', { name: 'Slice plate' }).first().click()
  await expect(sliced(page, n)).toBeVisible({ timeout: 60_000 })
  await expect.poll(() => page.evaluate(() => (window as unknown as { __vp?: Vp }).__vp?.stats().segments ?? 0)).toBeGreaterThan(0)
  // Half a meter to the right, off any bed, with Auto slice on Always so the move slices at once (Auto would hold a
  // plate whose last slice took as long as a test runner's).
  await page.evaluate(() => {
    const sx = (window as unknown as { __sx: Sx }).__sx
    sx.setState({ autoSlice: true, autoSliceBySize: false })
    sx.setState({ plate: sx.getState().plate.map((e) => ({ ...e, transform: e.transform.map((v, i) => (i === 12 ? v + 500 : v)) })) })
  })
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().slice.status), { timeout: 60_000 }).toBe('error')
  expect(await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().preview)).toBeNull()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __vp?: Vp }).__vp?.stats().segments ?? -1)).toBe(0)
  await expect(page.getByRole('button', { name: 'Export G-code' })).toHaveCount(0)
})
