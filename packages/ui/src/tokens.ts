// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Subban values for code that cannot read CSS variables (the viewport's WebGPU materials,
// canvas drawing, the reel). Mirrors tokens.css; a test keeps the two in step.

import { motionReduced } from './motion'
import { subban } from './theme'

/** Values of the Subban palette. Component styles use the CSS variables, never these. */
export const SUBBAN = subban.colors as Required<typeof subban.colors>

export type SubbanColor = keyof typeof SUBBAN

/** Maps a SUBBAN key to the CSS custom property that carries the same value. */
export const SUBBAN_VARS: Record<SubbanColor, string> = {
  ink0: '--ink-0',
  ink1: '--ink-1',
  ink2: '--ink-2',
  ink3: '--ink-3',
  ink4: '--ink-4',
  line: '--line',
  lineSoft: '--line-soft',
  fg: '--fg',
  muted: '--muted',
  dim: '--dim',
  purple: '--purple',
  pink: '--pink',
  cyan: '--cyan',
  green: '--green',
  orange: '--orange',
  yellow: '--yellow',
  red: '--red',
  blue: '--blue',
  onGrad: '--on-grad',
  shadow: '--shadow-color',
}

/** Palette meaning. Pick colors by role, not by name. */
export const ROLE = {
  accent: 'purple',
  selection: 'purple',
  focus: 'purple',
  creators: 'pink',
  commerce: 'pink',
  vault: 'pink',
  progress: 'cyan',
  info: 'cyan',
  live: 'cyan',
  ok: 'green',
  attention: 'orange',
  error: 'red',
} as const satisfies Record<string, SubbanColor>

/** Fonts, for canvases that draw text. */
export const FONTS = { display: subban.fonts.display, body: subban.fonts.body, mono: subban.fonts.mono } as const

/** Stylesheet for the three Subban families. */
export const FONTS_HREF = subban.fonts.href as string

/** @deprecated Use SUBBAN. */
export const NOCTURNE = SUBBAN
/** @deprecated Use SUBBAN_VARS. */
export const NOCTURNE_VARS = SUBBAN_VARS
/** @deprecated Use SubbanColor. */
export type NocturneColor = SubbanColor

/** Product names and the positioning line. Use these, never retyped strings. */
export const BRAND = {
  name: 'SlicerX',
  tagline: 'The AI-ready slicer',
  /** The AI sub-brand. "Pilot" alone only inside code identifiers. */
  pilot: 'mimir',
  /** The workspace that lists the user's printers. A "fleet" is an optional user-made group of printers. */
  printers: 'Printers',
} as const

/** Motion durations in milliseconds, matching --t-fast, --t-base and --t-slow. */
export const MOTION = { fast: 120, base: 160, slow: 260 } as const

/**
 * Reads a token from the live stylesheet, so themes stay in one place even for imperative
 * code. Returns the fallback when there is no document (tests, workers).
 */
export function readToken(name: string, fallback = '', el?: Element): string {
  if (typeof document === 'undefined') return fallback
  const target = el ?? document.documentElement
  const value = getComputedStyle(target).getPropertyValue(name).trim()
  return value || fallback
}

/** True when motion is reduced: the in-app Motion choice, which may follow the system (see motion.ts). */
export function prefersReducedMotion(): boolean {
  return motionReduced()
}
