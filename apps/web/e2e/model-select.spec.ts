// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's pick filter: Alt+2 picks faces and Alt+3 edges, the pill says what is picked, Esc clears it, and a tool
// opened next starts from the pick (select, then the tool).
import { bounds, command, facePick, freshBox, openStudio, pick, placeAt, toolPanel } from './cad-helpers'
import { expect, test } from './fixtures'

test.describe('Model pick filter', () => {
  test.skip(({ isMobile }) => isMobile, 'Needs a keyboard')

  test('faces: pick, add with Shift, clear with Esc, and Push starts from the face', async ({ page }) => {
    await openStudio(page)
    const id = await freshBox(page)
    await page.locator('.sx-tab[data-mode="design"]').click()
    const readout = page.getByTestId('model-select-readout')
    await page.mouse.move(700, 450)
    await page.keyboard.press('Alt+2')
    await expect(page.locator('[data-testid="model-select-filter"][data-kind="face"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-testid="model-select-filter"][data-kind="object"]')).toHaveAttribute('aria-pressed', 'false')
    await pick(page, await facePick(page, id, [0, 0, 1]))
    await expect(readout).toHaveText('1 face on Box')
    await pick(page, { ...(await facePick(page, id, [1, 0, 0])), shift: true })
    await expect(readout).toHaveText('2 faces on Box')
    await page.keyboard.press('Escape')
    await expect(readout).toHaveText('Box')
    // Select, then the tool: Push and pull opens with the face already picked.
    await pick(page, await facePick(page, id, [0, 0, 1]))
    await expect(readout).toHaveText('1 face on Box')
    await command(page, 'Push or pull a face')
    await expect(toolPanel(page)).toContainText('A face is picked')
    await expect(readout).toHaveText('Box')
  })

  test('edges: Alt+3 picks the edge next to the click, and Fillet starts from it', async ({ page }) => {
    test.slow()
    await openStudio(page)
    const id = await freshBox(page)
    await placeAt(page, 100, 100)
    const b = await bounds(page, id)
    await page.locator('.sx-tab[data-mode="design"]').click()
    await page.mouse.move(700, 450)
    await page.keyboard.press('Alt+3')
    await pick(page, await facePick(page, id, [0, 0, 1], [b.max[0] - 0.3, (b.min[1] + b.max[1]) / 2, b.max[2]]))
    await expect(page.getByTestId('model-select-readout')).toHaveText('1 edge on Box')
    await command(page, 'Fillet or chamfer edges')
    await expect(toolPanel(page)).toContainText('1 edge')
  })
})
