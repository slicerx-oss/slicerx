// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's shelf: four groups set apart by hairlines with no group labels, Measure and Values as icons by undo and
// redo, and a next slot with the tools for the picked object that appears with the pick. Checked at the widths the
// plan names: labels drop at 1100 px, the next slot hides at 900 px, and nothing in the bar overlaps. Wherever the
// labeled shelf does not fit (the mimir panel open beside it at 1440 px), it drops its labels too, so no tool is out of view.
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

test.describe('Model shelf next slot for faces and edges', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop widths')

  test('counts the picks and turns off the tools that cannot take that many', async ({ page }) => {
    await openStudio(page)
    const id = await freshBox(page)
    await page.locator('.sx-tab[data-mode="design"]').click()
    await page.locator('.dtree-name', { hasText: 'Box' }).click()
    const next = page.getByTestId('model-shelf-next')
    const tools = () => next.getByTestId('model-shelf-next-tool').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-next-tool')}${e.getAttribute('aria-disabled') ? ' off' : ''}`))
    // one object needs no count
    await expect(page.getByTestId('model-shelf-next-count')).toHaveCount(0)
    // one face, then a second with Shift
    await page.keyboard.press('Alt+2')
    await pick(page, await facePick(page, id, [0, 0, 1]))
    await expect(page.getByTestId('model-shelf-next-count')).toHaveAttribute('aria-label', '1 face')
    expect(await tools()).toEqual(['push', 'sketch', 'shell'])
    await pick(page, { ...(await facePick(page, id, [1, 0, 0])), shift: true })
    await expect(page.getByTestId('model-shelf-next-count')).toHaveAttribute('aria-label', '2 faces')
    expect(await tools()).toEqual(['push off', 'sketch off', 'shell'])
    // the chip fits: the shelf still does not scroll at 1440 px
    expect(await page.getByTestId('model-shelf').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
    // edges get Fillet and Chamfer
    await page.keyboard.press('Alt+3')
    await pick(page, await facePick(page, id, [0, 0, 1]))
    await expect(page.getByTestId('model-shelf-next-count')).toHaveAttribute('aria-label', '1 edge')
    expect(await tools()).toEqual(['fillet', 'chamfer'])
  })

  test('a round face offers Hole and Thread', async ({ page }) => {
    await openStudio(page)
    await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
    await command(page, 'Add a cylinder')
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: unknown[] } } }).__sx.getState().plate.length)).toBe(1)
    const id = await page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: { id: string }[] } } }).__sx.getState().plate[0]!.id)
    await page.locator('.sx-tab[data-mode="design"]').click()
    await page.keyboard.press('Alt+2')
    // a triangle of the cylinder's side wall: its normal lies flat
    const side = await page.evaluate((oid) => {
      type E = { id: string; transform: number[]; parts: { positions: Float32Array; indices: Uint32Array }[] }
      const e = (window as unknown as { __sx: { getState(): { plate: E[] } } }).__sx.getState().plate.find((p) => p.id === oid)!
      const m = e.transform
      const part = e.parts[0]!
      const w = (i: number) => {
        const x = part.positions[i * 3]!, y = part.positions[i * 3 + 1]!, z = part.positions[i * 3 + 2]!
        return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!]
      }
      for (let t = 0; t < part.indices.length / 3; t++) {
        const [a, b, c] = [w(part.indices[t * 3]!), w(part.indices[t * 3 + 1]!), w(part.indices[t * 3 + 2]!)] as number[][]
        const u = [b![0]! - a![0]!, b![1]! - a![1]!, b![2]! - a![2]!], v = [c![0]! - a![0]!, c![1]! - a![1]!, c![2]! - a![2]!]
        const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
        const len = Math.hypot(n[0]!, n[1]!, n[2]!)
        if (len > 1e-9 && Math.abs(n[2]! / len) < 0.05) return { objectId: oid, partIndex: 0, triangle: t, point: [(a![0]! + b![0]! + c![0]!) / 3, (a![1]! + b![1]! + c![1]!) / 3, (a![2]! + b![2]! + c![2]!) / 3] as [number, number, number] }
      }
      throw new Error('no side wall')
    }, id)
    await pick(page, side)
    await expect(page.getByTestId('model-shelf-next-count')).toHaveAttribute('aria-label', '1 round face', { timeout: 15_000 })
    expect(await page.getByTestId('model-shelf-next').getByTestId('model-shelf-next-tool').evaluateAll((els) => els.map((e) => e.getAttribute('data-next-tool')))).toEqual(['holefit', 'thread'])
  })
})

test.describe('Model shelf beside the mimir panel', () => {
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
    await expect(shelf.locator('.shelf-tool > span').first()).toBeVisible()
  })
})
