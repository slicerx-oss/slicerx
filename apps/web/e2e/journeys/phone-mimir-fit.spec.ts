// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab on a phone, at 390 and 360 px wide: the send card's bed check and Print stay above the composer, a long
// message wraps in the composer with its start in view, the empty chat's hint stays whole above a composer grown to six
// lines, and everything a finger presses in the tab takes a 44 x 44 px
// touch. A touch box counts the control itself, an invisible box drawn around it (an absolutely placed ::before or
// ::after), and for a checkbox the label it sits in, since a tap on any of those lands on the control.
import type { Locator, Page, TestInfo } from '@playwright/test'
import { journey, expect } from '../journey'
import { goTab } from '../fixtures'
import { askTab, debugOn, noHorizontalScroll, setPilot, setState, shotsDir, shotsOn } from './lib/session'

journey.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', cadTools: true } })

/** The two phone widths, with the heights of the phones they stand for. */
const PHONES = [
  { width: 390, height: 844 },
  { width: 360, height: 780 },
] as const

/** Every control in the mimir tab whose touch box is under 44 px either way, named so a failure says which. */
async function smallTargets(page: Page): Promise<string[]> {
  return page.locator('.studio[data-model-mode="mimir"]').evaluate((root) => {
    const MIN = 44
    const touchBox = (el: Element) => {
      const r = el.getBoundingClientRect()
      let [l, t, rr, b] = [r.left, r.top, r.right, r.bottom]
      const es = getComputedStyle(el)
      for (const pseudo of ['::before', '::after']) {
        const cs = getComputedStyle(el, pseudo)
        if (cs.content === 'none' || cs.position !== 'absolute' || cs.pointerEvents === 'none' || es.position === 'static') continue
        const inset = [cs.left, cs.top, cs.right, cs.bottom].map((v) => parseFloat(v))
        if (inset.some((v) => Number.isNaN(v))) continue
        const [il, it, ir, ib] = inset as [number, number, number, number]
        l = Math.min(l, r.left + parseFloat(es.borderLeftWidth) + il)
        t = Math.min(t, r.top + parseFloat(es.borderTopWidth) + it)
        rr = Math.max(rr, r.right - parseFloat(es.borderRightWidth) - ir)
        b = Math.max(b, r.bottom - parseFloat(es.borderBottomWidth) - ib)
      }
      const label = el.matches('input[type="checkbox"], input[type="radio"]') ? el.closest('label') : null
      if (label) {
        const q = label.getBoundingClientRect()
        ;[l, t, rr, b] = [Math.min(l, q.left), Math.min(t, q.top), Math.max(rr, q.right), Math.max(b, q.bottom)]
      }
      return { w: rr - l, h: b - t, shown: r.width > 1 && r.height > 1 && es.visibility !== 'hidden' }
    }
    const out: string[] = []
    for (const el of root.querySelectorAll('button, input, select, textarea, [role="button"], a[href]')) {
      if (el.matches('input[type="file"], input[type="hidden"]')) continue
      const { w, h, shown } = touchBox(el)
      if (!shown || (w >= MIN - 0.5 && h >= MIN - 0.5)) continue
      const name = el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 40)
      out.push(`${el.tagName.toLowerCase()} "${name}" ${Math.round(w)} x ${Math.round(h)}`)
    }
    return out
  })
}

/** The mimir tab from the tab bar, on the scripted replies, with a new conversation and nothing on the plate. */
async function phoneMimir(page: Page): Promise<Locator> {
  await debugOn(page)
  await goTab(page, 'prepare')
  await setPilot(page, 'scripted')
  await setState(page, { plate: [], selection: null, selectedIds: [], toast: null })
  await page.locator('[data-testid="phone-tabs"] [data-tab="mimir"]').click()
  const chat = page.getByTestId('mimir-chat')
  await expect(chat).toBeVisible()
  await chat.getByRole('button', { name: 'New conversation' }).click()
  return chat
}

/** Whether a control is on screen inside the chat's transcript, above the composer, and the topmost thing at its middle. */
async function reachable(page: Page, control: Locator): Promise<void> {
  const box = (await control.boundingBox())!
  const log = (await page.getByTestId('mimir-transcript').boundingBox())!
  const composer = (await page.getByTestId('mimir-composer').boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(log.y - 0.5)
  expect(box.y + box.height).toBeLessThanOrEqual(composer.y + 0.5)
  expect(box.y + box.height).toBeLessThanOrEqual(log.y + log.height + 0.5)
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('[data-testid]')?.getAttribute('data-testid') ?? null, [box.x + box.width / 2, box.y + box.height / 2])
  expect(hit).toBe(await control.getAttribute('data-testid'))
}

/** Review shots at both widths in light and dark, when shots are on. */
async function shots(page: Page, info: TestInfo, name: string, before?: (phone: (typeof PHONES)[number]) => Promise<void>): Promise<void> {
  if (!shotsOn()) return
  const size = page.viewportSize()!
  for (const phone of PHONES) {
    await page.setViewportSize(phone)
    for (const scheme of ['light', 'dark'] as const) {
      await setState(page, { scheme, themeFollowsSystem: false })
      await before?.(phone)
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${shotsDir(info)}/${name}-phone-${phone.width}-${scheme}.png` })
    }
  }
  await setState(page, { scheme: 'dark', themeFollowsSystem: false })
  await page.setViewportSize(size)
}

journey.describe('the mimir tab fits a phone', () => {
  journey.skip(({ isMobile }) => !isMobile, 'The phone project')

  journey('a long message wraps to more lines in the composer, with its start in view', async ({ page }, info) => {
    await phoneMimir(page)
    const composer = page.getByTestId('mimir-composer')
    const box = composer.getByRole('textbox')
    const empty = (await box.boundingBox())!
    expect(empty.height).toBeGreaterThanOrEqual(44)
    const long = 'A wall plate 120 by 80 mm and 3 mm thick, with two screw holes 60 mm apart and a slot for the cable along the bottom edge'
    for (const phone of PHONES) {
      await page.setViewportSize(phone)
      await box.fill('')
      await box.pressSequentially(long)
      const grown = (await box.boundingBox())!
      // more lines, not a sideways scroll: the first words stay where they were typed
      expect(grown.height).toBeGreaterThan(empty.height + 20)
      expect(await box.evaluate((el) => [el.scrollLeft, el.scrollWidth - el.clientWidth])).toEqual([0, 0])
      // three lines fit without scrolling inside, so the start is in view
      expect(await box.evaluate((el) => el.scrollTop)).toBe(0)
      // the box grows upward from the tab bar, and attach and send stay level with its last line
      const tabs = (await page.getByTestId('phone-tabs').boundingBox())!
      expect((await composer.boundingBox())!.y + (await composer.boundingBox())!.height).toBeLessThanOrEqual(tabs.y + 0.5)
      const send = (await composer.getByRole('button', { name: 'Send' }).boundingBox())!
      expect(Math.abs(send.y + send.height - (grown.y + grown.height))).toBeLessThanOrEqual(1)
      await noHorizontalScroll(page)
    }
    // Shift+Enter adds a line; past six lines the box stops growing and scrolls inside
    await box.press('Shift+Enter')
    await box.pressSequentially('and a second line')
    expect(await box.inputValue()).toContain('\nand a second line')
    await box.fill(Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join('\n'))
    const capped = (await box.boundingBox())!
    expect(capped.height).toBeLessThanOrEqual(6 * 24 + 20 + 1)
    expect(await box.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    await box.fill('')
    await page.setViewportSize(PHONES[0])
    await shots(page, info, 'composer-typed', async () => {
      await box.fill('')
      await box.pressSequentially(long)
    })
    await box.fill('')
  })

  journey('the empty chat keeps its hint whole above a six-line composer at 390 and 360 px', async ({ page }, info) => {
    const chat = await phoneMimir(page)
    const hint = chat.locator('.mimir-empty p')
    const box = page.getByTestId('mimir-composer').getByRole('textbox')
    const six = Array.from({ length: 6 }, (_, i) => `Line ${i + 1}`).join('\n')
    for (const phone of PHONES) {
      await page.setViewportSize(phone)
      await box.fill('')
      // with one line the hint sits in the ring's lower half, whole, inside the chat
      const ravens = (await chat.locator('.mimir-ravens').boundingBox())!
      const one = (await hint.boundingBox())!
      const room = (await page.getByTestId('mimir-transcript').boundingBox())!
      expect(one.y, `the hint at ${phone.width} px`).toBeGreaterThanOrEqual(ravens.y + ravens.height / 2)
      expect(one.y + one.height).toBeLessThanOrEqual(room.y + room.height + 0.5)
      await box.fill(six)
      expect((await box.boundingBox())!.height).toBeGreaterThanOrEqual(6 * 24 + 20 - 1)
      // the composer at six lines: the hint moves up, whole, and ends above it
      const h = (await hint.boundingBox())!
      const log = (await page.getByTestId('mimir-transcript').boundingBox())!
      const composer = (await page.getByTestId('mimir-composer').boundingBox())!
      expect(h.y + h.height, `the hint over the composer at ${phone.width} px`).toBeLessThanOrEqual(composer.y + 0.5)
      expect(h.y).toBeGreaterThanOrEqual(log.y - 0.5)
      expect(h.y + h.height).toBeLessThanOrEqual(log.y + log.height + 0.5)
      await noHorizontalScroll(page)
    }
    await page.setViewportSize(PHONES[0])
    await shots(page, info, 'composer-six-lines', async () => {
      await box.fill(six)
      // off the header's buttons, so no tooltip lies over the shot
      await page.getByTestId('mimir-transcript').hover()
    })
    await box.fill('')
  })

  journey('every control in the tab takes a 44 px touch, from the first message to the built part', async ({ page }, info) => {
    journey.slow()
    await phoneMimir(page)
    expect(await smallTargets(page), 'the empty chat').toEqual([])
    await page.getByTestId('mimir-attach-input').setInputFiles({ name: 'thermostat.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') })
    await expect(page.getByTestId('mimir-attachment')).toHaveCount(1)
    expect(await smallTargets(page), 'a file on the message').toEqual([])
    await page.getByRole('button', { name: 'Remove thermostat.png' }).click()
    // the question, the lookup, the sheet with its drawing, the part and its lookups over the view
    await askTab(page, 'Make a backplate for my thermostat')
    const yes = page.getByRole('button', { name: 'Yes, that one' })
    await expect(yes).toBeVisible({ timeout: 30_000 })
    expect(await smallTargets(page), 'the question').toEqual([])
    await yes.click()
    const sheet = page.getByTestId('mimir-sheet-record').last()
    await expect(sheet).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('mimir-sheet-callout').first()).toBeVisible()
    expect(await smallTargets(page), 'the waiting sheet').toEqual([])
    // each callout's touch circle is centered on its badge, 44 px across, and a tap on the badge lands on that callout,
    // in Top and iso and in Front or Right alone
    const drawing = page.getByTestId('mimir-sheet-drawing')
    for (const pane of ['main', 'front', 'side', 'main'] as const) {
      await page.getByTestId(`mimir-drawing-view-${pane}`).tap()
      await expect(page.getByTestId(`mimir-drawing-view-${pane}`)).toHaveAttribute('aria-checked', 'true')
      const missed = await drawing.locator('[data-testid="mimir-sheet-callout"]').evaluateAll((els) =>
        els.flatMap((el) => {
          const hit = el.querySelector('circle.mimir-callout-hit')?.getBoundingClientRect()
          const dot = el.querySelector('circle:not(.mimir-callout-hit)')!.getBoundingClientRect()
          const [x, y] = [dot.x + dot.width / 2, dot.y + dot.height / 2]
          const view = el.closest('.mimir-drawing-cell')?.getAttribute('data-view')
          const name = `${view} ${el.getAttribute('data-key')}`
          if (!hit) return [`${name}: no touch circle`]
          const out: string[] = []
          if (hit.width < 44 - 0.5 || hit.height < 44 - 0.5) out.push(`${name}: touch ${Math.round(hit.width)} x ${Math.round(hit.height)}`)
          if (Math.abs(hit.x + hit.width / 2 - x) > 0.5 || Math.abs(hit.y + hit.height / 2 - y) > 0.5) out.push(`${name}: touch off its badge`)
          if (document.elementFromPoint(x, y)?.closest('[data-testid="mimir-sheet-callout"]') !== el) out.push(`${name}: a tap on the badge lands elsewhere`)
          return out
        }),
      )
      expect(missed, `the callouts in ${pane}`).toEqual([])
    }
    // the assumed values are why the person is asked to confirm, so their line wraps instead of being cut off
    await page.setViewportSize(PHONES[1])
    const status = sheet.getByTestId('mimir-sheet-status')
    await status.scrollIntoViewIfNeeded()
    await expect(status).toContainText('1 assumed value: thickness 3 mm')
    expect(await status.evaluate((el) => [el.scrollHeight <= el.clientHeight + 0.5, el.scrollWidth <= el.clientWidth + 0.5])).toEqual([true, true])
    const said = (await status.boundingBox())!
    expect(said.y + said.height).toBeLessThanOrEqual((await page.getByTestId('mimir-composer').boundingBox())!.y + 0.5)
    await page.setViewportSize(PHONES[0])
    await shots(page, info, 'sheet-waiting', async () => {
      await sheet.getByTestId('mimir-sheet-status').scrollIntoViewIfNeeded()
    })
    await sheet.getByTestId('mimir-sheet-confirm').click()
    await expect(page.getByTestId('mimir-transcript')).toContainText('The backplate is on the plate', { timeout: 60_000 })
    await expect(page.getByTestId('mimir-part').last()).toBeVisible()
    expect(await smallTargets(page), 'the built part').toEqual([])
    await noHorizontalScroll(page)
  })

  journey('the send card fits above the composer at 390 and 360 px, with the bed check and Print in reach', async ({ page }, info) => {
    journey.slow()
    await phoneMimir(page)
    await askTab(page, 'Print this on my Bay 6 in green PLA')
    const sheet = page.getByTestId('mimir-sheet-record').last()
    await expect(sheet).toBeVisible({ timeout: 30_000 })
    await sheet.getByTestId('mimir-sheet-confirm').click()
    const card = page.getByTestId('mimir-send').last()
    await expect(card).toBeVisible({ timeout: 120_000 })
    await expect(card.getByTestId('mimir-send-status')).not.toHaveText(/^Checking /, { timeout: 30_000 })
    // the view folds to a strip while the card waits
    await expect(page.getByTestId('mimir-chat')).toHaveAttribute('data-card-waits', 'true')
    const bed = card.getByTestId('mimir-send-bed')
    const print = card.getByTestId('danger-mimir-send-print')
    for (const phone of PHONES) {
      await page.setViewportSize(phone)
      // the whole card fits in the chat
      await card.evaluate((el) => el.scrollIntoView({ block: 'end' }))
      const log = (await page.getByTestId('mimir-transcript').boundingBox())!
      const c = (await card.boundingBox())!
      expect(c.height, `the card at ${phone.width} px`).toBeLessThanOrEqual(log.height)
      expect(c.y).toBeGreaterThanOrEqual(log.y - 0.5)
      await reachable(page, print)
      await reachable(page, bed)
      expect(await smallTargets(page), `the send card at ${phone.width} px`).toEqual([])
      await noHorizontalScroll(page)
    }
    await shots(page, info, 'print-run-send', async () => {
      await card.evaluate((el) => el.scrollIntoView({ block: 'end' }))
    })
    // ticking the bed check moves nothing; Print turns on in place and starts the print
    await page.setViewportSize(PHONES[1])
    await card.evaluate((el) => el.scrollIntoView({ block: 'end' }))
    const at = (await print.boundingBox())!
    await bed.tap()
    await expect(bed).toBeChecked()
    await expect(print).toBeEnabled()
    expect(await print.boundingBox()).toEqual(at)
    await print.tap()
    await expect(page.getByTestId('mimir-progress').last()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('mimir-chat')).not.toHaveAttribute('data-card-waits')
    await page.setViewportSize(PHONES[0])
  })
})
