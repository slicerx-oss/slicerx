// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Model tree's filter and rollback row: typing in the tree filters it and Escape shuts the filter; the rollback
// row moves through the history with the arrow keys and End goes back to the latest.
import { freshBox, openStudio, pushTop, steps } from './cad-helpers'
import { expect, test } from './fixtures'

test.describe('Model tree filter and rollback', () => {
  test.skip(({ isMobile }) => isMobile, 'Needs a keyboard')

  test('type to filter, then roll back with the keys', async ({ page }) => {
    await openStudio(page)
    const id = await freshBox(page)
    await page.locator('.sx-tab[data-mode="design"]').click()
    await page.locator('.dtree-name', { hasText: 'Box' }).click()
    await pushTop(page, id, 5)
    await pushTop(page, id, 3)
    await expect.poll(() => steps(page)).toEqual([
      { name: 'Pull 5 mm', state: 'done' },
      { name: 'Pull 3 mm', state: 'done' },
    ])
    // Typing in the tree opens the filter with that letter.
    await page.locator('.dtree-name', { hasText: 'Box' }).focus()
    await page.keyboard.type('3 mm')
    const filter = page.getByTestId('model-tree-filter')
    await expect(filter).toHaveValue('3 mm')
    await expect(page.getByTestId('model-tree-step')).toHaveCount(1)
    await expect(page.getByTestId('model-tree-step')).toContainText('Pull 3 mm')
    await filter.fill('nothing like it')
    await expect(page.getByText('Nothing matches "nothing like it"')).toBeVisible()
    await filter.press('Escape')
    await expect(filter).toHaveCount(0)
    await expect(page.getByTestId('model-tree-step')).toHaveCount(2)

    // Roll back to step 1 from its menu, then move the row with the keys.
    await page.getByTestId('model-tree-step').first().click({ button: 'right', position: { x: 60, y: 10 } })
    await page.getByTestId('model-ctx-roll').click()
    const row = page.getByTestId('model-tree-rollback')
    await expect(row).toHaveAttribute('aria-valuenow', '1')
    await row.focus()
    await page.keyboard.press('End')
    await expect(row).toHaveCount(0)
    await expect(page.locator('[data-testid="model-tree-step"][data-later]')).toHaveCount(0)
  })
})
