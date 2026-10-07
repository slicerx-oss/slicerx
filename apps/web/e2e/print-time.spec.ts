// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One print time everywhere: the Model estimate, the Preview summary, the playback bar and the send sheet all show
// the figure the slice states, so the bar ends where the estimate says and the summary rows add up to it.
import { expect, plateReady, sliceCount, sliced, tab, test } from './fixtures'

/** The estimate's figure as the app words it (42m, 1h 05m is shown as 1h 5m). */
const worded = (s: number): string => {
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return h === 0 ? `${m}m` : `${h}h ${m}m`
}

/** 41:44 for short prints, 1:05:09 for long ones. */
const clocked = (s: number): string => {
  const t = Math.round(s)
  const h = Math.floor(t / 3600)
  const two = (v: number) => String(v).padStart(2, '0')
  return h > 0 ? `${h}:${two(Math.floor((t % 3600) / 60))}:${two(t % 60)}` : `${Math.floor(t / 60)}:${two(t % 60)}`
}

test('the estimate, the summary, the playback bar and the send sheet show one print time', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop layout')
  test.slow()
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  const slices1 = await sliceCount(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(sliced(page, slices1)).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole('group', { name: 'Layers and moves' })).toBeVisible()

  const stats = await page.evaluate(() => {
    const s = (window as unknown as { __sx: { getState(): { slice: { status: string; result: { stats: { timeS: number; prepareS?: number } } } } } }).__sx.getState().slice
    return s.status === 'done' ? s.result.stats : null
  })
  expect(stats?.timeS).toBeGreaterThan(60)
  const timeS = stats!.timeS
  // The slice reports the start before the first layer, and it is part of the figure.
  expect(stats!.prepareS ?? 0).toBeGreaterThan(0)
  expect(stats!.prepareS!).toBeLessThan(timeS)

  // Preview summary: the headline and the rows (the start included) add up to the estimate.
  const block = page.locator('[data-section="time"]')
  await expect(block.locator('.est-time')).toHaveText(worded(timeS))
  await expect(block.locator('.tlist li', { hasText: 'Heating, homing and purge' })).toHaveCount(1)
  const rows = await block.locator('.tlist li em').allInnerTexts()
  const share = rows.reduce((a, t) => a + (t.startsWith('<') ? 0.5 : Number.parseInt(t, 10)), 0)
  expect(share).toBeGreaterThan(95)
  expect(share).toBeLessThan(105)

  // Playback bar: the Time slider runs to the estimate.
  await expect(page.locator('#pv-time')).toHaveAttribute('aria-valuetext', new RegExp(` of ${clocked(timeS)}$`))
  await expect(page.locator('output[for="pv-time"]')).toContainText(`/ ${clocked(timeS)}`)
  // The head is still at the start with the bed empty until the first layer begins.
  await page.locator('#pv-time').focus()
  await page.keyboard.press('Home')
  await expect(page.locator('#pv-time')).toHaveAttribute('aria-valuetext', new RegExp(`^0:00 of ${clocked(timeS)}$`))
  await page.keyboard.press('End')
  await expect(page.locator('#pv-time')).toHaveAttribute('aria-valuetext', new RegExp(`^${clocked(timeS)} of ${clocked(timeS)}$`))

  // Model estimate.
  await tab(page, 'prepare').click()
  await expect(page.locator('[data-section="estimate"] .est-time')).toHaveText(worded(timeS))

  // Send sheet.
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('Print the plate on')
  const item = page.locator('.sx-palette-item', { hasText: 'Print the plate on' }).first()
  await expect(item).toBeVisible()
  await item.click()
  const sheet = page.locator('dialog.print-sheet[open]')
  // The sheet's summary of what will print (bcdbb995 replaced its Estimate group) carries the same time.
  await expect(sheet.getByRole('region', { name: 'What will print' })).toContainText(worded(timeS))
})
