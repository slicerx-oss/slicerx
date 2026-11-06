// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey: the approval dialog. A card can pop up while someone is typing, so one Enter or Space must never approve:
// the dialog opens with focus on its title, on neither button and with no focus ring. Enter and Space then do
// nothing, Tab goes to Deny and then Approve, and Approve and Deny give a finger 44 px on a phone and a pointer 28 px
// on desktop (UI spec 2, 2c and 9). The hit area counts what a press reaches: the button's own box and any invisible
// padding around it, found by hit-testing the points just inside the needed reach above and below.
import type { Page } from '@playwright/test'
import { expect, setState, test } from './lib/shell'

/** Opens the approval dialog with a plain request, the way the store holds one. Its buttons only count presses. */
async function openApproval(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __sx: { setState(p: unknown): void }; __taps: { approve: number; deny: number } }
    w.__taps = { approve: 0, deny: 0 }
    w.__sx.setState({
      approval: {
        requests: [{ id: 'tap-1', sessionId: 's', tool: 'printer_start', permission: 'start', title: 'Start the print on Voron?', lines: ['Heats the bed to 60 C', 'Moves the toolhead'], paramsHash: 'x', actions: [] }],
        approve: async () => void w.__taps.approve++,
        deny: async () => void w.__taps.deny++,
      },
    })
  })
  await expect(page.locator('dialog.approve-dialog[open]')).toBeVisible()
}

/** Focus right after open, and each button's reach. */
async function scan(page: Page) {
  return page.locator('dialog.approve-dialog[open]').evaluate((dialog) => {
    const need = matchMedia('(pointer: coarse), (max-width: 700px)').matches ? 44 : 28
    const ringOn = (el: Element) => {
      const s = getComputedStyle(el)
      const clear = /rgba\(\d+, \d+, \d+, 0\)|transparent/.test(s.outlineColor)
      return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 && !clear) || s.boxShadow.replace(/rgba?\(0, 0, 0, 0\)/g, '').trim().length > 4
    }
    const reach = (el: HTMLElement) => {
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const half = need / 2 - 1
      const at = (y: number) => el.contains(document.elementFromPoint(x, y))
      return { height: Math.round(r.height), top: at(cy - half), bottom: at(cy + half) }
    }
    const buttons = Object.fromEntries(['Deny', 'Approve'].map((n) => [n, [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === n)!]))
    const active = document.activeElement
    return {
      need,
      onButton: Boolean(active?.closest('button')),
      onTitle: active === dialog.querySelector('h2'),
      ring: active ? ringOn(active) : false,
      reach: Object.fromEntries(Object.entries(buttons).map(([n, b]) => [n, reach(b)])),
    }
  })
}

const focusedButton = (page: Page) => page.evaluate(() => (document.activeElement?.closest('button')?.textContent ?? '').trim())

test.describe('the approval dialog', () => {
  test('opens with focus on its title, Enter and Space approve nothing, Tab reaches Deny then Approve, and both buttons reach 28 px on desktop and 44 px on a phone', async ({ page, isMobile }, info) => {
    const home = page.viewportSize() ?? { width: 1440, height: 900 }
    const widths = isMobile ? [390] : [1440, 390]
    const scheme0 = (await page.locator('html').getAttribute('data-scheme')) ?? 'dark'
    try {
      for (const width of widths) {
        await page.setViewportSize({ width, height: 844 })
        for (const scheme of ['dark', 'light']) {
          await setState(page, { scheme })
          await expect(page.locator('html')).toHaveAttribute('data-scheme', scheme)
          await openApproval(page)
          const where = `${width} px, ${scheme}`
          const got = await scan(page)
          expect.soft(got.onButton, `a button is focused on open at ${where}`).toBe(false)
          expect.soft(got.onTitle, `focus is on the dialog's title on open at ${where}`).toBe(true)
          expect.soft(got.ring, `a focus ring shows on open at ${where}`).toBe(false)
          for (const n of ['Deny', 'Approve'] as const) {
            expect.soft(got.reach[n], `${n} hit area at ${where}, needs ${got.need}`).toMatchObject({ top: true, bottom: true })
          }
          await page.screenshot({ path: `${process.env['SX_SHOTS_DIR'] ?? info.outputDir}/approval-${width}-${scheme}.png` })
          // Enter and Space on the panel press nothing: the card stays and nothing was sent.
          await page.keyboard.press('Enter')
          await page.keyboard.press('Space')
          const sent = await page.evaluate(() => (window as unknown as { __taps: { approve: number; deny: number } }).__taps)
          expect.soft(sent, `presses sent by Enter and Space at ${where}`).toEqual({ approve: 0, deny: 0 })
          await expect(page.locator('dialog.approve-dialog[open]')).toBeVisible()
          // Tab goes to Deny, then Approve.
          await page.keyboard.press('Tab')
          expect.soft(await focusedButton(page), `first Tab at ${where}`).toBe('Deny')
          await page.keyboard.press('Tab')
          expect.soft(await focusedButton(page), `second Tab at ${where}`).toBe('Approve')
          await setState(page, { approval: null })
          await expect(page.locator('dialog.approve-dialog[open]')).toHaveCount(0)
        }
      }
    } finally {
      await setState(page, { approval: null, scheme: scheme0 })
      await page.setViewportSize(home)
    }
  })
})
