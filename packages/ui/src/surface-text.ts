// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Text and marks that sit on the raised surfaces (cards, fields, segmented tracks, the selected segment, status
// pills) reach the spec ratios on those surfaces, not only on the page. They are worked out from the colors a theme
// applies, so a theme file, an edition's colors and a createTheme() override all get them, and a theme that already
// reads keeps its colors as they are. Everything moves in lightness toward white on a dark theme and black on a
// light one, never toward another hue.
import { contrast, mixHex, parseHex, readable } from './color'

/**
 * Text reaches 4.5:1 on the surface it sits on, and icons and other marks that carry meaning 3:1 (spec, Borders and
 * lines). The targets sit a hair above, so the browser's rounding of the mixed surfaces never lands a color under.
 */
const TEXT = 4.6
const MARK = 3.1

/** The axis colors of the move, rotate and scale handles (tokens.css --axis-x, --axis-y, --axis-z). */
export const AXIS_COLORS = { x: '#ff928a', y: '#51cf66', z: '#57b9ff' } as const

/**
 * The surface steps tokens.css builds from the theme colors, mirrored here so the text on them can be checked.
 * Dark: cards and fields step 7% and 14% from the pane toward the text, the selected segment 30%. Light: cards are
 * the surface, fields white, and the selected segment a 13% accent tint on white.
 */
export const SURFACE_STEPS = { card: 0.07, field: 0.14, selected: 0.3, selectedTint: 0.13 } as const

/** The tint each status color lays under its own text in a pill (tokens.css --red-tint and the rest). */
const TINTS = { red: 0.13, green: 0.12, orange: 0.13, cyan: 0.12, pink: 0.13, purple: 0.14 } as const

/** The colors the derivation reads, by their ThemeColors keys. */
export interface SurfaceTextInput {
  ink0: string
  ink1: string
  ink2: string
  fg: string
  muted: string
  dim: string
  purple: string
  pink: string
  cyan: string
  green: string
  orange: string
  red: string
  blue?: string | undefined
  /** The theme's own selected segment fill, when it sets one. */
  controlSelected?: string | undefined
}

/** Moves `hex` toward `end` in 5% steps until it reaches `min` on every ground; unchanged when it already does. */
function lift(hex: string, grounds: readonly string[], end: string, min: number): string {
  return readable(hex, grounds, end, min)
}

/** The percentage `mark` moves toward `ink` (in 5% steps) before it reaches `min` on `ground`. */
function liftPercent(mark: string, ground: string, ink: string, min: number): number {
  for (let n = 0; n <= 100; n += 5) if (contrast(mixHex(mark, ink, n / 100), ground) >= min) return n
  return 100
}

/**
 * The CSS variables for text and marks on raised surfaces, worked out from a theme's colors. Empty when a color
 * the rules need is not a #rrggbb value (a stylesheet theme that sets var() or named colors keeps the defaults).
 */
export function surfaceTextVars(c: SurfaceTextInput, scheme: 'dark' | 'light'): Record<string, string> {
  const need = [c.ink0, c.ink1, c.ink2, c.fg, c.muted, c.dim, c.purple, c.pink, c.cyan, c.green, c.orange, c.red]
  if (need.some((h) => !parseHex(h))) return {}
  const dark = scheme === 'dark'
  const end = dark ? '#ffffff' : '#000000'
  const card = dark ? mixHex(c.ink1, c.fg, SURFACE_STEPS.card) : c.ink2
  const field = dark ? mixHex(c.ink1, c.fg, SURFACE_STEPS.field) : '#ffffff'
  const own = c.controlSelected && parseHex(c.controlSelected) ? c.controlSelected : null
  const selectedOn = (accent: string) => own ?? (dark ? mixHex(c.ink1, c.fg, SURFACE_STEPS.selected) : mixHex('#ffffff', accent, SURFACE_STEPS.selectedTint))

  // fields, segmented tracks and menus: secondary and dim text toward the text color first, then toward the end
  const onField = (hex: string) => lift(lift(hex, [field], c.fg, TEXT), [field], end, TEXT)
  const fieldMuted = onField(c.muted)
  const fieldDim = onField(c.dim)

  // the selected segment: its label, its secondary line and its accent icon. The icon keeps its hue and moves toward
  // the label by the share the palest accent choice needs, so whichever accent the person picks reaches 3:1.
  const selected = selectedOn(c.purple)
  const selectedFg = lift(c.fg, [selected], end, TEXT)
  const selectedMuted = lift(lift(c.muted, [selected], selectedFg, TEXT), [selected], end, TEXT)
  // Each accent choice gets its own share (--control-selected-lift-purple and the rest; the look points
  // --control-selected-lift at the chosen one). On the app's own fill every choice takes the share the palest one
  // needs, so the icon looks the same whichever accent is picked; a theme that sets its own fill keeps each accent at
  // the least it needs, often its plain tone.
  const accents: [string, string][] = [['purple', c.purple], ['pink', c.pink], ['cyan', c.cyan], ['green', c.green], ['orange', c.orange], ...(c.blue && parseHex(c.blue) ? [['blue', c.blue] as [string, string]] : [])]
  const lifts = accents.map(([name, a]) => [name, liftPercent(a, selectedOn(a), selectedFg, MARK)] as const)
  const most = Math.max(...lifts.map(([, n]) => n))
  const liftOf = (n: number) => `${own ? n : most}%`

  // status colors as text (pills, roles, state words): on every surface they sit on and on their own tint
  const statusText = (hex: string, tint: number) => {
    const grounds = [c.ink0, c.ink1, c.ink2, card, field, ...[c.ink1, c.ink2, card].map((g) => mixHex(g, hex, tint))]
    return lift(hex, grounds, end, TEXT)
  }

  // the axis letters on X, Y and Z number fields (dark only; light deepens them in styles.css)
  const axisText = (hex: string) => (dark ? lift(hex, [field, card], end, TEXT) : hex)

  return {
    '--field-muted': fieldMuted,
    '--field-dim': fieldDim,
    '--control-selected-fg': selectedFg,
    '--control-selected-muted': selectedMuted,
    '--control-selected-lift': liftOf(lifts[0]?.[1] ?? most),
    ...Object.fromEntries(lifts.map(([name, n]) => [`--control-selected-lift-${name}`, liftOf(n)])),
    '--red-text': statusText(c.red, TINTS.red),
    '--green-text': statusText(c.green, TINTS.green),
    '--orange-text': statusText(c.orange, TINTS.orange),
    '--cyan-text': statusText(c.cyan, TINTS.cyan),
    '--pink-text': statusText(c.pink, TINTS.pink),
    '--purple-text': statusText(c.purple, TINTS.purple),
    '--axis-x-text': axisText(AXIS_COLORS.x),
    '--axis-y-text': axisText(AXIS_COLORS.y),
    '--axis-z-text': axisText(AXIS_COLORS.z),
  }
}
