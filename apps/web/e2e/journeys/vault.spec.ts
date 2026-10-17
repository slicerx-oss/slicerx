// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Vault's layout: the featured cover shows the whole drawing, centered, and the rows size their cards from the width
// they have, a few large covers on a wide window and either a full row or the next card peeking in from the edge. One
// boot serves all of it: the window is resized for each width and put back after. The phone legs are in
// phone-session.spec.ts.
import { journey as test, expect } from '../journey'
import { expectHeroCoverFits, measureRow, openVault, shotsOn } from './lib/session'

test.skip(({ isMobile }) => isMobile, 'Desktop widths. The phone legs are in phone-session.spec.ts')

const DESKTOP = { width: 1440, height: 900 }

test('the featured cover fits whole and centered in the hero', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  await openVault(page)
  await expectHeroCoverFits(page)
})

for (const [w, h, min, max] of [
  [2560, 1321, 5, 6],
  [1440, 900, 4, 5],
] as const) {
  test(`at ${w} px a row holds ${min} to ${max} large covers and fills the width`, async ({ page }, info) => {
    try {
      await page.setViewportSize({ width: w, height: h })
      await openVault(page)
      // the rows lay out again for the new width
      await expect.poll(async () => {
        const m = await measureRow(page)
        return m.whole >= min && m.whole <= max && m.coverW > 240
      }).toBe(true)
      const m = await measureRow(page)
      expect(Math.round((m.coverW / m.coverH) * 3)).toBe(4)
      // Either the cards reach the end of the row, or there is no next card to show.
      if (m.count > m.whole) expect(m.reach).toBeGreaterThan(m.rowW - 4)
      // The featured design stays in proportion: the first row starts within the first screen.
      const rowTop = await page.locator('#lib-popular-h').evaluate((el) => el.getBoundingClientRect().top)
      expect(rowTop).toBeLessThan(h)
      if (shotsOn()) {
        await page.locator('#lib-popular-h').evaluate((el) => el.scrollIntoView({ block: 'start' }))
        await page.screenshot({ path: info.outputPath(`vault-rows-${w}.png`) })
      }
    } finally {
      await page.setViewportSize(DESKTOP)
    }
  })
}
