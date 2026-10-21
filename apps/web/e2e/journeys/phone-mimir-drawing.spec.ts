// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The size sheet's drawing on a phone, at 390, 360 and 430 px wide: it opens on Top and Isometric side by side, drawn
// large, with every callout on the iso view; a picker in the drawing's header swaps them for Front or Right without
// moving; no callout covers a view's label; a picked row moves back to Top and iso when the view showing does not draw
// it; and a 44 px control folds the drawing to its header, giving the chat the room, and opens it again on the same
// choice.
import type { Locator, Page, TestInfo } from '@playwright/test'
import { journey, expect } from '../journey'
import { goTab } from '../fixtures'
import { askTab, debugOn, noHorizontalScroll, setPilot, setState, shotsDir, shotsOn } from './lib/session'

journey.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', cadTools: true } })

/** The phone widths, with the heights of the phones they stand for. */
const PHONES = [
  { width: 390, height: 844 },
  { width: 360, height: 780 },
  { width: 430, height: 932 },
] as const

/** The picker's choices, in its order, with their names and the views each draws, left to right, by their labels. */
const PANES = [
  { id: 'main', name: 'Top and iso', views: ['top', 'iso'], labels: ['Top, XY', 'Isometric'] },
  { id: 'front', name: 'Front', views: ['front'], labels: ['Front, XZ'] },
  { id: 'side', name: 'Right', views: ['side'], labels: ['Right, YZ'] },
] as const

type Box = { x: number; y: number; width: number; height: number }

const box = async (l: Locator): Promise<Box> => (await l.boundingBox())!

/** The same place and size, to half a pixel. */
function same(a: Box, b: Box, what: string): void {
  expect(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height)), what).toBeLessThanOrEqual(0.5)
}

/** The mimir tab from the tab bar, on the scripted replies, with a new conversation and nothing on the plate. */
async function phoneMimir(page: Page): Promise<void> {
  await debugOn(page)
  await goTab(page, 'prepare')
  await setPilot(page, 'scripted')
  await setState(page, { plate: [], selection: null, selectedIds: [], toast: null })
  await page.locator('[data-testid="phone-tabs"] [data-tab="mimir"]').click()
  const chat = page.getByTestId('mimir-chat')
  await expect(chat).toBeVisible()
  await chat.getByRole('button', { name: 'New conversation' }).click()
}

/** The views on show, left to right, with each callout's badge and the label's box, for the overlap and frame checks. */
async function shownViews(drawing: Locator): Promise<{ view: string | null; cell: Box; label: Box; label_text: string; dots: Box[] }[]> {
  return drawing.locator('.mimir-drawing-cell').evaluateAll((cells) => {
    const r = (el: Element) => {
      const b = el.getBoundingClientRect()
      return { x: b.x, y: b.y, width: b.width, height: b.height }
    }
    return cells.map((cell) => {
      const label = cell.querySelector('.mimir-drawing-label')!
      return {
        view: cell.getAttribute('data-view'),
        cell: r(cell),
        label: r(label),
        label_text: label.textContent ?? '',
        // the drawn badge, not an invisible touch circle around it
        dots: Array.from(cell.querySelectorAll('.mimir-callout circle:not(.mimir-callout-hit)'), r),
      }
    })
  })
}

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** Review shots at both widths in light and dark, when shots are on. */
async function shots(page: Page, info: TestInfo, name: string, before?: () => Promise<void>): Promise<void> {
  if (!shotsOn()) return
  const size = page.viewportSize()!
  for (const phone of PHONES) {
    await page.setViewportSize(phone)
    for (const scheme of ['light', 'dark'] as const) {
      await setState(page, { scheme, themeFollowsSystem: false })
      await before?.()
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${shotsDir(info)}/${name}-phone-${phone.width}-${scheme}.png` })
    }
  }
  await setState(page, { scheme: 'dark', themeFollowsSystem: false })
  await page.setViewportSize(size)
}

journey.describe('the size drawing on a phone', () => {
  journey.skip(({ isMobile }) => !isMobile, 'The phone project')

  journey('Top and iso first, Front and Right behind a picker, no callout over a label, and a 44 px fold', async ({ page }, info) => {
    journey.slow()
    await phoneMimir(page)
    await askTab(page, 'Make a backplate for my thermostat')
    const yes = page.getByRole('button', { name: 'Yes, that one' })
    await expect(yes).toBeVisible({ timeout: 30_000 })
    await yes.click()
    const rec = page.getByTestId('mimir-sheet-record').last()
    await expect(rec).toBeVisible({ timeout: 30_000 })
    const drawing = page.getByTestId('mimir-sheet-drawing')
    await expect(drawing).toBeVisible()
    await expect(drawing).toHaveAttribute('data-phone', 'true')
    const picker = drawing.getByRole('radiogroup', { name: 'Drawing view' })
    const fold = page.getByTestId('mimir-drawing-fold')
    const vp = page.locator('.studio > .vp')
    await shots(page, info, 'sheet-waiting')

    for (const phone of PHONES) {
      await page.setViewportSize(phone)
      // it opens on Top and Isometric side by side, with the picker naming its three choices
      await expect(picker.getByRole('radio')).toHaveText(PANES.map((p) => p.name))
      await expect(page.getByTestId('mimir-drawing-view-main')).toHaveAttribute('aria-checked', 'true')
      await expect(drawing.locator('.mimir-drawing-cell')).toHaveCount(2)
      await expect(drawing.locator('.mimir-drawing-cell > svg')).toHaveCount(2)
      // every control in the header takes a 44 px touch
      for (const c of [...(await picker.getByRole('radio').all()), fold]) {
        const b = await box(c)
        expect(b.width, `${await c.textContent()} at ${phone.width} px`).toBeGreaterThanOrEqual(44 - 0.5)
        expect(b.height, `${await c.textContent()} at ${phone.width} px`).toBeGreaterThanOrEqual(44 - 0.5)
      }
      const pickerAt = await box(picker)
      const foldAt = await box(fold)
      for (const p of [PANES[0], PANES[1], PANES[2], PANES[0]]) {
        const radio = page.getByTestId(`mimir-drawing-view-${p.id}`)
        const at = await box(radio)
        await radio.tap()
        await expect(radio).toHaveAttribute('aria-checked', 'true')
        await expect(drawing.locator('.mimir-drawing-cell')).toHaveCount(p.views.length)
        await expect.poll(async () => (await shownViews(drawing)).map((s) => s.view)).toEqual([...p.views])
        // pressing a choice moves nothing in the header
        same(at, await box(radio), `${p.name} at ${phone.width} px`)
        same(pickerAt, await box(picker), `the picker after ${p.name}`)
        same(foldAt, await box(fold), `the fold after ${p.name}`)
        const shown = await shownViews(drawing)
        expect(shown.map((s) => s.label_text)).toEqual([...p.labels])
        // the views share the frame's width
        const frame = await box(drawing.locator('.mimir-drawing-grid'))
        for (const s of shown) expect(s.cell.width).toBeGreaterThanOrEqual(frame.width / p.views.length - 1)
        for (const s of shown) {
          // the iso view carries every size (Front draws none of this part's); each callout stays in its view and off its label
          if (s.view === 'iso') expect(s.dots).toHaveLength(6)
          for (const d of s.dots) {
            expect(overlaps(d, s.label), `a callout over "${s.label_text}" at ${phone.width} px`).toBe(false)
            expect(d.x).toBeGreaterThanOrEqual(s.cell.x - 0.5)
            expect(d.x + d.width).toBeLessThanOrEqual(s.cell.x + s.cell.width + 0.5)
            expect(d.y + d.height).toBeLessThanOrEqual(s.cell.y + s.cell.height + 0.5)
          }
        }
      }
      await noHorizontalScroll(page)
    }
    await page.setViewportSize(PHONES[0])
    for (const p of PANES) {
      await shots(page, info, `view-${p.id}`, async () => {
        await page.getByTestId(`mimir-drawing-view-${p.id}`).tap()
      })
    }

    // a row picked on the record lights its callout; from Front, which does not draw the thickness, the drawing moves
    // back to Top and iso
    await page.getByTestId('mimir-drawing-view-front').tap()
    const thickness = rec.locator('.sheet-rec-row[data-dim="thickness"] input')
    await thickness.focus()
    await expect(page.getByTestId('mimir-drawing-view-main')).toHaveAttribute('aria-checked', 'true')
    await expect(drawing.locator('.mimir-drawing-cell')).toHaveCount(2)
    await expect(page.locator('[data-testid="mimir-sheet-callout"][data-key="thickness"][data-on]')).toHaveCount(1)
    // and a callout picks its row
    await drawing.locator('.mimir-drawing-cell[data-view="top"] [data-testid="mimir-sheet-callout"][data-key="center_hole"]').click()
    await expect(rec.locator('.sheet-rec-row[data-dim="center_hole"] input')).toBeFocused()
    await thickness.blur()

    // the fold: 44 px, named for what it does, folds the drawing to its header and gives the chat the room
    await page.getByTestId('mimir-drawing-view-front').tap()
    for (const phone of PHONES) {
      await page.setViewportSize(phone)
      await expect(fold).toHaveAccessibleName('Hide drawing')
      await expect(fold).toHaveAttribute('aria-expanded', 'true')
      const at = await box(fold)
      const open = await box(vp)
      const chatOpen = await box(page.getByTestId('mimir-chat'))
      await fold.tap()
      await expect(fold).toHaveAccessibleName('Show drawing')
      await expect(fold).toHaveAttribute('aria-expanded', 'false')
      await expect(drawing.locator('.mimir-drawing-grid')).toBeHidden()
      await expect(page.getByTestId('mimir-drawing-status')).toBeHidden()
      await expect(vp).toHaveAttribute('data-mimir-drawing', 'folded')
      await expect.poll(async () => (await box(vp)).height).toBeLessThan(open.height - 100)
      expect((await box(page.getByTestId('mimir-chat'))).height).toBeGreaterThan(chatOpen.height + 100)
      // the control holds still while it folds
      same(at, await box(fold), `the fold, folded at ${phone.width} px`)
      expect(at.width).toBeGreaterThanOrEqual(44 - 0.5)
      expect(at.height).toBeGreaterThanOrEqual(44 - 0.5)
      await noHorizontalScroll(page)
      if (phone === PHONES[1]) await shots(page, info, 'folded')
      // open again, on the view it had
      await fold.tap()
      await expect(fold).toHaveAccessibleName('Hide drawing')
      await expect(vp).not.toHaveAttribute('data-mimir-drawing')
      await expect(drawing.locator('.mimir-drawing-cell')).toHaveAttribute('data-view', 'front')
      same(at, await box(fold), `the fold, opened at ${phone.width} px`)
      await expect.poll(async () => (await box(vp)).height).toBeGreaterThan(open.height - 1)
    }

    // folded when confirmed: the build still lands, and the view comes back for the part and its lookup card
    await page.setViewportSize(PHONES[0])
    await fold.tap()
    await rec.getByTestId('mimir-sheet-confirm').click()
    await expect(drawing).toHaveCount(0)
    await expect(vp).not.toHaveAttribute('data-mimir-drawing')
    await expect(page.getByTestId('mimir-transcript')).toContainText('The backplate is on the plate', { timeout: 60_000 })
    await shots(page, info, 'lookup-card')
  })
})
