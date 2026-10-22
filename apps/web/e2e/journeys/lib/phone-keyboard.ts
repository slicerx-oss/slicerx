// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A stand-in for a phone's on-screen keyboard. Playwright cannot open a real one, so this does what the keyboard does
// to the page as the app reads it: the visual viewport loses the keys' height at the bottom (Safari, and Chrome on
// Android, leave the page its full height and shrink the visual viewport), optionally panned down as Safari pans it to
// a field, and a gray block is drawn where the keys would be so screenshots show it. Nothing app-side is told.
import type { Locator, Page } from '@playwright/test'
import { expect } from '../../journey'

/** The two phone widths, the heights of the phones they stand for, and a keyboard about 40% of each screen. */
export const KEYBOARD_PHONES = [
  { width: 390, height: 844, keys: 336 },
  { width: 360, height: 780, keys: 312 },
] as const
export type KeyboardPhone = (typeof KEYBOARD_PHONES)[number]

/** Opens the stand-in keyboard `keys` px tall (0 shuts it), with the visible part panned down by `panned` px. */
export async function keyboard(page: Page, keys: number, panned = 0): Promise<void> {
  await page.evaluate(
    ([keys, panned]) => {
      const vv = window.visualViewport!
      const own = vv as unknown as Record<string, unknown>
      document.getElementById('test-keys')?.remove()
      if (keys <= 0) {
        delete own['height']
        delete own['offsetTop']
      } else {
        Object.defineProperty(vv, 'height', { configurable: true, get: () => window.innerHeight - keys })
        Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => panned })
        const el = document.createElement('div')
        el.id = 'test-keys'
        el.style.cssText = `position:fixed;left:0;right:0;top:${window.innerHeight - keys}px;height:${keys}px;background:#8e939a;z-index:2147483647;pointer-events:none`
        document.body.appendChild(el)
      }
      vv.dispatchEvent(new Event('resize'))
    },
    [keys, panned] as const,
  )
  // the app answers on the next frames: its layout, then the focused field scrolled into view
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r())))))
}

/** Where `el` is against the part of the screen the keyboard leaves, and whether a tap at its middle lands on it. */
export async function placeOf(el: Locator) {
  return el.evaluate((node) => {
    const b = node.getBoundingClientRect()
    const vv = window.visualViewport!
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
    return {
      top: b.top,
      bottom: b.bottom,
      left: b.left,
      right: b.right,
      height: b.height,
      shownTop: vv.offsetTop,
      shownBottom: vv.offsetTop + vv.height,
      width: window.innerWidth,
      onTop: !!hit && (hit === node || node.contains(hit)),
    }
  })
}

/** Fails unless `el` is whole inside the part of the screen above the keys, inside the width, and nothing lies over it. */
export async function clearOfKeys(el: Locator, what: string): Promise<void> {
  const p = await placeOf(el)
  expect(p.height, `${what} has a size`).toBeGreaterThan(1)
  expect(p.top, `${what} below the top of what shows`).toBeGreaterThanOrEqual(p.shownTop - 0.5)
  expect(p.bottom, `${what} above the keys`).toBeLessThanOrEqual(p.shownBottom + 0.5)
  expect(p.left, `${what} inside the width`).toBeGreaterThanOrEqual(-0.5)
  expect(p.right, `${what} inside the width`).toBeLessThanOrEqual(p.width + 0.5)
  expect(p.onTop, `${what} is what a tap at its middle lands on`).toBe(true)
}

/** The sizes panel's rows against what shows: how many are whole in view, and the rows' part of the screen, px. */
export async function rowsInView(panel: Locator): Promise<{ whole: number; seen: number; room: number; rowH: number }> {
  return panel.evaluate((p) => {
    const vv = window.visualViewport!
    const list = p.querySelector('.mimir-sheet-rows')!.getBoundingClientRect()
    const top = Math.max(list.top, vv.offsetTop)
    const bottom = Math.min(list.bottom, vv.offsetTop + vv.height)
    let whole = 0
    let seen = 0
    let rowH = 0
    for (const row of p.querySelectorAll('[data-testid="mimir-sheet-row"]')) {
      const r = row.getBoundingClientRect()
      rowH = Math.max(rowH, r.height)
      const shown = Math.max(0, Math.min(r.bottom, bottom) - Math.max(r.top, top))
      seen += shown / r.height
      if (shown >= r.height - 0.5) whole++
    }
    return { whole, seen: Math.round(seen * 10) / 10, room: Math.max(0, Math.round(bottom - top)), rowH: Math.round(rowH) }
  })
}
