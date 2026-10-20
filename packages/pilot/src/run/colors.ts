// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Plain color words as people say them about spools ("black PETG", "the transparent one"), with the color each stands
// for, and the word for a spool's own color. A named color matches a spool when the spool's nearest word is the same.

/** Each word with a typical filament color. Transparent spools report no alpha, so their word comes from the hex. */
const WORDS: readonly (readonly [string, string])[] = [
  ['black', '#000000'],
  ['white', '#FFFFFF'],
  ['gray', '#808080'],
  ['silver', '#C0C0C0'],
  ['red', '#D02020'],
  ['orange', '#F07820'],
  ['yellow', '#F0D020'],
  ['green', '#20A040'],
  ['blue', '#2050C0'],
  ['purple', '#7030A0'],
  ['pink', '#F080B0'],
  ['brown', '#7A4A2A'],
  ['beige', '#E0CDA8'],
  ['transparent', '#FFFFFF00'],
]

/** Other spellings people type for the same colors. */
const SAME: Readonly<Record<string, string>> = { grey: 'gray', clear: 'transparent', violet: 'purple', tan: 'beige' }

const rgb = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})/i.exec(hex)
  if (!m) return null
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** A #rrggbbaa color with an alpha of 00, as printers report a transparent spool. */
const clear = (hex: string): boolean => /^#?[0-9a-f]{6}00$/i.test(hex)

/**
 * The color a word names, as #RRGGBB (#RRGGBB00 for transparent): "black", "Matte Black" and "grey" all work, and a
 * hex color comes back as it is. Null for words that name no color.
 */
export function colorWordHex(word: string): string | null {
  const w = word.trim()
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(w)) return w.toUpperCase()
  for (const token of w.toLowerCase().split(/[^a-z]+/)) {
    const name = SAME[token] ?? token
    const hit = WORDS.find(([n]) => n === name)
    if (hit) return hit[1]
  }
  return null
}

/** The nearest color word for a spool's #rrggbb color, such as "black" for #161616. Null when the color cannot be read. */
export function colorWord(hex: string | undefined): string | null {
  if (!hex) return null
  if (clear(hex)) return 'transparent'
  const c = rgb(hex)
  if (!c) return null
  let best: string | null = null
  let dist = Infinity
  for (const [name, h] of WORDS) {
    if (name === 'transparent') continue
    const w = rgb(h)!
    const d = Math.hypot(c[0] - w[0], c[1] - w[1], c[2] - w[2])
    if (d < dist) {
      best = name
      dist = d
    }
  }
  return best
}
