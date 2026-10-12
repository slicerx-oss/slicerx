// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// When a filament color is close to the panel behind it (dark gray on a dark panel, white on a light one), its swatch
// reads as an empty ring. The distance is measured in OKLab, where equal steps look about equal, against the panel's
// real background as the browser resolves it, so it holds for every theme without a list of colors.

/** OKLab distance under which a swatch gets its contrast edge. Dark grays on Subban dark and whites on Subban light
 * fall under it; a mid gray on dark or any saturated color stays over it. */
export const NEAR_PANEL = 0.12

type Lab = [number, number, number]

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** sRGB, 0 to 1 per channel, as OKLab. */
export function oklab([r, g, b]: [number, number, number]): Lab {
  const [R, G, B] = [lin(r), lin(g), lin(b)]
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

const num = (v: string, scale: number) => (v.endsWith('%') ? (parseFloat(v) / 100) * scale : parseFloat(v))

/**
 * A CSS color as OKLab, with its alpha: hex, the rgb and rgba functions, srgb color(), oklab and oklch, the
 * forms a browser hands back from getComputedStyle. Anything else gives null.
 */
export function parseColor(css: string): { lab: Lab; alpha: number } | null {
  const c = css.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(c)
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((x) => x + x).join('') : hex[1]!
    const ch = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255
    return { lab: oklab([ch(0), ch(2), ch(4)]), alpha: h.length === 8 ? ch(6) : 1 }
  }
  const fn = /^([a-z]+)\((.*)\)$/.exec(c)
  if (!fn) return null
  const [name, body] = [fn[1]!, fn[2]!]
  const [main, a] = body.includes('/') ? body.split('/') : [body, undefined]
  const parts = main!.replace(/,/g, ' ').trim().split(/\s+/)
  const commaAlpha = !a && (name === 'rgb' || name === 'rgba') && parts.length === 4 ? parts.pop() : undefined
  const alphaText = a?.trim() ?? commaAlpha
  const alpha = alphaText === undefined ? 1 : num(alphaText, 1)
  if (name === 'rgb' || name === 'rgba') {
    if (parts.length < 3) return null
    return { lab: oklab(parts.slice(0, 3).map((p) => num(p, 255) / 255) as [number, number, number]), alpha }
  }
  if (name === 'color' && parts[0] === 'srgb' && parts.length >= 4) return { lab: oklab(parts.slice(1, 4).map((p) => num(p, 1)) as [number, number, number]), alpha }
  if (name === 'oklab' && parts.length >= 3) return { lab: [num(parts[0]!, 1), num(parts[1]!, 0.4), num(parts[2]!, 0.4)], alpha }
  if (name === 'oklch' && parts.length >= 3) {
    const [L, C, H] = [num(parts[0]!, 1), num(parts[1]!, 0.4), (parseFloat(parts[2]!) * Math.PI) / 180]
    return { lab: [L, C * Math.cos(H), C * Math.sin(H)], alpha }
  }
  return null
}

/** How far apart two colors look, in OKLab; null when either does not read. */
export function colorDistance(a: string, b: string): number | null {
  const x = parseColor(a)
  const y = parseColor(b)
  if (!x || !y) return null
  return Math.hypot(x.lab[0] - y.lab[0], x.lab[1] - y.lab[1], x.lab[2] - y.lab[2])
}

/** True when a filament color is close enough to the panel behind it to need the contrast edge. */
export function nearPanel(color: string, panel: string): boolean {
  const d = colorDistance(color, panel)
  return d !== null && d < NEAR_PANEL
}

/**
 * The background a swatch sits on: the first ancestor with a mostly opaque background color, else the page's surface
 * token, as the browser resolves it.
 */
export function panelBackground(el: Element): string | null {
  for (let at: Element | null = el.parentElement; at; at = at.parentElement) {
    const bg = getComputedStyle(at).backgroundColor
    const p = bg ? parseColor(bg) : null
    if (p && p.alpha >= 0.5) return bg
  }
  const token = getComputedStyle(document.documentElement).getPropertyValue('--ink-1').trim()
  return token || null
}
