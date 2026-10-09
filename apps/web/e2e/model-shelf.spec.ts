// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's shelf: four groups set apart by hairlines with no group labels, Measure and Values as icons by undo and
// redo, and a next slot with the tools for the picked object that appears with the pick. Checked at the widths the
// plan names: labels drop at 1100 px, the next slot hides at 900 px, and nothing in the bar overlaps.
import { type Page } from '@playwright/test'
import { freshBox, openStudio } from './cad-helpers'
import { expect, test } from './fixtures'

/** Boxes of the shelf's visible tools, none overlapping another. */
async function noOverlap(page: Page): Promise<void> {
  const overlaps = await page.getByTestId('model-shelf').evaluate((bar) => {
    const boxes = [...bar.querySelectorAll<HTMLElement>('button')].filter((b) => b.offsetParent !== null).map((b) => b.getBoundingClientRect())
    let n = 0
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!
      const b = boxes[j]!
      if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) n++
    }
    return n
  })
  expect(overlaps).toBe(0)
}

test.describe('Model shelf', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop widths')

  test('groups, utility icons, and the next slot for a picked object', async ({ page }) => {
    await openStudio(page)
    await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ selection: null, selectedIds: [] }))
    await page.locator('.sx-tab[data-mode="design"]').click()
    const shelf = page.getByTestId('model-shelf')
    await expect(shelf.locator('.shelf-grp')).toHaveCount(4)
    await expect(shelf.locator('.shelf-icon[data-tool="measure"] > span')).toBeHidden()
    await expect(page.getByTestId('model-shelf-next')).toHaveCount(0)
    await freshBox(page)
    await page.locator('.dtree-name', { hasText: 'Box' }).click()
    const next = page.getByTestId('model-shelf-next')
    await expect(next.getByTestId('model-shelf-next-tool')).toHaveCount(3)
    expect(await next.locator('[data-next-tool]').evaluateAll((els) => els.map((e) => e.getAttribute('data-next-tool')))).toEqual(['cut', 'array', 'holefit'])
    await noOverlap(page)
    // Everything fits at 1440 px: the shelf does not scroll, so undo and redo are on screen.
    expect(await shelf.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
    for (const [width, labels, nextShown] of [[1100, false, true], [900, false, false]] as const) {
      await page.setViewportSize({ width, height: 800 })
      await expect(shelf.locator('[data-tool="push"] > span')).toBeVisible({ visible: labels })
      await expect(next).toBeVisible({ visible: nextShown })
      await noOverlap(page)
    }
  })
})
