// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Measurements for the UI spec's checks, taken from the page as it is drawn: contrast from computed colors, text that
// is cut off, and anything that runs past the window's right edge.
import type { Locator, Page } from '@playwright/test'

/**
 * The contrast ratio of an element's text (or, with `prop`, another color of it, such as an icon's `color`) against what
 * it sits on, at 1x. Both colors come from the computed style; the backgrounds under it are painted in order from the
 * root onto a canvas, so a translucent color counts the way it shows.
 */
export async function contrastOf(el: Locator, prop: 'color' | 'fill' | 'stroke' = 'color'): Promise<{ ratio: number; fg: string; bg: string }> {
  return el.evaluate((node, prop) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    const paint = (color: string): [number, number, number] => {
      ctx.fillStyle = color
      ctx.fillRect(0, 0, 1, 1)
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
      return [r!, g!, b!]
    }
    const chain: string[] = []
    for (let n: Element | null = node; n; n = n.parentElement) chain.unshift(getComputedStyle(n).backgroundColor)
    paint('#ffffff')
    let bg: [number, number, number] = [255, 255, 255]
    for (const c of chain) bg = paint(c)
    const fg = paint(getComputedStyle(node)[prop as 'color'])
    const lum = ([r, g, b]: [number, number, number]) => {
      const ch = (v: number) => {
        const s = v / 255
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
    }
    const [a, b] = [lum(fg), lum(bg)]
    const hex = (c: [number, number, number]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')
    return { ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), fg: hex(fg), bg: hex(bg) }
  }, prop)
}

/** Shown text in or inside `root` (every element it matches) that is cut off: wider than its box with its overflow
 * hidden, or more lines than a clamp shows. Named by its text. */
export async function clippedText(root: Locator): Promise<string[]> {
  return root.evaluateAll((roots) => {
    const out: string[] = []
    for (const n of roots.flatMap((el) => [el as HTMLElement, ...el.querySelectorAll<HTMLElement>('*')])) {
      const own = Array.from(n.childNodes).some((c) => c.nodeType === Node.TEXT_NODE && (c.textContent ?? '').trim() !== '')
      if (!own) continue
      const cs = getComputedStyle(n)
      const r = n.getBoundingClientRect()
      // a 1 px box is a visually hidden label, there for a screen reader
      if (r.width <= 1 || r.height <= 1 || cs.visibility === 'hidden' || n.closest('[aria-hidden="true"], .sr-only')) continue
      const name = `"${(n.textContent ?? '').trim().slice(0, 40)}"`
      if (cs.overflowX !== 'visible' || cs.textOverflow === 'ellipsis') {
        if (n.scrollWidth > n.clientWidth + 1) out.push(`${name} ${n.clientWidth} of ${n.scrollWidth} px wide`)
      }
      // text clamped to a number of lines, with more lines than that
      if (cs.overflowY !== 'visible' && n.scrollHeight > n.clientHeight + 1) out.push(`${name} ${n.clientHeight} of ${n.scrollHeight} px tall`)
    }
    return out
  })
}

/** Shown elements inside `root` whose box runs past the window's left or right edge. */
export async function pastTheEdge(root: Locator): Promise<string[]> {
  return root.evaluate((el) => {
    const w = window.innerWidth
    const out: string[] = []
    for (const n of el.querySelectorAll<HTMLElement>('*')) {
      const r = n.getBoundingClientRect()
      if (r.width < 1 || r.height < 1 || getComputedStyle(n).visibility === 'hidden') continue
      // a box inside a scroller that clips it (a row of cards along the view) is the scroller's to show
      let clipped = false
      for (let p = n.parentElement; p && p !== el; p = p.parentElement) {
        const s = getComputedStyle(p)
        if (s.overflowX !== 'visible') {
          const q = p.getBoundingClientRect()
          if (q.left >= -0.5 && q.right <= w + 0.5) clipped = true
          break
        }
      }
      if (clipped) continue
      if (r.left < -0.5 || r.right > w + 0.5) out.push(`${n.tagName.toLowerCase()}.${n.className.toString().split(' ')[0]} ${Math.round(r.left)} to ${Math.round(r.right)}`)
    }
    return out
  })
}

/** The left and right padding of an element, in px. */
export async function sidePadding(el: Locator): Promise<{ left: number; right: number }> {
  return el.evaluate((n) => {
    const cs = getComputedStyle(n)
    return { left: parseFloat(cs.paddingLeft), right: parseFloat(cs.paddingRight) }
  })
}

/** Removes any toast, so a review shot shows only the surface. */
export async function noToasts(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ toast: null }))
}
