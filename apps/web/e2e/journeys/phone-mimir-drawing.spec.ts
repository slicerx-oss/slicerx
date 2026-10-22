// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The size sheet's drawing on a phone, at 390, 360 and 430 px wide: it opens on Top and Isometric side by side, drawn
// large, with every callout on the iso view; a picker in the drawing's header swaps them for Front or Right without
// moving, offering each only when it draws a callout and not shown at all when neither does; no callout covers a view's
// label; a picked row moves back to Top and iso when the view showing does not draw it; and a 44 px control folds the
// drawing to its header, giving the chat the room, and opens it again on the same choice.
import type { Locator, Page, TestInfo } from '@playwright/test'
import { journey, expect } from '../journey'
import { goTab } from '../fixtures'
import { answer, askTab, debugOn, lastUserText, noHorizontalScroll, setPilot, setState, shotsDir, shotsOn, signIn, stubProxy } from './lib/session'

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

/** What the picker offers for the thermostat backplate: it is flat, so Front draws none of its sizes. */
const BACKPLATE = [PANES[0], PANES[2]] as const

/** A straight size from a to b, moved out by off, as a sheet row. */
const span = (key: string, label: string, value: number, a: number[], b: number[], off: number[]) => ({ key, label, value, unit: 'mm', source: 'guess', at: { a, b, off } })

/** Two sheets for a stubbed mimir: a block with a size read in each flat view, and a plate sized only from above. */
const SHEETS = {
  block: {
    title: 'Block sizes',
    views: ['top', 'front', 'side', 'iso'],
    dims: [span('length', 'Length', 40, [-20, -15, 0], [20, -15, 0], [0, -12, 0]), span('height', 'Height', 20, [-20, -15, 0], [-20, -15, 20], [-12, 0, 0]), span('depth', 'Depth', 30, [20, -15, 0], [20, 15, 0], [0, 0, -12])],
    part: [{ plane: 'xy', points: [[-20, -15], [20, -15], [20, 15], [-20, 15]], from: 0, to: 20 }],
  },
  plate: {
    title: 'Plate sizes',
    views: ['top', 'iso'],
    dims: [span('width', 'Width', 60, [-30, -20, 2], [30, -20, 2], [0, -12, 0]), span('depth', 'Depth', 40, [30, -20, 2], [30, 20, 2], [12, 0, 0])],
    part: [{ plane: 'xy', points: [[-30, -20], [30, -20], [30, 20], [-30, 20]], from: 0, to: 2 }],
  },
} as const

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

  journey('Top and iso first, Right behind a picker with no Front for a flat part, no callout over a label, and a 44 px fold', async ({ page }, info) => {
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
      // it opens on Top and Isometric side by side, with the picker naming the choices that draw a callout
      await expect(picker.getByRole('radio')).toHaveText(BACKPLATE.map((p) => p.name))
      await expect(page.getByTestId('mimir-drawing-view-front')).toHaveCount(0)
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
      for (const p of [PANES[0], PANES[2], PANES[0]]) {
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
    for (const p of BACKPLATE) {
      await shots(page, info, `view-${p.id}`, async () => {
        await page.getByTestId(`mimir-drawing-view-${p.id}`).tap()
      })
    }

    // a row picked on the record lights its callout; from Right, which does not draw the center hole, the drawing moves
    // back to Top and iso
    await page.getByTestId('mimir-drawing-view-side').tap()
    const hole = rec.locator('.sheet-rec-row[data-dim="center_hole"] input')
    await hole.focus()
    await expect(page.getByTestId('mimir-drawing-view-main')).toHaveAttribute('aria-checked', 'true')
    await expect(drawing.locator('.mimir-drawing-cell')).toHaveCount(2)
    await expect(page.locator('[data-testid="mimir-sheet-callout"][data-key="center_hole"][data-on]')).toHaveCount(2)
    // and a callout picks its row
    const screw = rec.locator('.sheet-rec-row[data-dim="screw_hole"] input')
    await drawing.locator('.mimir-drawing-cell[data-view="top"] [data-testid="mimir-sheet-callout"][data-key="screw_hole"]').click()
    await expect(screw).toBeFocused()
    await screw.blur()

    // the fold: 44 px, named for what it does, folds the drawing to its header and gives the chat the room
    await page.getByTestId('mimir-drawing-view-side').tap()
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
      await expect(drawing.locator('.mimir-drawing-cell')).toHaveAttribute('data-view', 'side')
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

  journey('the picker offers Front and Right only when they draw a callout, and is not shown when neither does', async ({ page }, info) => {
    journey.slow()
    await debugOn(page)
    await goTab(page, 'prepare')
    await setPilot(page, 'cloud')
    await setState(page, { plate: [], selection: null, selectedIds: [], toast: null })
    // a stubbed mimir answers "Size a block" and "Size a plate" with their sheets, and a sheet's answer with a line
    await stubProxy(page, (body) => {
      const text = lastUserText(body)
      if (text.includes('tool_result')) return answer('Noted.')
      const key = (['block', 'plate'] as const).find((k) => text.includes(`Size a ${k}`))
      return key ? [{ type: 'tool_use', id: `tu_${key}`, name: 'pilot.sheet', input: SHEETS[key] }] : answer('Ok.')
    })
    await signIn(page)
    await page.locator('[data-testid="phone-tabs"] [data-tab="mimir"]').click()
    const chat = page.getByTestId('mimir-chat')
    await expect(chat).toBeVisible()
    const again = chat.getByRole('button', { name: 'New conversation' })
    if (await again.isVisible()) await again.click()
    const drawing = page.getByTestId('mimir-sheet-drawing')
    const picker = drawing.getByRole('radiogroup', { name: 'Drawing view' })
    const head = drawing.locator('.mimir-drawing-head')
    const fold = page.getByTestId('mimir-drawing-fold')

    // the block has a size in each flat view, so all three choices are offered and each draws its callout
    await askTab(page, 'Size a block')
    await expect(drawing).toBeVisible({ timeout: 30_000 })
    await expect(drawing).toHaveAttribute('data-phone', 'true')
    const heads: Box[] = []
    for (const phone of PHONES) {
      await page.setViewportSize(phone)
      await expect(picker.getByRole('radio')).toHaveText(PANES.map((p) => p.name))
      for (const p of [PANES[1], PANES[2], PANES[0]]) {
        await page.getByTestId(`mimir-drawing-view-${p.id}`).tap()
        await expect.poll(async () => (await shownViews(drawing)).map((s) => s.view)).toEqual([...p.views])
        for (const s of await shownViews(drawing)) expect(s.dots.length, `callouts in ${s.view} at ${phone.width} px`).toBeGreaterThan(0)
      }
      heads.push(await box(head))
      await noHorizontalScroll(page)
    }
    await page.setViewportSize(PHONES[0])
    await shots(page, info, 'block-all-views')
    await page.getByTestId('mimir-sheet-record').last().getByTestId('mimir-sheet-confirm').click()
    await expect(drawing).toHaveCount(0)

    // the plate is sized only from above: no picker, the header names the drawing at the same height, and the fold
    // still folds it
    await askTab(page, 'Size a plate')
    await expect(drawing).toBeVisible({ timeout: 30_000 })
    for (const [i, phone] of PHONES.entries()) {
      await page.setViewportSize(phone)
      await expect(picker).toHaveCount(0)
      await expect(drawing.getByTestId('mimir-drawing-views')).toHaveCount(0)
      await expect(drawing.getByTestId('mimir-drawing-name')).toHaveText('Drawing')
      await expect.poll(async () => (await shownViews(drawing)).map((s) => s.view)).toEqual(['top', 'iso'])
      const at = await box(head)
      expect(Math.abs(at.height - heads[i]!.height), `the header's height at ${phone.width} px`).toBeLessThanOrEqual(0.5)
      // the name runs up to the fold, so no gap is left where the picker was
      const name = await box(drawing.getByTestId('mimir-drawing-name'))
      const f = await box(fold)
      expect(f.x - (name.x + name.width), `the gap before the fold at ${phone.width} px`).toBeLessThanOrEqual(8.5)
      await noHorizontalScroll(page)
    }
    await page.setViewportSize(PHONES[0])
    await shots(page, info, 'plate-no-picker')
    const at = await box(fold)
    await fold.tap()
    await expect(drawing.locator('.mimir-drawing-grid')).toBeHidden()
    await expect(drawing.getByTestId('mimir-drawing-name')).toHaveText('Drawing')
    same(at, await box(fold), 'the fold, folded with no picker')
    await fold.tap()
    await expect(drawing.locator('.mimir-drawing-cell')).toHaveCount(2)
    same(at, await box(fold), 'the fold, opened with no picker')
  })
})
