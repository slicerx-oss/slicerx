// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The prime tower's place: auto by default, a hand move turns auto off and the engine keeps the spot, auto snaps it back,
// and a spot off the bed shows a note instead of an error.
import { type Page } from '@playwright/test'
import { expect, plateReady, sliceCount, sliced, tab, test } from './fixtures'

interface Tower { x: number; y: number; width: number; depth: number; reason: string }
type Sx = { getState(): { tower: { auto: boolean; x: number; y: number }; slice: { status: string; result?: { primeTower?: Tower } } } }

async function sliceAgain(page: Page): Promise<Tower> {
  await tab(page, 'prepare').click()
  const slices1 = await sliceCount(page)
  await page.getByRole('main').getByRole('button', { name: /^Slice/ }).first().click()
  await expect(sliced(page, slices1)).toBeVisible({ timeout: 120_000 })
  await tab(page, 'prepare').click()
  return page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().slice.result!.primeTower!)
}

const moveTower = (page: Page, x: number, y: number) =>
  page.evaluate(([x, y]) => {
    const vp = (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp
    // The same events the viewport sends for a click on the tower and a finished drag of it.
    vp.emit('pick', { objectId: 'prime-tower' })
    vp.emit('transform', { id: 'prime-tower', final: true, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1] })
  }, [x, y] as const)

test('the prime tower is automatic, a hand move turns that off, and a spot off the bed gets a note', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced' }))
  })
  await page.goto('./')
  await plateReady(page)
  await page.getByRole('button', { name: 'Change', exact: true }).click()
  await page.getByRole('list', { name: 'Choose a printer' }).getByRole('button', { name: /Bay 2/ }).click()

  const auto = await sliceAgain(page)
  expect(auto.reason).toBe('auto')
  const state = () => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().tower)
  expect(await state()).toMatchObject({ auto: true })
  const toggle = page.locator('#tower-auto')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  // Drag it: auto turns off at once, and the engine keeps the spot.
  await moveTower(page, 190, 30)
  expect(await state()).toEqual({ auto: false, x: 190, y: 30 })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  const kept = await sliceAgain(page)
  expect(kept).toMatchObject({ x: 190, y: 30, reason: 'kept' })

  // Auto on again: the engine picks its own spot.
  await toggle.click()
  expect(await state()).toMatchObject({ auto: true })
  const again = await sliceAgain(page)
  expect(again.reason).toBe('auto')

  // Off the bed: the engine pulls it back and the panel says so. It is a note, not an error.
  await moveTower(page, 400, 400)
  const pulled = await sliceAgain(page)
  expect(pulled.reason).toBe('moved_onto_bed')
  expect(pulled.x + pulled.width).toBeLessThanOrEqual(256.5)
  await expect(page.getByRole('status').filter({ hasText: 'moved the prime tower back onto the bed' })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().slice.status)).toBe('done')
})
