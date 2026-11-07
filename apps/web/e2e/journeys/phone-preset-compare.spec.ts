// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey: Compare presets in Settings > Presets, at desktop width and at phone width (this file runs in both projects).
// The count and the column header stay at the top while the list scrolls, the copy arrow and the Show all switch have a
// hit area of 44 px on a phone and the switch's label toggles it, the copy tip leaves the rows alone and never opens
// from a tap or a click, "1 layer" is singular, the Kind select reads at the size of its neighbors, the desktop list
// scrolls inside itself, and a copy says what it did without moving anything.
import { type Locator, type Page } from '@playwright/test'
import { expect, test } from './lib/shell'
import { compareDraftFine, compareLongFine, DRAFT, LONG, openPresets, seedPresets, shutSettings } from './lib/preset-compare'

type Box = { x: number; y: number; width: number; height: number }
const box = async (l: Locator): Promise<Box> => (await l.boundingBox())!

/**
 * The probe points of a `size` square centered on `el` (edges, and corners rounded 4 px) that do not press `el`, with what they land on instead: a point
 * presses it when it lands on it, inside it, or on the label that names it. Empty when the whole square does.
 */
async function hitSquare(page: Page, el: Locator, size: number): Promise<string[]> {
  await el.scrollIntoViewIfNeeded()
  const b = await box(el)
  return el.evaluate(
    (target, { b, size }) => {
      const miss = (x: number, y: number) => {
        const hit = document.elementFromPoint(x, y)
        if (hit && (target === hit || target.contains(hit) || hit.closest('label')?.control === target)) return null
        return `${Math.round(x - b.x)},${Math.round(y - b.y)}: ${hit ? `${hit.tagName.toLowerCase()}.${hit.className}` : 'nothing'}`
      }
      const cx = b.x + b.width / 2
      const cy = b.y + b.height / 2
      const r = size / 2 - 1
      // The corners sit 4 px in: a drawn control's rounded corner is not part of it.
      const c = r - 4
      return [[-c, -c], [c, -c], [-c, c], [c, c], [-r, 0], [r, 0], [0, -r], [0, r]].map(([dx, dy]) => miss(cx + dx!, cy + dy!)).filter((m): m is string => m !== null)
    },
    { b, size },
  )
}

test.describe('Compare presets', () => {
  let dialog: Locator
  test.beforeEach(async ({ page }) => {
    await seedPresets(page)
    dialog = await openPresets(page)
    await compareDraftFine(dialog)
  })
  test.afterEach(async ({ page }) => {
    await shutSettings(page)
  })

  test('the count and the column header stay at the top while the list scrolls', async ({ page, isMobile }) => {
    await dialog.getByTestId('preset-compare-all').click()
    const list = dialog.locator('.cmp-list')
    const top = dialog.locator('.cmp-top')
    const head = dialog.locator('.cmp-head')
    const status = dialog.getByRole('status')
    const body = page.locator('dialog.settings-dialog .sx-dialog-body')
    const rows = dialog.getByTestId('preset-compare-row')
    await expect(rows.nth(40)).toBeAttached()
    // Own scroll box at desktop width; on a phone the dialog body is the one scroll box (UI spec 9).
    const own = await list.evaluate((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY))
    expect(own).toBe(!isMobile)
    // Scroll the rows well past the top: the list's own box, then the dialog body past the section's start.
    await list.evaluate((el) => {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el.scrollTop = 600
    })
    await body.evaluate((b) => {
      const l = b.querySelector('.cmp-list')!
      b.scrollTop += l.getBoundingClientRect().top - b.getBoundingClientRect().top + 600
    })
    const bodyTop = (await box(body)).y
    await expect.poll(async () => Math.abs((await box(top)).y - bodyTop)).toBeLessThanOrEqual(1.5)
    // The first rows went up past it, and nothing covers the count or the preset names.
    expect((await box(rows.first())).y).toBeLessThan((await box(head)).y)
    const onTop = (l: Locator) =>
      l.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const hit = document.elementFromPoint(r.x + Math.min(20, r.width / 2), r.y + r.height / 2)
        return hit !== null && el.contains(hit)
      })
    expect(await onTop(status)).toBe(true)
    expect(await onTop(head.locator('span').nth(1))).toBe(true)
    await expect(status).toHaveText(/settings? differs?/)
    await expect(head).toContainText(DRAFT)
    // It keeps an opaque surface and its rule, so rows pass under it without showing through.
    const look = await top.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { bg: cs.backgroundColor, pos: cs.position, rule: getComputedStyle(el.querySelector('.cmp-head')!).borderBottomWidth }
    })
    expect(look.pos).toBe('sticky')
    expect(look.bg).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
    expect(look.bg).not.toMatch(/rgba\(.*, 0\.\d+\)$/)
    expect(look.rule).toBe('1px')
    await dialog.getByTestId('preset-compare-all').click()
    await expect(rows).toHaveCount(7)
  })

  test('the copy arrow and the Show all switch have a hit area of 44 px on a phone, 28 px on a desktop', async ({ page, isMobile }) => {
    const want = isMobile ? 44 : 28
    expect(await hitSquare(page, dialog.getByTestId('preset-compare-copy').first(), want)).toEqual([])
    expect(await hitSquare(page, dialog.getByTestId('preset-compare-copy').last(), want)).toEqual([])
    expect(await hitSquare(page, dialog.getByTestId('preset-compare-all'), want)).toEqual([])
    // The drawn controls keep their size.
    expect((await box(dialog.getByTestId('preset-compare-all'))).width).toBeCloseTo(36, 0)
    expect((await box(dialog.getByTestId('preset-compare-all'))).height).toBeCloseTo(20, 0)
    expect((await box(dialog.getByTestId('preset-compare-copy').first())).width).toBeCloseTo(28, 0)
  })

  test('the Show all label is part of the switch: pressing the words or the gap toggles it', async ({ page, isMobile }) => {
    const sw = dialog.getByTestId('preset-compare-all')
    const words = dialog.getByText('Show all', { exact: true })
    await expect(sw).toHaveAccessibleName('Show all')
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    if (isMobile) await words.tap()
    else await words.click()
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    // The gap between the words and the track.
    const w = await box(words)
    const t = await box(sw)
    const x = (w.x + w.width + t.x) / 2
    if (isMobile) await page.touchscreen.tap(x, t.y + t.height / 2)
    else await page.mouse.click(x, t.y + t.height / 2)
    await expect(sw).toHaveAttribute('aria-checked', 'false')
  })

  test('a tap or a click on a copy arrow leaves no tip over the rows that move up under it', async ({ page, isMobile }) => {
    const rows = dialog.getByTestId('preset-compare-row')
    const copy = rows.nth(1).getByTestId('preset-compare-copy')
    await copy.scrollIntoViewIfNeeded()
    if (isMobile) await copy.tap()
    else {
      // The pointer comes to the arrow and rests there; its own tip may show while it waits, and the click closes it.
      await copy.hover()
      await copy.click()
    }
    await expect(rows).toHaveCount(6)
    // The next row's arrow now sits under the resting finger or pointer; it gets no tip until the pointer moves.
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(150)
      expect(await page.locator('.sx-tip[data-ready]').count(), `a tip ${150 * (i + 1)} ms after the copy`).toBe(0)
    }
    await dialog.getByTestId('preset-compare-undo').click()
    await expect(rows).toHaveCount(7)
  })

  test('the copy tip opens clear of the values of the row and the rows under it', async ({ page, isMobile }) => {
    test.skip(isMobile, 'A finger has no hover tip; the tap that copies removes the row.')
    const rows = dialog.getByTestId('preset-compare-row')
    const copy = rows.nth(1).getByTestId('preset-compare-copy')
    await copy.scrollIntoViewIfNeeded()
    await page.mouse.move(1, 1)
    await copy.hover()
    const tip = page.locator('.sx-tip[data-ready]')
    await expect(tip).toContainText(`Use this value in ${DRAFT}`)
    const t = await box(tip)
    const overlaps = (b: Box) => t.x < b.x + b.width && b.x < t.x + t.width && t.y < b.y + b.height && b.y < t.y + t.height
    const row = rows.nth(1)
    for (const td of await row.locator('td').all()) expect(overlaps(await box(td)), 'a value of the row').toBe(false)
    const count = await rows.count()
    for (let i = 2; i < count; i++) for (const td of await rows.nth(i).locator('td').all()) expect(overlaps(await box(td)), `a value of row ${i}`).toBe(false)
  })

  test('one layer reads in the singular', async () => {
    const raft = dialog.locator('[data-testid="preset-compare-row"][data-key="raft_layers"]')
    await expect(raft).toContainText('1 layer')
    await expect(raft).toContainText('2 layers')
    await expect(raft).not.toContainText('1 layers')
  })

  test('the Kind select reads at the size of the selects beside it, and shows each kind whole at every width', async ({ page, isMobile }) => {
    // What each select shows: its face when it has one, else its own text.
    const shown = (sel: string) =>
      dialog.locator(sel).evaluate((el) => {
        const face = el.parentElement?.querySelector('.sx-select-face > span')
        const cs = getComputedStyle(face ?? el)
        return { size: cs.fontSize, weight: cs.fontWeight, family: cs.fontFamily }
      })
    const kind = await shown('#cmp-kind')
    expect(kind).toEqual(await shown('#cmp-a'))
    expect(kind).toEqual(await shown('#cmp-b'))
    expect(parseFloat(kind.size)).toBeLessThanOrEqual(14)
    const face = dialog.locator('#cmp-kind').locator('xpath=..').locator('.sx-select-face > span')
    await expect(face).toHaveText('Process')
    // The select sizes itself to its longest option in its own font; with that font at least the face's size (the same on
    // a desktop, 16 px on a phone), no kind's name is cut on any platform, whatever its font metrics.
    expect(parseFloat(await dialog.locator('#cmp-kind').evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(parseFloat(kind.size))
    const vp = page.viewportSize()!
    try {
      for (const size of isMobile ? [vp] : [vp, { width: 960, height: 600 }]) {
        await page.setViewportSize(size)
        for (const [value, label] of [['filament', 'Filament'], ['printer', 'Printer'], ['process', 'Process']] as const) {
          await dialog.locator('#cmp-kind').selectOption(value)
          await expect(face).toHaveText(label)
          const fit = await face.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
          expect(fit.scroll, `${label} at ${size.width}`).toBeLessThanOrEqual(fit.client)
        }
      }
    } finally {
      await page.setViewportSize(vp)
    }
  })

  test('at desktop width the list scrolls inside itself and shows a real share of the rows', async ({ page, isMobile }) => {
    test.skip(isMobile, 'On a phone the dialog body is the one scroll box.')
    await dialog.getByTestId('preset-compare-all').click()
    const list = dialog.locator('.cmp-list')
    await list.scrollIntoViewIfNeeded()
    const m = await list.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight, overflow: getComputedStyle(el).overflowY }))
    expect(m.overflow).toBe('auto')
    expect(m.scroll).toBeGreaterThan(m.client)
    // At the 900 px window of the desktop project: at least eight rows' worth, and the list ends above the dialog's footer.
    expect(m.client).toBeGreaterThanOrEqual(300)
    const foot = await box(page.locator('dialog.settings-dialog .sx-dialog-foot'))
    const listBox = await box(list)
    expect(listBox.y + listBox.height).toBeLessThanOrEqual(foot.y)
  })

  test('a copy says what it did on the status line, and nothing around it moves', async ({ page }) => {
    const status = dialog.getByRole('status')
    await expect(status).toHaveText('7 settings differ')
    const watch = ['#cmp-kind', '#cmp-a', '#cmp-b', '[data-testid=preset-compare-all]', '[data-testid=preset-compare-undo]', '.cmp-head', '[data-testid=preset-compare-group]'] as const
    const rects = () => Promise.all(watch.map(async (s) => box(dialog.locator(s).first())))
    const raft = dialog.locator('[data-testid="preset-compare-row"][data-key="raft_layers"]')
    // In view first, so the press itself scrolls nothing, with the dialog body scrolled to its end: Raft layers is the only
    // row of its group, so the copy takes a whole group out of the list, and a body that got shorter would pull its scroll
    // position and everything in it.
    await raft.getByTestId('preset-compare-copy').scrollIntoViewIfNeeded()
    await page.locator('dialog.settings-dialog .sx-dialog-body').evaluate((b) => (b.scrollTop = b.scrollHeight))
    await expect(raft.getByTestId('preset-compare-copy')).toBeInViewport()
    // The dialog itself never scrolls: only its body does. A dialog that could be scrolled (bringing a control into view
    // once did it) and was put back by the next layout moved every control by that much after a copy.
    const shell = page.locator('dialog.settings-dialog')
    expect(await shell.evaluate((d) => ((d.scrollTop = 70), d.scrollTop))).toBe(0)
    const before = await rects()
    await raft.getByTestId('preset-compare-copy').click()
    await expect(status).toHaveText(`Copied Raft layers to ${DRAFT}`)
    await expect(dialog.locator('[data-testid=preset-compare-group][data-group=adhesion]')).toHaveCount(0)
    expect(await dialog.getByRole('status').count()).toBe(1)
    await expect(status).not.toContainText('raft_layers')
    const after = await rects()
    // The row left the list, so the first group may change height; the controls and the status line stay put.
    for (let i = 0; i < watch.length - 1; i++) expect(after[i], watch[i]).toEqual(before[i])
    // The next action clears it.
    await dialog.getByTestId('preset-compare-all').click()
    await expect(status).toHaveText('6 settings differ')
    await dialog.getByTestId('preset-compare-all').click()
    await dialog.getByTestId('preset-compare-undo').click()
    await expect(status).toHaveText('7 settings differ')
  })

  test('the room a copy leaves in the list stays until the next action of another kind', async () => {
    const list = dialog.locator('.cmp-list')
    const minH = () => list.evaluate((el) => (el as HTMLElement).style.minHeight)
    const copyRaft = async () => {
      const arrow = dialog.locator('[data-testid="preset-compare-row"][data-key="raft_layers"]').getByTestId('preset-compare-copy')
      await arrow.scrollIntoViewIfNeeded()
      const h = await list.evaluate((el) => (el as HTMLElement).offsetHeight)
      await arrow.click()
      await expect(dialog.getByRole('status')).toHaveText(`Copied Raft layers to ${DRAFT}`)
      // The list keeps its height; the room sits under the last group, so nothing reads as a gap between groups.
      expect(await list.evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(h)
      const last = await dialog.getByTestId('preset-compare-group').last().boundingBox()
      const l = (await list.boundingBox())!
      expect(last!.y + last!.height).toBeLessThan(l.y + l.height)
      expect(await minH()).toBe(`${h}px`)
    }
    const undoIt = async () => {
      await dialog.getByTestId('preset-compare-undo').click()
      await expect(dialog.getByRole('status')).toHaveText('7 settings differ')
    }
    // Undo keeps it (the row comes back into the room); Show all clears it.
    await copyRaft()
    await undoIt()
    expect(await minH()).not.toBe('')
    await dialog.getByTestId('preset-compare-all').click()
    expect(await minH()).toBe('')
    await dialog.getByTestId('preset-compare-all').click()
    // Compare with clears it.
    await copyRaft()
    await undoIt()
    await dialog.locator('#cmp-b').selectOption('stock')
    await dialog.locator('#cmp-b').selectOption('preset:e2e-cmp-fine')
    expect(await minH()).toBe('')
    // Picking the preset clears it.
    await copyRaft()
    await undoIt()
    await dialog.locator('#cmp-a').selectOption('e2e-cmp-fine')
    await dialog.locator('#cmp-a').selectOption('e2e-cmp-draft')
    await dialog.locator('#cmp-b').selectOption('preset:e2e-cmp-fine')
    expect(await minH()).toBe('')
    // So does the Kind.
    await copyRaft()
    await undoIt()
    await dialog.locator('#cmp-kind').selectOption('filament')
    await dialog.locator('#cmp-kind').selectOption('process')
    await compareDraftFine(dialog)
    expect(await minH()).toBe('')
  })

  test('a copy into a preset with a long name keeps the line inside the section: Undo, Show all and the header stay put', async ({ page }) => {
    await compareLongFine(dialog)
    const section = dialog.locator('section.cmp')
    const status = dialog.getByRole('status')
    const undo = dialog.getByTestId('preset-compare-undo')
    const watch = ['[data-testid=preset-compare-all]', '[data-testid=preset-compare-undo]', '.cmp-head', '.cmp-status'] as const
    const rects = () => Promise.all(watch.map(async (s) => box(dialog.locator(s).first())))
    const copy = dialog.locator('[data-testid="preset-compare-row"][data-key="layer_height"]').getByTestId('preset-compare-copy')
    await copy.scrollIntoViewIfNeeded()
    const before = await rects()
    await copy.click()
    const said = `Copied Layer height to ${LONG}`
    await expect(status).toHaveText(said)
    // Cut short with an ellipsis inside the section; the whole line is its text (read out as it is) and its tip.
    const s = await box(section)
    for (const el of [status, undo, dialog.getByTestId('preset-compare-all'), dialog.locator('.cmp-head')]) {
      const b = await box(el)
      expect(b.x).toBeGreaterThanOrEqual(s.x - 0.5)
      expect(b.x + b.width).toBeLessThanOrEqual(s.x + s.width + 0.5)
    }
    const cut = await status.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, overflow: getComputedStyle(el).textOverflow }))
    expect(cut.scroll).toBeGreaterThan(cut.client)
    expect(cut.overflow).toBe('ellipsis')
    await expect(status).toHaveAttribute('data-tip-title', said)
    await expect(undo).toBeEnabled()
    // Nothing scrolls sideways, and the header lines up with the rows under it.
    const wide = await page.locator('dialog.settings-dialog .sx-dialog-body').evaluate((b) => b.scrollWidth - b.clientWidth)
    expect(wide).toBeLessThanOrEqual(0)
    const head = await box(dialog.locator('.cmp-head'))
    const list = await box(dialog.locator('.cmp-list'))
    expect(Math.abs(head.x + head.width - (list.x + list.width))).toBeLessThanOrEqual(1)
    // Static: the switch, Undo, the header and the line itself are where they were before the press.
    const after = await rects()
    for (let i = 0; i < watch.length; i++) expect(after[i], watch[i]).toEqual(before[i])
    await undo.click()
  })

  test('Show all marks the rows that differ, in words and a shape as well as color', async () => {
    await dialog.getByTestId('preset-compare-all').click()
    const rows = dialog.getByTestId('preset-compare-row')
    await expect(rows.nth(40)).toBeAttached()
    const differs = dialog.locator('[data-testid="preset-compare-row"][data-differs="true"]')
    await expect(differs).toHaveCount(7)
    const alike = dialog.locator('[data-testid="preset-compare-row"]:not([data-differs])').first()
    // The row header says so to a screen reader.
    await expect(differs.first().getByRole('rowheader')).toHaveAccessibleName(/, differs$/)
    await expect(alike.getByRole('rowheader')).not.toHaveAccessibleName(/differs/)
    // A bar at the row's start that the alike rows do not have.
    const mark = (l: Locator) => l.evaluate((el) => getComputedStyle(el).boxShadow)
    expect(await mark(differs.first())).toMatch(/inset/)
    expect(await mark(alike)).toBe('none')
    // Only Show all marks them: with only the differing rows listed, every row would carry it.
    await dialog.getByTestId('preset-compare-all').click()
    await expect(rows).toHaveCount(7)
    expect(await mark(rows.first())).toBe('none')
  })

  test('at a 960 by 600 window the list shows a usable share of the rows', async ({ page, isMobile }) => {
    test.skip(isMobile, 'On a phone the dialog body is the one scroll box.')
    const vp = page.viewportSize()!
    try {
      await page.setViewportSize({ width: 960, height: 600 })
      await dialog.getByTestId('preset-compare-all').click()
      const list = dialog.locator('.cmp-list')
      // Bring the section's bar to the top of the dialog body, as a person scrolling to the list does.
      const body = page.locator('dialog.settings-dialog .sx-dialog-body')
      await body.evaluate((b) => {
        const t = b.querySelector('.cmp-top')!
        b.scrollTop += t.getBoundingClientRect().top - b.getBoundingClientRect().top
      })
      const m = await list.evaluate((el) => ({ client: el.clientHeight }))
      // About nine rows, where it had five.
      expect(m.client).toBeGreaterThanOrEqual(340)
      const foot = await box(page.locator('dialog.settings-dialog .sx-dialog-foot'))
      const listBox = await box(list)
      expect(listBox.y + listBox.height).toBeLessThanOrEqual(foot.y)
    } finally {
      await page.setViewportSize(vp)
    }
  })
})
