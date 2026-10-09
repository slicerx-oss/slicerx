// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Model shelf is one row tall and scrolls sideways, so its menus lift out over the view instead of being cut to
// the shelf's height: every item shows, and the shelf never scrolls inside itself.
import { freshBox, openStudio, pushTop } from './cad-helpers'
import { expect, test } from './fixtures'

test('the Mesh menu opens over the view, and Repair mesh adds its step', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The shelf is a desktop control')
  await openStudio(page)
  const id = await freshBox(page)
  await page.locator('.sx-tab[data-mode="design"]').click()
  await page.locator('.dtree-name', { hasText: 'Box' }).click()
  // A part with history, so the repair lands as a step in it.
  await pushTop(page, id, 5)
  const shelf = page.locator('.shelf').first()
  await page.locator('.shelf-tool', { hasText: 'Mesh' }).click()
  const menu = page.getByRole('menu', { name: 'Mesh' })
  await expect(menu).toBeVisible()
  const items = menu.getByRole('menuitem')
  await expect(items).toHaveCount(3)
  // Lifted out of the shelf: below its bottom edge, every item inside the window, and the shelf not scrolled.
  const s = (await shelf.boundingBox())!
  const m = (await menu.boundingBox())!
  expect(m.y + m.height).toBeGreaterThan(s.y + s.height)
  for (const item of await items.all()) await expect(item).toBeInViewport({ ratio: 1 })
  expect(await shelf.evaluate((el) => el.scrollTop)).toBe(0)
  await menu.getByRole('menuitem', { name: 'Repair mesh' }).click()
  await expect(page.getByTestId('model-tree-step').filter({ hasText: 'Repair' })).toHaveCount(1)
})
