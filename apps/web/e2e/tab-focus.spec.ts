// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Looks that bind Tab to the view switch take it only while the 3D view has focus. Anywhere else Tab moves focus as
// usual, so a keyboard user reaches the Printer card in every look.
import { type Page } from '@playwright/test'
import { expect, test, viewportReady } from './fixtures'

type Sx = { getState(): { workspace: string; modelMode: string; sliceLook: string } }
const view = (page: Page) => page.evaluate(() => { const s = (window as unknown as { __sx: Sx }).__sx.getState(); return `${s.workspace}/${s.modelMode}/${s.sliceLook}` })

for (const look of ['slicerx', 'prusaslicer', 'orcaslicer', 'bambu-studio'] as const) {
  test(`${look}: Tab reaches the Printer card, and switches the view only from the 3D view`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'Keyboard focus at desktop widths')
    await page.addInitScript((id) => {
      // the debug hooks give the spec the store (window.__sx)
      localStorage.setItem('slicerx.debug', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', printerId: 'bay-1', settingsMode: 'advanced', pilot: { mode: 'off' }, lookAndFeel: { id } }))
    }, look)
    await page.goto('./')
    await viewportReady(page)
    const before = await view(page)

    // From the top of the page, Tab walks the controls until it lands in the Printer card; the view never changes.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    const printer = page.locator('.sx-block[data-section="printer"]')
    let reached = false
    for (let i = 0; i < 120 && !reached; i++) {
      await page.keyboard.press('Tab')
      const at = await page.evaluate(() => ({ canvas: document.activeElement?.classList.contains('vp-canvas') ?? false, printer: !!document.activeElement?.closest('.sx-block[data-section="printer"]') }))
      expect(at.canvas, 'the Printer card comes before the 3D view').toBe(false)
      reached = at.printer
    }
    expect(reached).toBe(true)
    await expect(printer.locator(':focus')).toHaveCount(1)
    expect(await view(page)).toBe(before)

    // On the focused 3D view, Tab is the switch in the looks that bind it, and focus stays on the view.
    const canvas = page.locator('canvas.vp-canvas').first()
    await canvas.focus()
    await page.keyboard.press('Tab')
    if (look === 'bambu-studio') {
      expect(await view(page)).toBe(before)
      await expect(canvas).not.toBeFocused()
    } else {
      await expect.poll(() => view(page)).not.toBe(before)
      await expect(canvas).toBeFocused()
    }
  })
}
