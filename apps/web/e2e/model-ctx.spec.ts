// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Model tree's menus: a right click on a step rolls the part back to it and Roll to end brings it back; Shift+F10
// on a focused row opens the same menu, Escape closes it and focus goes back to the row; an object renames in place.
import { freshBox, openStudio, pushTop, steps } from './cad-helpers'
import { expect, test } from './fixtures'

test.describe('Model tree menus', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop width')

  test('roll to a step and back, Shift+F10 and Escape, and rename an object and a step', async ({ page }) => {
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
    const first = page.getByTestId('model-tree-step').first()
    await first.click({ button: 'right', position: { x: 60, y: 10 } })
    const menu = page.getByTestId('model-ctx')
    await expect(menu).toHaveAttribute('data-target', 'step')
    await menu.getByTestId('model-ctx-roll').click()
    await expect(page.getByTestId('model-tree-step').nth(1)).toHaveAttribute('data-later', 'true')
    await first.click({ button: 'right', position: { x: 60, y: 10 } })
    await menu.getByTestId('model-ctx-end').click()
    await expect(page.locator('[data-testid="model-tree-step"][data-later]')).toHaveCount(0)

    // The keyboard's right click, and focus back on the row after Escape.
    const name = first.locator('.cad-step-name')
    await name.focus()
    await page.keyboard.press('Shift+F10')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(first).toBeFocused()

    // Rename the step with F2, and the object from its menu.
    await page.keyboard.press('F2')
    const field = page.getByTestId('model-tree-rename')
    await field.fill('Base boss')
    await field.press('Enter')
    await expect(first.locator('.cad-step-label')).toHaveText('Base boss')
    await page.locator('.dtree-name', { hasText: 'Box' }).click({ button: 'right' })
    await expect(menu).toHaveAttribute('data-target', 'object')
    await menu.getByTestId('model-ctx-rename').click()
    await field.fill('Bracket')
    await field.press('Enter')
    await expect(page.locator('.dtree-name', { hasText: 'Bracket' })).toBeVisible()
  })
})
