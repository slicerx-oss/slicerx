// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Vault's layout: the featured cover shows the whole drawing, centered, and the rows size their cards from the width
// they have, a few large covers on a wide window and either a full row or the next card peeking in from the edge. One
// boot serves all of it: the window is resized for each width and put back after. The featured design and its sheet
// show the size it prints at, from the scan. The phone legs are in phone-session.spec.ts.
import { journey as test, expect } from '../journey'
import { expectHeroCoverFits, measureRow, openVault, shotsDir, shotsOn } from './lib/session'

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

test('the featured design and its sheet show the size it prints at', async ({ page }, info) => {
  const SIZE = /^\d+\.\d x \d+\.\d x \d+\.\d mm$/
  type Sx = { getState: () => { scheme: string; themeFollowsSystem: boolean }; setState: (p: object) => void }
  const scheme = (s: 'light' | 'dark') => page.evaluate((v) => (window as unknown as { __sx: Sx }).__sx.setState({ scheme: v, themeFollowsSystem: false }), s)
  const before = await page.evaluate(() => {
    const { scheme, themeFollowsSystem } = (window as unknown as { __sx: Sx }).__sx.getState()
    return { scheme, themeFollowsSystem }
  })
  const sheet = page.getByTestId('vault-listing-sheet')
  try {
    await page.setViewportSize(DESKTOP)
    await openVault(page)
    const hero = page.getByTestId('vault-featured-size')
    await expect(hero.locator('dt')).toHaveText('Size')
    await expect(hero.locator('dd')).toHaveText(SIZE)
    const size = await hero.locator('dd').innerText()
    await page.locator('.lib-hero-art').click()
    const row = sheet.getByTestId('vault-detail-size')
    await expect(row.locator('dt')).toHaveText('Size')
    await expect(row.locator('dd')).toHaveText(size)
    await page.getByTestId('vault-listing-close').click()
    await expect(sheet).toHaveCount(0)
    if (shotsOn()) {
      const dir = shotsDir(info)
      for (const [w, h] of [[1440, 900], [390, 844]] as const) {
        for (const s of ['light', 'dark'] as const) {
          await page.setViewportSize({ width: w, height: h })
          await scheme(s)
          await page.locator('.lib-hero').evaluate((el) => el.scrollIntoView({ block: 'start' }))
          await expect(hero).toBeVisible()
          await page.screenshot({ path: `${dir}/vault-size-hero-${w}-${s}.png` })
          await page.locator('.lib-hero-art').click()
          await expect(sheet.getByTestId('vault-detail-size')).toBeVisible()
          await sheet.getByTestId('vault-detail-size').scrollIntoViewIfNeeded()
          await page.screenshot({ path: `${dir}/vault-size-sheet-${w}-${s}.png` })
          await page.getByTestId('vault-listing-close').click()
          await expect(sheet).toHaveCount(0)
        }
      }
    }
  } finally {
    if (await sheet.count()) await page.getByTestId('vault-listing-close').click()
    await page.evaluate((v) => (window as unknown as { __sx: Sx }).__sx.setState(v), before)
    await page.setViewportSize(DESKTOP)
  }
})
