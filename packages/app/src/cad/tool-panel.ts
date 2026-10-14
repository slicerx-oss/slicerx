// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The rules behind the tool panel's shared pieces (panel-kit.tsx), kept free of React so they can be tested alone:
// how a set of choices fits the panel's width, and how a message reads.

/**
 * How a set of choices shows: one line of options, options whose label takes two lines, one line with the narrow
 * padding (only where a select would come next), icons with tooltips, or a select.
 */
export type ChoiceFit = 'line' | 'wrap' | 'tight' | 'icons' | 'select'

/** More options than this never show as a row of words. */
export const MAX_WORD_OPTIONS = 3

export interface ChoiceMeasure {
  /** Width of each option's label on one line, px. */
  labels: readonly number[]
  /** Width of the longest word in each label, px. */
  words: readonly number[]
  /** Width the segment can take, px. */
  width: number
  /** Every option has an icon of its own. */
  icons: boolean
  /** The segment's frame (its padding on both sides), px. */
  frame?: number
  /** The gap between two options, px. */
  gap?: number
  /** Padding inside an option on one line, both sides together, px. */
  pad?: number
  /** Padding inside an option whose label takes two lines, px. */
  wrapPad?: number
  /** Padding inside an option on one line with the narrow padding (--s-1 each side) and a pixel to spare, px. */
  tightPad?: number
}

/** What a glyph before an option's word takes of its line: the 14 px icon and the 4 px gap after it. */
export const GLYPH_WIDTH = 18

/**
 * The widths choiceFit weighs for a set of option labels, from a measure of text in the segment's face: each label on
 * one line and its longest word, with a glyph's width added to the label and to its first word, which it sits before.
 */
export function choiceMeasure(labels: readonly string[], glyphs: readonly boolean[], width: (text: string) => number): { labels: number[]; words: number[] } {
  return {
    labels: labels.map((l, i) => width(l) + (glyphs[i] ? GLYPH_WIDTH : 0)),
    words: labels.map((l, i) => Math.max(0, ...l.split(/\s+/).map((w, k) => width(w) + (k === 0 && glyphs[i] ? GLYPH_WIDTH : 0)))),
  }
}

/**
 * How a set of choices fits: one line when every label fits its share of the width, two lines when every label fits in
 * two lines of its share with no word cut, and past that (or past three options) icons with tooltips when every option
 * has one, else one line with the narrow padding when every label fits that way, else a select. A width of 0 (not laid out yet) fits on one line, so the first frame has no select in it.
 */
export function choiceFit(m: ChoiceMeasure): ChoiceFit {
  const n = m.labels.length
  const fallback: ChoiceFit = m.icons ? 'icons' : 'select'
  if (n > MAX_WORD_OPTIONS) return fallback
  if (n === 0 || m.width <= 0) return 'line'
  const frame = m.frame ?? 6
  const gap = m.gap ?? 2
  const each = (m.width - frame - gap * (n - 1)) / n
  const line = each - (m.pad ?? 16)
  if (line > 0 && m.labels.every((w) => w <= line)) return 'line'
  // Two lines: no single word wider than a line, and the whole label within two lines (a word that wraps leaves
  // some of the first line empty, so a little room is kept).
  const two = each - (m.wrapPad ?? 12)
  if (two > 0 && m.words.every((w) => w <= two) && m.labels.every((w) => w <= two * 2 - Math.min(two * 0.25, 24))) return 'wrap'
  // Before a select takes over, every label on one line with the narrow padding. Sets that fit above, or that have
  // icons, never get here, so they show as they always did.
  const tight = each - (m.tightPad ?? 9)
  if (fallback === 'select' && tight > 0 && m.labels.every((w) => w <= tight)) return 'tight'
  return fallback
}

/** The control column's width (--w-ctl), px, and what a select's frame takes of it: padding, the arrow and the border. */
export const SELECT_WIDTH = 96
const SELECT_FRAME = 10 + 26 + 2

/** A select fits the control column when its longest option's text (px, in the select's face) fits inside it. */
export function selectFits(longest: number): boolean {
  return longest + SELECT_FRAME <= SELECT_WIDTH
}

/**
 * A message for the panel, as a sentence: the engine's own words often start with the tool's name in lower case
 * ("hole: pick the wall of a round hole"), which the panel's header already says. That prefix goes, the first letter
 * is a capital and the sentence ends in a stop.
 */
export function sentence(raw: string): string {
  let s = raw.trim()
  // "Error: hole: ..." and "geom: hole: ...": every lower case one-word prefix, and a thrown Error's own
  for (let prev = ''; prev !== s; ) {
    prev = s
    s = s.replace(/^(?:Error|[a-z][a-z0-9_.-]*):\s+/, '')
  }
  if (!s) return s
  s = s.charAt(0).toUpperCase() + s.slice(1)
  return /[.!?…)]$/.test(s) ? s : `${s}.`
}
