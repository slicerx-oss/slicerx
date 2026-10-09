// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate's two modes, the Model and Slice tabs. Ctrl+E (Cmd+E) flips them; Model has the model tree, the
// tool shelf and the timeline; a modeling tool opens Design from Slice; Slice shows the slice in place in the look
// picked under the plate toolbar, and there is no Preview tab.
import { command, freshBox, openStudio, pushTop, steps } from './cad-helpers'
import { expect, sliceCount, sliced, test, addMenu } from './fixtures'

test.describe('Model and Slice', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop width')

  test('the first tabs are Model and Slice, Ctrl+E flips them, tab-design still opens Model, and there is no Preview tab', async ({ page }) => {
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
    // From another tab, Model or Slice opens the plate in that mode in one step.
    await page.locator('.sx-tab[data-tab="printers"]').click()
    await design.click()
    await expect(design).toHaveAttribute('aria-current', 'page')
    // Model is tab-model, and answers to its old id, tab-design, while scripts move over.
    await expect(page.getByTestId('tab-model')).toHaveText('Model')
    await page.getByTestId('tab-prepare').click()
    await page.locator('[data-testid-alias="tab-design"]').click()
    await expect(page.getByTestId('tab-model')).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('.sx-tab', { hasText: 'Design' })).toHaveCount(0)
  })

  test('Design has the tree, the shelf and the timeline; the shelf opens a tool in the side pane', async ({ page }) => {
    await openStudio(page)
    const id = await freshBox(page)
    await page.locator('.sx-tab[data-mode="design"]').click()
    const shelf = page.getByRole('toolbar', { name: 'Model tools' })
    await expect(shelf).toBeVisible()
    await expect(shelf.locator('.shelf-grp')).toHaveCount(4)
    await expect(shelf.locator('.shelf-label')).toHaveCount(0)
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
    await addMenu(page, 'Tools')
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

  test('Model never shows the slice: no toolpaths, layer slider or legend after a slice, and Slice brings them back', async ({ page }) => {
    await openStudio(page)
    const before = await sliceCount(page)
    await command(page, 'Slice the plate')
    await expect(sliced(page, before)).toBeVisible({ timeout: 120_000 })
    const layersGroup = page.getByRole('group', { name: 'Layers and moves' })
    await expect(layersGroup).toBeVisible()
    await expect(page.getByTestId('legend-color-by')).toBeVisible()
    await page.getByTestId('tab-model').click()
    await expect(page.locator('.studio[data-model-mode="design"]')).toBeVisible()
    // The slice is still there; Model just doesn't draw it.
    await expect(page.locator('.studio[data-layers]')).toHaveCount(0)
    await expect(layersGroup).toBeHidden()
    await expect(page.getByTestId('legend-color-by')).toBeHidden()
    await expect(page.getByTestId('legend-slot')).toHaveCount(0)
    await page.getByTestId('tab-prepare').click()
    await expect(page.locator('.studio[data-layers]')).toHaveCount(1)
    await expect(layersGroup).toBeVisible()
  })
})
