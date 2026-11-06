// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Paint texts as the project writer carries them: 4-bit codes in upper-case hex, last code first, a tree of leaves and
// splits (packages/ui/viewport/src/paint.ts reads and writes them for the brush). The `paint_*` attributes write a
// leaf's state 3 and up after its code C as a run, each F adding 15 until a code below F, so 18 is `C F 0`. The facets
// JSON (Metadata/Slic3r_facets_annotation.json) writes them with an escape: one code for 3 to 16, or E and then an
// 8-bit value, low code first, for 17 and up (17 is `C E 0 0`). States 0 to 16 are the same text either way.

/** Deepest nesting read, as the brush reads. */
const MAX_DEPTH = 12

/** The highest state a paint text names; a higher one reads as unpainted. */
const MAX_STATE = 32

/**
 * A `paint_*` text read: its states and the same tree's codes in the escape scheme, codes past the tree left out; null
 * when it does not read.
 */
function read(text: string): { states: number[]; escape: number[] } | null {
  const s = text.trim() === 'FC' ? '0FC' : text.trim()
  const codes: number[] = []
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s.charCodeAt(i)
    const d = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : -1
    if (d < 0) return null
    codes.push(d)
  }
  let at = 0
  const states: number[] = []
  const escape: number[] = []
  const node = (depth: number): boolean => {
    const code = codes[at++]
    if (code === undefined) return false
    if ((code & 3) === 0) {
      if (code >> 2 !== 3) {
        states.push(code >> 2)
        escape.push(code)
        return true
      }
      let state = 3
      for (;;) {
        const c = codes[at++]
        if (c === undefined) return false
        state += c
        if (c < 15) break
      }
      if (state > MAX_STATE) state = 0
      states.push(state)
      if (state < 3) escape.push(state << 2)
      else if (state < 17) escape.push(12, state - 3)
      else escape.push(12, 14, (state - 17) & 15, (state - 17) >> 4)
      return true
    }
    if (depth >= MAX_DEPTH || code >> 2 > 2) return false
    escape.push(code)
    for (let k = 0; k <= (code & 3); k++) if (!node(depth + 1)) return false
    return true
  }
  return codes.length && node(0) ? { states, escape } : null
}

/** The highest state a `paint_*` text paints, 0 for none; -1 when it does not read. */
export function paintTextMaxState(text: string): number {
  const r = read(text)
  return r ? Math.max(0, ...r.states) : -1
}

/** A `paint_*` text in the escape scheme, or null when it does not read. */
export function escapeText(text: string): string | null {
  const r = read(text)
  return r
    ? r.escape
        .reverse()
        .map((d) => d.toString(16).toUpperCase())
        .join('')
    : null
}
