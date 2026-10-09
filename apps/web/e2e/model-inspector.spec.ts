// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's inspector: Transform folds to its position line while a tool is open, a step being edited names the object
// and the step in the tool's header, and two or more objects selected show as a multi-selection.
import { command, freshBox, openStudio, pushTop, toolPanel } from './cad-helpers'
import { expect, test } from './fixtures'

type Sx = { getState(): { plate: { id: string }[] }; setState(p: unknown): void }

test.describe('Model inspector', () => {
  test.skip(({ isMobile }) => isMobile, 'The inspector is a desktop pane here; the phone sheet has its own spec')

  test('Transform folds under a tool, and a step being edited names the object and the step', async ({ page }) => {
    await openStudio(page)
    const id = await freshBox(page)
    await page.locator('.sx-tab[data-mode="design"]').click()
    await page.locator('.dtree-name', { hasText: 'Box' }).click()
    // No tool: Transform shows whole.
    await expect(page.getByTestId('model-inspector').locator('.tf')).toBeVisible()
    await command(page, 'Push or pull a face')
    await expect(toolPanel(page)).toBeVisible()
    const summary = page.getByTestId('model-transform-summary')
    await expect(summary).toHaveText(/^X [-\d.]+ Y [-\d.]+ Z [-\d.]+ mm$/)
    await expect(page.locator('#model-transform')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('model-inspector').locator('.tf')).toHaveCount(0)
    await page.locator('#model-transform').click()
    await expect(page.getByTestId('model-inspector').locator('.tf')).toBeVisible()
    await page.keyboard.press('Escape')
    // Editing the pull: the header reads "Box › Pull 5 mm".
    await pushTop(page, id, 5)
    await page.keyboard.press('Escape')
    await page.getByTestId('model-tree-step').first().locator('[data-tree-row]').click()
    await expect(page.getByTestId('model-tool-crumb')).toHaveText('Box › Pull 5 mm')
  })

  test('two objects selected show together, and a name picks one alone', async ({ page }) => {
    await openStudio(page)
    await freshBox(page)
    await command(page, 'Add a box')
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate.length)).toBe(2)
    await page.locator('.sx-tab[data-mode="design"]').click()
    await page.evaluate(() => {
      const sx = (window as unknown as { __sx: Sx }).__sx
      const ids = sx.getState().plate.map((p) => p.id)
      sx.setState({ selection: ids[0], selectedIds: ids })
    })
    const multi = page.getByTestId('model-inspector-multi')
    await expect(multi).toContainText('2 objects')
    await expect(page.getByTestId('model-multi-size')).toHaveText(/^Together [\d.]+ x [\d.]+ x [\d.]+ mm$/)
    await expect(page.getByTestId('model-multi-object')).toHaveCount(2)
    await page.getByTestId('model-multi-object').nth(1).click()
    await expect(multi).toHaveCount(0)
    await expect(page.getByTestId('model-inspector').locator('.tf')).toBeVisible()
  })
})
