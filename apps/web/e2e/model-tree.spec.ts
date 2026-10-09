// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's tree rows stay calm: hovering a step shows its More button in a slot kept for it, so the name never moves,
// and the step's actions are in that menu. The keyboard walks the tree.
import { freshBox, openStudio, pushTop, steps } from './cad-helpers'
import { expect, test } from './fixtures'

test.describe('Model tree', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop width')

  test('a hover does not move the step name, and More holds the step actions', async ({ page }) => {
    await openStudio(page)
    const id = await freshBox(page)
    await page.locator('.sx-tab[data-mode="design"]').click()
    await page.locator('.dtree-name', { hasText: 'Box' }).click()
    await pushTop(page, id, 5)
    await expect.poll(() => steps(page)).toEqual([{ name: 'Pull 5 mm', state: 'done' }])
    const row = page.getByTestId('model-tree-step').first()
    const label = row.locator('.cad-step-label')
    const more = row.getByTestId('model-tree-more')
    await page.mouse.move(700, 450)
    await expect(more).toHaveCSS('opacity', '0')
    const before = await label.boundingBox()
    await row.hover()
    await expect(more).toHaveCSS('opacity', '1')
    expect(await label.boundingBox()).toEqual(before)
    await more.click()
    await expect(page.getByRole('menuitem', { name: 'Suppress Pull 5 mm' })).toBeVisible()
    await page.keyboard.press('Escape')

    // The keyboard: the object is the row Tab reaches, Down goes to the step.
    const name = page.locator('.dtree-name', { hasText: 'Box' })
    await name.focus()
    await page.keyboard.press('ArrowDown')
    await expect(row.locator('.cad-step-name')).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(name).toBeFocused()
  })
})
