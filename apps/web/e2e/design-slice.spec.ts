// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate tab's two modes. Design | Slice is the first tab; Ctrl+E (Cmd+E) flips it; Design has the model tree, the
// tool shelf and the timeline; a modeling tool opens Design from Slice; Slice shows the slice in place in the look
// picked under the plate toolbar, and there is no Preview tab.
import { command, freshBox, openStudio, pushTop, steps } from './cad-helpers'
import { expect, sliceCount, sliced, test } from './fixtures'

test.describe('Design | Slice', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop width')

  test('the first tab is Design | Slice, Ctrl+E flips it, and there is no Preview tab', async ({ page }) => {
    await openStudio(page)
    const design = page.locator('.sx-tab[data-mode="design"]')
    const slice = page.locator('.sx-tab[data-mode="slice"]')
    await expect(slice).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('.sx-tab', { hasText: 'Preview' })).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+e')
    await expect(design).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('.studio[data-model-mode="design"]')).toBeVisible()
    await page.keyboard.press('ControlOrMeta+e')
    await expect(slice).toHaveAttribute('aria-current', 'page')
    // From another tab a half opens the plate tab in that mode in one step.
    await page.locator('.sx-tab[data-tab="printers"]').click()
    await design.click()
    await expect(design).toHaveAttribute('aria-current', 'page')
  })

  test('Design has the tree, the shelf and the timeline; the shelf opens a tool in the side pane', async ({ page }) => {
    await openStudio(page)
    const id = await freshBox(page)
    await page.locator('.sx-tab[data-mode="design"]').click()
    const shelf = page.getByRole('toolbar', { name: 'Design tools' })
    await expect(shelf).toBeVisible()
    await expect(shelf.locator('.shelf-label')).toHaveText(['Create', 'Modify', 'Fasten', 'Inspect'])
    await expect(page.locator('.dtree-name', { hasText: 'Box' })).toBeVisible()
    // No plate toolbar and no Slice action in Design.
    await expect(page.getByRole('toolbar', { name: 'Plate tools' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Slice plate' })).toHaveCount(0)
    await shelf.locator('[data-tool="fillet"]').click()
    await expect(page.locator('.pane[data-side="right"] [data-section="cad-tool"]')).toContainText('Fillet')
    await page.keyboard.press('Escape')
    // A step made on the box shows in the tree and as a chip in the timeline.
    await page.locator('.dtree-name', { hasText: 'Box' }).click()
    await pushTop(page, id, 5)
    await expect.poll(() => steps(page)).toEqual([{ name: 'Pull 5 mm', state: 'done' }])
    await page.getByRole('button', { name: 'Open Timeline' }).click()
    await expect(page.locator('.tl-chip')).toHaveCount(1)
    await expect(page.locator('.tl-chip')).toContainText('Pull 5')
  })

  test('the timeline opens at the bottom edge of the view and closes when the pointer leaves', async ({ page }) => {
    await openStudio(page)
    await page.locator('.sx-tab[data-mode="design"]').click()
    const body = page.locator('.bpanel-body')
    await expect(page.getByTestId('edge-tab-bottom')).toBeVisible()
    await expect(body).toBeHidden()
    const view = (await page.locator('.vp').boundingBox())!
    await page.mouse.move(view.x + view.width / 3, view.y + view.height - 30)
    await page.mouse.move(view.x + view.width / 3 + 10, view.y + view.height - 24)
    await expect(body).toBeVisible()
    await page.mouse.move(view.x + view.width / 2, view.y + view.height / 3)
    await expect(body).toBeHidden({ timeout: 3000 })
  })

  test('a modeling tool from the Slice Tools menu opens Design', async ({ page }) => {
    await openStudio(page)
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Sketch' }).click()
    await expect(page.locator('.sx-tab[data-mode="design"]')).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('.shelf-tool[data-tool="sketch"]')).toHaveAttribute('aria-pressed', 'true')
  })

  test('Slice shows the slice in place: toolpaths by default, solid on request', async ({ page }) => {
    await openStudio(page)
    const before = await sliceCount(page)
    await command(page, 'Slice the plate')
    await expect(sliced(page, before)).toBeVisible({ timeout: 120_000 })
    await expect(page.getByRole('group', { name: 'Layers and moves' })).toBeVisible()
    const look = page.getByRole('radiogroup', { name: 'How the plate shows the slice' })
    // The slice command lands on the toolpaths just after the slice: pick Solid once that has settled.
    await expect(async () => {
      await look.getByRole('radio', { name: /^Solid/ }).click()
      await expect(page.locator('.studio[data-layers]')).toHaveCount(0, { timeout: 1000 })
    }).toPass({ timeout: 10_000 })
    await look.getByRole('radio', { name: /^Toolpaths/ }).click()
    await expect(page.locator('.studio[data-layers]')).toHaveCount(1)
  })
})
