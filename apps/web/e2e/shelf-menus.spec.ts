// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Model ribbon's menus lift out over the view instead of being cut to the ribbon's height: every item shows, and
// the ribbon never scrolls inside itself. The mesh tools sit on the Mesh tab.
import { freshBox, openStudio, pushTop } from './cad-helpers'
import { expect, test } from './fixtures'

test('the Add shape menu opens over the view, and Repair mesh on the Mesh tab adds its step', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The ribbon is a desktop control')
  await openStudio(page)
  const id = await freshBox(page)
  await page.locator('.sx-tab[data-mode="design"]').click()
  await page.locator('.dtree-name', { hasText: 'Box' }).click()
  // A part with history, so the repair lands as a step in it.
  await pushTop(page, id, 5)
  const ribbon = page.getByTestId('model-shelf')
  await page.getByTestId('ribbon-menu-add').click()
  const menu = page.getByRole('menu', { name: 'Add shape' })
  await expect(menu).toBeVisible()
  const items = menu.getByRole('menuitem')
  await expect(items).toHaveCount(8)
  // Lifted out of the ribbon: below its bottom edge, every item inside the window, and the ribbon not scrolled.
  const s = (await ribbon.boundingBox())!
  const m = (await menu.boundingBox())!
  expect(m.y + m.height).toBeGreaterThan(s.y + s.height)
  for (const item of await items.all()) await expect(item).toBeInViewport({ ratio: 1 })
  expect(await ribbon.locator('.rb-body').evaluate((el) => el.scrollTop + el.scrollLeft)).toBe(0)
  await page.keyboard.press('Escape')
  await page.getByTestId('ribbon-tab-mesh').click()
  await ribbon.locator('[data-tool="repair"]').click()
  await expect(page.getByTestId('model-tree-step').filter({ hasText: 'Repair' })).toHaveCount(1)
})
