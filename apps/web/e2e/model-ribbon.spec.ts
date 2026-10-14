// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's ribbon at 1440 and 1280 px in all three toolbar sizes: the icons drawn at the size's grid, names under them
// at Large and Medium and in the tips at Small, and nothing moving: not on a tab change (every tab's row is the same
// height), not on a press, not on a hover. Every tool is in view, none overlaps another, and the row never scrolls.
// The Toolbar size row in Settings changes the ribbon at once. SX_SHOTS=1 also saves the ribbon in dark and light at
// each width and size to SX_SHOTS_DIR (test-results/shots by default).
import { join } from 'node:path'
import { type Locator, type Page } from '@playwright/test'
import { openStudio, pick, toolPanel } from './cad-helpers'
import { expect, test } from './fixtures'

type Size = 'large' | 'medium' | 'small'
const PX: Record<Size, number> = { large: 32, medium: 24, small: 16 }

/** Every visible ribbon button's box, rounded to a tenth of a pixel. */
const boxes = (ribbon: Locator) =>
  ribbon.evaluate((r) =>
    [...r.querySelectorAll<HTMLElement>('button')]
      .filter((b) => b.offsetParent !== null && getComputedStyle(b).visibility !== 'hidden')
      .map((b) => {
        const x = b.getBoundingClientRect()
        return [b.getAttribute('aria-label') ?? b.textContent ?? '', Math.round(x.left * 10) / 10, Math.round(x.top * 10) / 10, Math.round(x.width * 10) / 10, Math.round(x.height * 10) / 10] as const
      }),
  )

/** No two visible buttons overlap, every one is inside the ribbon's row, and the row does not scroll. */
async function fits(ribbon: Locator): Promise<void> {
  // polled: the next slot finds out it has no room one frame after it shows
  await expect.poll(() => ribbon.evaluate((el) => {
    const body = el.querySelector<HTMLElement>('.rb-body')!
    const b = body.getBoundingClientRect()
    const btns = [...body.querySelectorAll<HTMLElement>('button')].filter((x) => x.offsetParent !== null && getComputedStyle(x).visibility !== 'hidden').map((x) => x.getBoundingClientRect())
    let overlaps = 0
    for (let i = 0; i < btns.length; i++) for (let j = i + 1; j < btns.length; j++) {
      const p = btns[i]!, q = btns[j]!
      if (p.left < q.right - 0.5 && q.left < p.right - 0.5 && p.top < q.bottom - 0.5 && q.top < p.bottom - 0.5) overlaps++
    }
    const out = btns.filter((x) => x.right > b.right + 0.5 || x.left < b.left - 0.5 || x.bottom > b.bottom + 0.5).length
    return { overlaps, out, scrolls: body.scrollWidth > body.clientWidth + 1 }
  }), { timeout: 3000 }).toEqual({ overlaps: 0, out: 0, scrolls: false })
}

async function openModel(page: Page, size: Size, width: number, scheme: 'dark' | 'light' = 'dark'): Promise<Locator> {
  await page.setViewportSize({ width, height: 900 })
  await openStudio(page, { appearance: { toolbarSize: size }, scheme, themeFollowsSystem: false })
  await page.locator('.sx-tab[data-mode="design"]').click()
  const ribbon = page.getByTestId('model-shelf')
  await expect(ribbon).toBeVisible()
  await expect(ribbon).toHaveAttribute('data-setting', size)
  return ribbon
}

test.describe('Model ribbon sizes', () => {
  test.skip(({ isMobile }) => isMobile, 'The ribbon is a desktop control; a phone keeps the shelf')

  for (const width of [1440, 1280]) {
    for (const size of ['large', 'medium', 'small'] as const) {
      test(`${size} at ${width} px: drawn at its size, the same height on every tab, nothing moves on press or hover`, async ({ page }) => {
        const ribbon = await openModel(page, size, width)
        const fit = await ribbon.getAttribute('data-fit')
        const px = fit === 'icons' ? 16 : PX[size]
        // icons at the size's grid; names under them unless Small (or the row ran out of room)
        expect(await ribbon.locator('.rb-body svg.ti').first().getAttribute('width')).toBe(String(px))
        await expect(ribbon.locator('[data-tool="push"] .rb-label')).toBeVisible({ visible: size !== 'small' && fit === 'labels' })
        await expect(ribbon.locator('[data-tool="push"]')).toHaveAttribute('data-tip-title', 'Push and pull')
        await fits(ribbon)

        // every tab: the same ribbon height, the tabs and undo/redo in place
        const height = (await ribbon.boundingBox())!.height
        const fixed = () => ribbon.locator('.rb-tabs').evaluate((t) => [...t.querySelectorAll('button')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.left * 10), Math.round(r.top * 10), Math.round(r.width * 10)] }))
        const tabsBefore = await fixed()
        for (const tab of ['mesh', 'sketch', 'solid'] as const) {
          await page.getByTestId(`ribbon-tab-${tab}`).click()
          await expect(page.getByTestId(`ribbon-tab-${tab}`)).toHaveAttribute('aria-selected', 'true')
          expect((await ribbon.boundingBox())!.height, tab).toBeCloseTo(height, 1)
          expect(await fixed(), tab).toEqual(tabsBefore)
          await fits(ribbon)
        }

        // hover, then press: no button moves or changes size
        const before = await boxes(ribbon)
        await ribbon.locator('[data-tool="fillet"]').hover()
        expect(await boxes(ribbon)).toEqual(before)
        await ribbon.locator('[data-tool="measure"]').click()
        await expect(ribbon.locator('[data-tool="measure"]')).toHaveAttribute('aria-pressed', 'true')
        expect(await boxes(ribbon)).toEqual(before)
        await page.keyboard.press('Escape')
      })
    }
  }

  test('the Toolbar size row in Settings changes the ribbon at once', async ({ page }) => {
    const ribbon = await openModel(page, 'large', 1440)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Look and feel' }).click()
    const row = dialog.getByTestId('set-toolbar-size')
    await expect(row).toContainText('32 px')
    await row.getByRole('radio', { name: 'Small' }).click()
    await expect(ribbon).toHaveAttribute('data-setting', 'small')
    expect(await ribbon.locator('.rb-body svg.ti').first().getAttribute('width')).toBe('16')
    await row.getByRole('radio', { name: 'Medium' }).click()
    await expect(ribbon).toHaveAttribute('data-setting', 'medium')
  })

  test('Sketch opens the Sketch tab with its drawing tools, and leaving the sketch goes back', async ({ page }) => {
    const ribbon = await openModel(page, 'large', 1440)
    await expect(page.getByTestId('ribbon-tab-solid')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('ribbon-draw-line')).toHaveCount(0)
    await page.getByTestId('ribbon-tab-sketch').click()
    // nobody is sketching: the drawing tools wait, saying why
    await expect(page.getByTestId('ribbon-draw-line')).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByTestId('ribbon-draw-line')).toHaveAttribute('data-tip-body', 'Start a sketch first.')
    await page.getByTestId('ribbon-tab-solid').click()
    await ribbon.locator('[data-tool="sketch"]').click()
    // the sketch starts on an origin plane; the tab follows it
    await expect(toolPanel(page)).toContainText('Click an origin plane')
    await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, originPlane: 'xy' })
    await expect(page.getByTestId('sketch-finish')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('ribbon-tab-sketch')).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('ribbon-draw-rect').click()
    await expect(page.getByTestId('ribbon-draw-rect')).toHaveAttribute('aria-pressed', 'true')
    await expect(toolPanel(page).getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Rectangle' })).toHaveAttribute('aria-checked', 'true')
    // the panel's pick shows on the ribbon too
    await toolPanel(page).getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Circle' }).click()
    await expect(page.getByTestId('ribbon-draw-circle')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('ribbon-tab-solid').click()
    await expect(page.getByTestId('ribbon-tab-solid')).toHaveAttribute('aria-selected', 'true')
  })
})

test.describe('Model ribbon shots', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop widths')
  for (const scheme of ['dark', 'light'] as const) {
    test(`shots: the ribbon in ${scheme}`, async ({ browser }, info) => {
      test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
      test.setTimeout(240_000)
      const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
      for (const width of [1440, 1280]) {
        for (const size of ['large', 'medium', 'small'] as const) {
          const ctx = await browser.newContext({ baseURL: info.project.use.baseURL, deviceScaleFactor: 2 })
          const page = await ctx.newPage()
          const ribbon = await openModel(page, size, width, scheme)
          await ribbon.locator('[data-tool="push"]').click()
          await ribbon.locator('[data-tool="fillet"]').hover()
          await page.waitForTimeout(400)
          await page.screenshot({ path: join(dir, `ribbon-${width}-${size}-${scheme}.png`) })
          await ribbon.screenshot({ path: join(dir, `ribbon-${width}-${size}-${scheme}-strip.png`) })
          await ctx.close()
        }
      }
    })
  }
})
