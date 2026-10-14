// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's ribbon: the Solid tab's four groups (Create, Modify, Inspect, Output) set apart by hairlines. What is picked
// shows in the groups themselves: a tool waiting for an object is off until one is selected, and a tool that takes one
// at a time is off, with the reason in its tip, when more are picked. Checked at the widths the plan names: the names
// drop where the row does not fit and nothing in the bar overlaps. Wherever the named ribbon does not fit (the mimir
// panel open beside it at 1440 px), it drops its names too, so no tool is out of view.
import { type Page } from '@playwright/test'
import { command, facePick, freshBox, openStudio, pick } from './cad-helpers'
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

test.describe('Model ribbon', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop widths')

  test('groups, and the selection shows in them with no separate slot', async ({ page }) => {
    await openStudio(page)
    await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ selection: null, selectedIds: [] }))
    await page.locator('.sx-tab[data-mode="design"]').click()
    const shelf = page.getByTestId('model-shelf')
    await expect(shelf.locator('.rb-grp')).toHaveCount(4)
    expect(await shelf.locator('.rb-glabel').allTextContents()).toEqual(['Create', 'Modify', 'Inspect', 'Output'])
    await expect(page.getByTestId('model-shelf-next')).toHaveCount(0)
    // nothing selected: the tools that work on an object are off, saying why
    for (const id of ['cut', 'array']) await expect(shelf.locator(`[data-tool="${id}"]`)).toHaveAttribute('aria-disabled', 'true')
    await expect(shelf.locator('[data-tool="cut"]')).toHaveAttribute('data-tip-body', 'Select an object first.')
    await freshBox(page)
    await page.locator('.dtree-name', { hasText: 'Box' }).click()
    for (const id of ['cut', 'array', 'holefit']) await expect(shelf.locator(`[data-tool="${id}"]`)).not.toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByTestId('model-shelf-next')).toHaveCount(0)
    await noOverlap(page)
    // Everything fits at 1440 px: the shelf does not scroll, so undo and redo are on screen.
    expect(await shelf.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
    for (const [width, labels] of [[1100, false], [900, false]] as const) {
      await page.setViewportSize({ width, height: 800 })
      await expect(shelf.locator('[data-tool="push"] .rb-label')).toBeVisible({ visible: labels })
      await noOverlap(page)
    }
  })
})

test.describe('Model ribbon with more picked than a tool takes', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop widths')

  test('turns off the tools that take one face at a time, in their own groups', async ({ page }) => {
    await openStudio(page)
    const id = await freshBox(page)
    await page.locator('.sx-tab[data-mode="design"]').click()
    await page.locator('.dtree-name', { hasText: 'Box' }).click()
    const shelf = page.getByTestId('model-shelf')
    const off = (tool: string) => shelf.locator(`[data-tool="${tool}"]`).getAttribute('aria-disabled')
    await page.keyboard.press('Alt+2')
    await pick(page, await facePick(page, id, [0, 0, 1]))
    expect([await off('push'), await off('sketch'), await off('shell')]).toEqual([null, null, null])
    await pick(page, { ...(await facePick(page, id, [1, 0, 0])), shift: true })
    await expect(shelf.locator('[data-tool="push"]')).toHaveAttribute('aria-disabled', 'true')
    await expect(shelf.locator('[data-tool="push"]')).toHaveAttribute('data-tip-body', 'Push and pull takes one face at a time.')
    await expect(shelf.locator('[data-tool="sketch"]')).toHaveAttribute('aria-disabled', 'true')
    expect(await off('shell')).toBeNull()
    await expect(page.getByTestId('model-shelf-next')).toHaveCount(0)
    expect(await shelf.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
  })

  test('two objects turn off Cut and Hole, Array stays on', async ({ page }) => {
    await openStudio(page)
    await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
    await command(page, 'Add a box')
    await command(page, 'Add a cylinder')
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: unknown[] } } }).__sx.getState().plate.length)).toBe(2)
    await page.evaluate(() => {
      const sx = (window as unknown as { __sx: { getState(): { plate: { id: string }[] }; setState(p: unknown): void } }).__sx
      const ids = sx.getState().plate.map((p) => p.id)
      sx.setState({ selection: ids[0], selectedIds: ids })
    })
    await page.locator('.sx-tab[data-mode="design"]').click()
    const shelf = page.getByTestId('model-shelf')
    await expect(shelf.locator('[data-tool="cut"]')).toHaveAttribute('data-tip-body', 'Cut one object at a time.')
    await expect(shelf.locator('[data-tool="holefit"]')).toHaveAttribute('aria-disabled', 'true')
    await expect(shelf.locator('[data-tool="array"]')).not.toHaveAttribute('aria-disabled', 'true')
  })
})

test.describe('Model ribbon beside the mimir panel', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop widths')

  test('with the mimir panel open at 1440 px, every tool stays in view, and the labels come back when it closes', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript(() => localStorage.setItem('sx-mimir-dock', '1'))
    await openStudio(page, { pilot: { mode: 'unset' } })
    await page.locator('.sx-tab[data-mode="design"]').click()
    const shelf = page.getByTestId('model-shelf')
    const dock = page.locator('.mimir-dock')
    await expect(dock).toBeVisible()
    await expect(shelf).toHaveAttribute('data-fit', 'icons')
    const fits = () => shelf.evaluate((bar) => {
      const r = bar.getBoundingClientRect()
      const out = [...bar.querySelectorAll<HTMLElement>('button')].filter((b) => b.offsetParent !== null).filter((b) => b.getBoundingClientRect().right > r.right + 0.5)
      return { scrolls: bar.scrollWidth > bar.clientWidth + 1, out: out.map((b) => b.getAttribute('aria-label')) }
    })
    expect(await fits()).toEqual({ scrolls: false, out: [] })
    expect((await shelf.boundingBox())!.x + (await shelf.boundingBox())!.width).toBeLessThanOrEqual((await dock.boundingBox())!.x)
    await expect(shelf.locator('[data-tool="redo"], [aria-label="Redo"]').first()).toBeInViewport()
    await noOverlap(page)
    await dock.getByRole('button', { name: /close/i }).first().click()
    await expect(dock).toHaveCount(0)
    await expect(shelf).toHaveAttribute('data-fit', 'labels')
    expect(await fits()).toEqual({ scrolls: false, out: [] })
    await expect(shelf.locator('.rb-btn .rb-label').first()).toBeVisible()
  })
})
