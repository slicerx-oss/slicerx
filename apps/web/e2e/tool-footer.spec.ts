// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every modeling tool ends in the same footer: Cancel (Esc) closes it, Apply (Enter) runs it and closes, and Hole,
// Fillet and Thread add Apply and repeat, which runs it and stays open for the next pick with the same settings.
import { bounds, command, facePick, freshBox, height, openStudio, pick, placeAt, steps, toolPanel } from './cad-helpers'
import { expect, test } from './fixtures'

test.describe('tool footer', () => {
  test.skip(({ isMobile }) => isMobile, 'Needs a keyboard')

  test('Esc closes a tool, and Enter in its field applies and closes', async ({ page }) => {
    await openStudio(page)
    const id = await freshBox(page)
    await command(page, 'Push or pull a face')
    const panel = toolPanel(page)
    await expect(panel.getByTestId('model-tool-cancel')).toHaveText('Cancel')
    await expect(panel.getByTestId('model-tool-repeat')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await command(page, 'Push or pull a face')
    await pick(page, await facePick(page, id, [0, 0, 1]))
    await expect(panel).toContainText('A face is picked')
    await panel.locator('#push-dist').fill('4')
    await expect(panel.getByTestId('model-tool-apply')).toHaveText('Pull out')
    await panel.locator('#push-dist').press('Enter')
    await expect(panel).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(() => height(page, id)).toBe(24)
  })

  test('Apply and repeat rounds an edge and stays open with the same size', async ({ page }) => {
    test.slow()
    await openStudio(page)
    const id = await freshBox(page)
    await placeAt(page, 100, 100)
    const b = await bounds(page, id)
    await command(page, 'Fillet or chamfer edges')
    const panel = toolPanel(page)
    await expect(panel).toContainText('No edge yet')
    await pick(page, await facePick(page, id, [0, 0, 1], [b.max[0] - 0.3, (b.min[1] + b.max[1]) / 2, b.max[2]]))
    await expect(panel).toContainText('1 edge')
    await panel.locator('#edge-size').fill('2')
    await panel.getByTestId('model-tool-repeat').click()
    await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: 'Fillet 2 mm', state: 'done' }])
    await expect(panel).toContainText('No edge yet')
    await expect(panel.locator('#edge-size')).toHaveValue('2')
  })
})
