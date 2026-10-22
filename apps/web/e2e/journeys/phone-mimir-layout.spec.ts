// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab against the UI spec, on a phone at 360, 390 and 430 px wide: the chat column keeps 16 px gutters with
// no sideways scroll, the header hides the design's name beside the Sample replies badge, which shows whole, the sizes panel's
// fields sit on the 96 px control column with long labels wrapping instead of cut off, nothing is cut off or runs past
// the edge at 430, Escape puts the sizes panel away and hands focus back to Edit sizes, and the folded drawing's header
// and the panel's hint pass contrast at 1x in both themes. On the desktop, one line of the composer is 44 px inside its
// border with its gaps on the spacing scale.
import type { Locator, Page } from '@playwright/test'
import { journey, expect } from '../journey'
import { goTab } from '../fixtures'
import { askTab, debugOn, emptyMimirTab, noHorizontalScroll, setPilot, setState } from './lib/session'
import { clippedText, contrastOf, pastTheEdge, sidePadding } from './lib/ui-measure'

journey.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', cadTools: true, pilot: { mode: 'on', provider: 'anthropic' } } })

/** The phone widths the spec checks, with the heights of the phones they stand for. */
const PHONES = [
  { width: 360, height: 780 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const
const WIDEST = PHONES[2]

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

/** A theme, once its color transitions have run, so a measured color is the theme's and not one on the way. */
async function scheme(page: Page, s: 'light' | 'dark'): Promise<void> {
  await setState(page, { scheme: s, themeFollowsSystem: false })
  await page.waitForFunction(() => document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'))
}

/** Nothing in the mimir tab runs past the window's edge and the page does not scroll sideways. */
async function inside(page: Page, at: string): Promise<void> {
  await noHorizontalScroll(page)
  expect(await pastTheEdge(page.locator('.studio[data-model-mode="mimir"]')), `past the edge ${at}`).toEqual([])
}

/** The waiting stand sheet's record, from the scripted conversation. */
async function standRecord(page: Page): Promise<Locator> {
  await askTab(page, 'Make me a stand for my phone')
  await page.getByTestId('mimir-choice').getByRole('button', { name: 'An iPhone 15' }).click()
  const rec = page.getByTestId('mimir-sheet-record').last()
  await expect(rec.getByTestId('mimir-sheet-confirm')).toBeVisible({ timeout: 30_000 })
  return rec
}

/** The stand built, and its sizes panel opened from Edit sizes. */
async function standPanel(page: Page): Promise<{ rec: Locator; panel: Locator; open: Locator }> {
  const rec = await standRecord(page)
  await rec.getByTestId('mimir-sheet-confirm').click()
  await expect(page.getByTestId('mimir-transcript')).toContainText('The stand is on the plate', { timeout: 60_000 })
  await expect(page.getByTestId('mimir-filament')).toBeVisible({ timeout: 30_000 })
  const panel = page.getByTestId('mimir-sheet-panel')
  const open = rec.getByTestId('mimir-sheet-open')
  await open.scrollIntoViewIfNeeded()
  await open.tap()
  await expect(panel).toHaveAttribute('data-mode', 'drive')
  return { rec, panel, open }
}

journey.describe('the mimir tab on a phone, against the UI spec', () => {
  journey.skip(({ isMobile }) => !isMobile, 'The phone project')

  journey('16 px gutters in the chat column and a header that fits at 360, 390 and 430 px', async ({ page }) => {
    journey.slow()
    await phoneMimir(page)
    const rec = await standRecord(page)
    const head = page.locator('.mimir-chat-head')
    const design = head.locator('.mimir-chat-design')
    const badge = head.locator('.mimir-chat-scripted')
    for (const phone of PHONES) {
      await page.setViewportSize(phone)
      const at = `at ${phone.width} px`
      // the conversation, the composer's foot and the header's start all keep the phone's 16 px gutter
      expect(await sidePadding(page.getByTestId('mimir-transcript')), `the conversation's gutters ${at}`).toEqual({ left: 16, right: 16 })
      expect(await sidePadding(page.locator('.mimir-chat-foot')), `the composer's gutters ${at}`).toEqual({ left: 16, right: 16 })
      expect((await sidePadding(head)).left, `the header's start ${at}`).toBe(16)
      const composer = (await page.getByTestId('mimir-composer').boundingBox())!
      expect(composer.x, `the composer's left ${at}`).toBeCloseTo(16, 0)
      expect(phone.width - composer.x - composer.width, `the composer's right ${at}`).toBeCloseTo(16, 0)
      const card = (await rec.boundingBox())!
      expect(card.x, `the record's left ${at}`).toBeCloseTo(16, 0)
      expect(phone.width - card.x - card.width, `the record's right ${at}`).toBeCloseTo(16, 0)
      await inside(page, at)
      // beside the badge the design's name is hidden (the top bar shows it), and the badge shows whole
      await expect(design).toBeHidden()
      await expect(badge).toBeVisible()
      expect(await badge.evaluate((el) => el.scrollWidth - el.clientWidth), `the badge cut off ${at}`).toBeLessThanOrEqual(0)
      // the header's buttons keep their 44 px
      for (const b of await head.locator('.sx-btn').all()) expect((await b.boundingBox())!.width).toBeGreaterThanOrEqual(44 - 0.5)
    }
  })

  journey('the sizes panel: fields on the 96 px column, labels wrap instead of being cut off, Escape returns to Edit sizes', async ({ page }) => {
    journey.slow()
    await phoneMimir(page)
    const { panel, open } = await standPanel(page)
    const rows = panel.getByTestId('mimir-sheet-row')
    for (const phone of PHONES) {
      await page.setViewportSize(phone)
      const at = `at ${phone.width} px`
      const fields = await panel.locator('.mimir-sheet-field').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width))
      expect(fields.length).toBeGreaterThan(0)
      for (const w of fields) expect(w, `a field ${at}`).toBeCloseTo(96, 0)
      // one right edge: every field ends at the same x
      const rights = await panel.locator('.mimir-sheet-field').evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().right)))])
      expect(rights, `the fields' right edge ${at}`).toHaveLength(1)
      expect(await sidePadding(rows.first()), `the rows' gutters ${at}`).toEqual({ left: 16, right: 16 })
      // a long label wraps to two lines at most, never cut off
      expect(await clippedText(panel.locator('.mimir-sheet-label')), `cut-off labels ${at}`).toEqual([])
      for (const h of await rows.evaluateAll((els) => els.map((e) => e.querySelector('.mimir-sheet-label')!.getBoundingClientRect().height))) expect(h, `a label's height ${at}`).toBeLessThanOrEqual(2 * 18 + 0.5)
      // the unit follows the label's last word, on the same line
      for (const [unit, text] of await rows.evaluateAll((els) => els.map((e) => [e.querySelector('.mimir-sheet-unit')!.getBoundingClientRect(), e.querySelector('.mimir-sheet-label > span')!.getClientRects()] as const).map(([u, t]) => [u.toJSON() as DOMRect, t[t.length - 1]!.toJSON() as DOMRect] as const))) {
        expect(Math.abs(unit.bottom - text.bottom), `a unit on its label's last line ${at}`).toBeLessThanOrEqual(3)
        expect(unit.left - text.right).toBeLessThanOrEqual(8)
      }
      for (const h of await rows.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(48 - 0.5)
      await inside(page, at)
    }
    // Escape from a field drops what was typed, puts the panel away and hands focus back to Edit sizes, the chat where
    // it was
    const log = page.getByTestId('mimir-transcript')
    const field = panel.locator('[data-testid="mimir-sheet-row"] input:enabled').first()
    const before = await field.inputValue()
    await field.focus()
    await field.fill('99')
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(open).toBeFocused()
    await expect(open).toBeInViewport()
    await expect(log).toBeVisible()
    // opened again, the size is what it was, and Escape from a button inside closes it the same way
    const at = await log.evaluate((el) => el.scrollTop)
    await open.tap()
    await expect(panel).toHaveAttribute('data-mode', 'drive')
    await expect(field).toHaveValue(before)
    await page.getByTestId('mimir-sheet-close').focus()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(open).toBeFocused()
    expect(await log.evaluate((el) => el.scrollTop)).toBe(at)
    // Done hands focus back too
    await open.tap()
    await expect(panel).toHaveAttribute('data-mode', 'drive')
    await page.getByTestId('mimir-sheet-close').tap()
    await expect(panel).toHaveCount(0)
    await expect(open).toBeFocused()
  })

  journey('the folded drawing header and the panel hint pass contrast at 1x in light and dark', async ({ page }) => {
    journey.slow()
    await phoneMimir(page)
    await askTab(page, 'Make a backplate for my thermostat')
    const yes = page.getByRole('button', { name: 'Yes, that one' })
    await expect(yes).toBeVisible({ timeout: 30_000 })
    await yes.click()
    await expect(page.getByTestId('mimir-sheet-record').last()).toBeVisible({ timeout: 30_000 })
    const fold = page.getByTestId('mimir-drawing-fold')
    await fold.tap()
    await expect(page.getByTestId('mimir-sheet-drawing')).toHaveAttribute('data-folded', 'true')
    for (const s of ['light', 'dark'] as const) {
      await scheme(page, s)
      // text 4.5:1 against its surface, an icon that carries meaning 3:1 (spec 5)
      // at rest, with no pointer over the fold
      await page.mouse.move(0, 0)
      await page.waitForFunction(() => document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'))
      const name = await contrastOf(page.getByTestId('mimir-drawing-name'))
      expect(name.ratio, `"Drawing" in ${s}: ${name.fg} on ${name.bg}`).toBeGreaterThanOrEqual(4.5)
      const icon = await contrastOf(fold.locator('svg').first())
      expect(icon.ratio, `the fold's chevron in ${s}: ${icon.fg} on ${icon.bg}`).toBeGreaterThanOrEqual(3)
    }
    await scheme(page, 'dark')
    // the sizes panel's one-line hint, on a built stand
    await page.getByTestId('mimir-chat').getByRole('button', { name: 'New conversation' }).click()
    await standPanel(page)
    for (const s of ['light', 'dark'] as const) {
      await scheme(page, s)
      const hint = await contrastOf(page.getByTestId('mimir-sheet-hint'))
      expect(hint.ratio, `the hint in ${s}: ${hint.fg} on ${hint.bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  journey('at 430 px the whole tab fits: nothing cut off or past the edge, in the chat, the drawing, folded, and the panel', async ({ page }) => {
    journey.slow()
    await page.setViewportSize(WIDEST)
    await phoneMimir(page)
    const studio = page.locator('.studio[data-model-mode="mimir"]')
    const whole = async (where: string) => {
      await inside(page, where)
      expect(await clippedText(studio), `cut-off text, ${where}`).toEqual([])
    }
    await whole('the empty chat')
    await askTab(page, 'Make a backplate for my thermostat')
    const yes = page.getByRole('button', { name: 'Yes, that one' })
    await expect(yes).toBeVisible({ timeout: 30_000 })
    await whole('a choice card')
    await yes.click()
    const rec = page.getByTestId('mimir-sheet-record').last()
    await expect(rec.getByTestId('mimir-sheet-confirm')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('mimir-sheet-drawing')).toBeVisible()
    await whole('the waiting sheet and its drawing')
    await page.getByTestId('mimir-drawing-fold').tap()
    await expect(page.getByTestId('mimir-sheet-drawing')).toHaveAttribute('data-folded', 'true')
    await whole('the drawing folded')
    await page.getByTestId('mimir-drawing-fold').tap()
    await rec.getByTestId('mimir-sheet-confirm').click()
    await expect(page.getByTestId('mimir-transcript')).toContainText('The backplate is on the plate', { timeout: 60_000 })
    await whole('the built part')
    // a built stand's sizes panel
    await page.getByTestId('mimir-chat').getByRole('button', { name: 'New conversation' }).click()
    await standPanel(page)
    await whole('the sizes panel')
  })
})

journey.describe('the mimir composer on the desktop', () => {
  journey.skip(({ isMobile }) => isMobile, 'Desktop')

  journey('one line is 44 px inside the border, with 4 px around the row and 8 px above and below the line', async ({ page }) => {
    await debugOn(page)
    await setPilot(page, 'scripted')
    await emptyMimirTab(page)
    const composer = page.getByTestId('mimir-composer')
    const m = await composer.evaluate((n) => {
      const cs = getComputedStyle(n)
      const t = n.querySelector('textarea')!
      const ts = getComputedStyle(t)
      return { h: n.getBoundingClientRect().height, border: parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth), pad: cs.padding, gap: cs.rowGap, text: t.getBoundingClientRect().height, textPad: [ts.paddingTop, ts.paddingBottom], lh: ts.lineHeight }
    })
    expect(m.h - m.border, 'one line inside the border').toBeCloseTo(44, 0)
    expect(m.pad).toBe('4px')
    expect(m.gap).toBe('4px')
    expect(m.textPad).toEqual(['8px', '8px'])
    expect(m.lh).toBe('20px')
    expect(m.text).toBeCloseTo(36, 0)
  })
})
