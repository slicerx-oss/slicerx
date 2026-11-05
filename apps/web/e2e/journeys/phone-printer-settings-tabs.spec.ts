// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey: the Printer settings tab row on a phone and a desktop. At 390 px the five tabs are wider than the dialog,
// so the row scrolls sideways inside the dialog and fades at an edge with more tabs past it. Every tab can be brought
// into view and picked, by a swipe or by the arrow keys, and picking one moves nothing. At 1440 the row fits: no fade.
import type { Locator } from '@playwright/test'
import { BAY_1, expect, setState, sidebarAs, sidebarDone, test } from './lib/shell'

const box = async (l: Locator) => (await l.boundingBox())!

/** The tab lies fully inside the row's visible box. */
async function inView(row: Locator, tab: Locator): Promise<boolean> {
  const r = await box(row)
  const t = await box(tab)
  return t.x >= r.x - 0.5 && t.x + t.width <= r.x + r.width + 0.5
}

async function openPrinterSettings(page: Parameters<typeof sidebarAs>[0]) {
  await sidebarAs(page, { mode: 'advanced', printer: BAY_1 })
  await setState(page, { printerSettingsOpen: true })
  const dialog = page.getByRole('dialog', { name: /Printer settings/ })
  await expect(dialog).toBeVisible()
  return { dialog, row: dialog.getByRole('radiogroup', { name: 'Printer settings tab' }) }
}

async function shut(page: Parameters<typeof sidebarAs>[0]) {
  await setState(page, { printerSettingsOpen: false })
  await expect(page.getByRole('dialog', { name: /Printer settings/ })).toHaveCount(0)
  await sidebarDone(page)
}

test.describe('the Printer settings tab row', () => {
  test('at 390 every tab can be reached and picked, the row fades where more tabs wait, and a pick moves nothing', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Phone width; the desktop leg is below')
    const { dialog, row } = await openPrinterSettings(page)
    try {
      const basic = row.getByRole('radio', { name: 'Basic information' })
      const cooling = row.getByRole('radio', { name: 'Cooling' })
      // The row stays inside the dialog and says more tabs wait past its end.
      const d = await box(dialog)
      const r = await box(row)
      expect(r.x).toBeGreaterThanOrEqual(d.x)
      expect(r.x + r.width).toBeLessThanOrEqual(d.x + d.width)
      await expect(row).toHaveAttribute('data-more-end', '')
      await expect(row).not.toHaveAttribute('data-more-start', '')
      expect(await row.evaluate((el) => getComputedStyle(el).maskImage)).not.toBe('none')
      expect(await inView(row, cooling)).toBe(false)

      // A swipe to the end brings Cooling into view; the fade moves to the start.
      await row.evaluate((el) => el.scrollTo({ left: el.scrollWidth }))
      await expect(row).toHaveAttribute('data-more-start', '')
      await expect(row).not.toHaveAttribute('data-more-end', '')
      expect(await inView(row, cooling)).toBe(true)

      // Picking it moves nothing: the tab keeps its box and the row keeps its scroll.
      const before = await box(cooling)
      const scrolled = await row.evaluate((el) => el.scrollLeft)
      await cooling.click()
      await expect(cooling).toHaveAttribute('aria-checked', 'true')
      const after = await box(cooling)
      for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(after[k] - before[k])).toBeLessThanOrEqual(0.5)
      expect(await row.evaluate((el) => el.scrollLeft)).toBe(scrolled)

      // The arrow keys move the choice and the focus, and bring the tab they land on into view.
      await cooling.focus()
      await page.keyboard.press('ArrowRight')
      await expect(basic).toHaveAttribute('aria-checked', 'true')
      await expect(basic).toBeFocused()
      await expect.poll(() => inView(row, basic)).toBe(true)
      await page.keyboard.press('ArrowLeft')
      await expect(cooling).toHaveAttribute('aria-checked', 'true')
      await expect(cooling).toBeFocused()
      await expect.poll(() => inView(row, cooling)).toBe(true)
    } finally {
      await shut(page)
    }
  })

  test('at 1440 the row fits: every tab in view and no fade', async ({ page, isMobile }) => {
    test.skip(isMobile, 'Desktop width; the phone leg is above')
    const { row } = await openPrinterSettings(page)
    try {
      for (const name of ['Basic information', 'Extruder and retraction', 'Motion ability', 'Multimaterial', 'Cooling']) expect(await inView(row, row.getByRole('radio', { name }))).toBe(true)
      await expect(row).not.toHaveAttribute('data-more-start', '')
      await expect(row).not.toHaveAttribute('data-more-end', '')
      expect(await row.evaluate((el) => getComputedStyle(el).maskImage)).toBe('none')
    } finally {
      await shut(page)
    }
  })
})
