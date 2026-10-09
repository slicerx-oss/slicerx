// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The top bar at desktop widths down to the 960 px minimum: nothing in it overflows or clips, Printers is always one
// click away (a tab, or the first item in More), a long project name truncates with its full name in the tip, and
// Model and Slice keep their labels longest.
import { type Page } from '@playwright/test'
import { openStudio } from './cad-helpers'
import { expect, test } from './fixtures'

const LONG = 'Bracket for the left side of the garage shelf, second try with thicker ribs.sx3mf'

/** Every direct child of the bar and of the tabs lies inside the bar, and neither scrolls sideways. */
async function noOverflow(page: Page): Promise<void> {
  const r = await page.locator('.sx-appbar').evaluate((bar) => {
    const b = bar.getBoundingClientRect()
    const nav = bar.querySelector('.sx-tabs')!
    const kids = [...bar.children, ...nav.children].filter((el) => (el as HTMLElement).offsetParent !== null)
    const out = kids.filter((el) => {
      const k = el.getBoundingClientRect()
      return k.left < b.left - 0.5 || k.right > b.right + 0.5
    })
    return { barScroll: bar.scrollWidth - bar.clientWidth, navScroll: nav.scrollWidth - nav.clientWidth, out: out.map((el) => el.className) }
  })
  expect(r).toEqual({ barScroll: 0, navScroll: 0, out: [] })
}

/** Opens Printers from the bar: its tab, or More's first item. */
async function openPrinters(page: Page): Promise<void> {
  const tab = page.getByTestId('tab-printers')
  if (await tab.isVisible()) await tab.click()
  else {
    await page.getByTestId('tab-overflow').click()
    const items = page.getByRole('menu', { name: 'More tabs' }).getByRole('menuitem')
    await expect(items.first()).toHaveText(/Printers/)
    await page.getByTestId('tab-overflow-printers').click()
  }
  await expect(page.locator('.sx-appbar [aria-current="page"]')).toHaveAttribute('data-testid', /^tab-(printers|overflow)$/)
}

test.describe('top bar widths', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop widths')

  for (const [width, labels] of [
    [1440, true],
    [1100, true],
    [960, false],
  ] as const) {
    test(`fits at ${width} px`, async ({ page }) => {
      // The plate loads at the default width (narrower windows start with the object list shut), then the window narrows.
      await openStudio(page)
      await page.setViewportSize({ width, height: 800 })
      // A long project name, as an opened file sets it.
      await page.evaluate((name) => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ projectFile: { name, path: `/home/maker/${name}` } }), LONG)
      const name = page.locator('.sx-projname')
      await expect(name).toContainText('Bracket for the left')
      await noOverflow(page)
      // The name truncates with an ellipsis, and its tip has the whole path.
      const cut = await name.locator('b').evaluate((el) => ({ truncated: el.scrollWidth > el.clientWidth, overflow: getComputedStyle(el).textOverflow }))
      if (width < 1440) expect(cut).toEqual({ truncated: true, overflow: 'ellipsis' })
      await expect(name).toHaveAttribute('data-tip-title', `/home/maker/${LONG}`)
      // Model and Slice keep their labels down to 1100 px at least.
      if (labels) {
        await expect(page.getByTestId('tab-model').locator('span')).toBeVisible()
        await expect(page.getByTestId('tab-prepare').locator('span')).toBeVisible()
      }
      await page.screenshot({ path: test.info().outputPath(`top-bar-${width}.png`), clip: { x: 0, y: 0, width, height: 120 } })
      await openPrinters(page)
      await noOverflow(page)
    })
  }

  test('gives the room back when the window widens again', async ({ page }) => {
    await openStudio(page)
    await page.setViewportSize({ width: 960, height: 800 })
    await page.setViewportSize({ width: 1440, height: 800 })
    await expect(page.getByTestId('tab-printers')).toBeVisible()
    await expect(page.getByTestId('tab-overflow')).toHaveCount(0)
    await expect(page.locator('.sx-appbar')).not.toHaveAttribute('data-narrow-tabs', /.*/)
  })
})
