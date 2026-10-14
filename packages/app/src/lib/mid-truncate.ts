// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Names cut in the middle: the start and the end stay, which is where names in one project differ ("Deck box, label
// plate, racer" and "Deck box, label plate, starship" keep their last words). The full name goes in a tooltip.

const ELLIPSIS = '…'

/** `s` in at most `max` characters, the middle replaced by an ellipsis; the end keeps the larger half. */
export function midTruncate(s: string, max: number): string {
  if (s.length <= max) return s
  if (max <= 1) return max === 1 ? ELLIPSIS : ''
  const keep = max - 1
  const head = Math.floor(keep / 2)
  const tail = keep - head
  return s.slice(0, head).trimEnd() + ELLIPSIS + s.slice(s.length - tail).trimStart()
}

/**
 * The longest middle cut of `s` whose drawn width, by `measure`, fits in `width` px. The whole name when it fits; an
 * empty string only when not even the ellipsis fits.
 */
export function fitMiddle(s: string, width: number, measure: (text: string) => number): string {
  if (measure(s) <= width) return s
  let lo = 0
  let hi = s.length - 1
  // The widest cut that fits: binary search on the number of characters kept.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(midTruncate(s, mid)) <= width) lo = mid
    else hi = mid - 1
  }
  return midTruncate(s, lo)
}

let ctx: CanvasRenderingContext2D | null | undefined
/** A text width in px in an element's own font, measured on a canvas so nothing in the page lays out again. */
export function textWidth(text: string, font: string): number {
  if (ctx === undefined) ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  if (!ctx) return text.length * 7
  ctx.font = font
  return ctx.measureText(text).width
}
