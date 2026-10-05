// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Nocturne for React Native. Colors, radii and the spacing unit come from the React-free theme
// entry of @slicerx/ui, so a retheme there reaches the phone. React Native has no CSS variables
// and no color-mix(), so tints are computed here once.
import { nocturne, resolveColor, type Theme } from '@slicerx/ui/theme'
import type { Tone } from '@slicerx/contracts'
import type { TextStyle } from 'react-native'

const px = (v: string): number => Number.parseFloat(v) || 0

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.slice(0, 6)
  const n = Number.parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** A hex color at the given opacity, as rgba(). */
export function alpha(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

/** Same result as CSS color-mix(in srgb, a pct%, b). */
export function mix(a: string, b: string, pct: number): string {
  const x = hexToRgb(a)
  const y = hexToRgb(b)
  const t = pct / 100
  const c = x.map((v, i) => Math.round(v * t + (y[i] ?? 0) * (1 - t)))
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function build(theme: Theme) {
  const c = theme.colors
  const unit = theme.spacing.unit
  return {
    scheme: theme.scheme,
    color: {
      ...c,
      /** Raised tints used for selection, approvals and live rows. */
      purpleTint: mix(c.purple, c.ink1, 10),
      purpleEdge: mix(c.purple, c.lineSoft, 45),
      cyanTint: mix(c.cyan, c.ink1, 8),
      greenTint: mix(c.green, c.ink1, 9),
      orangeTint: mix(c.orange, c.ink1, 10),
      redTint: mix(c.red, c.ink1, 10),
      scrim: alpha('#000000', 0.55),
      shadow: '#000000',
    },
    gradient: { from: resolveColor(theme, theme.gradient.from), to: resolveColor(theme, theme.gradient.to) },
    radius: { xs: px(theme.radius.xs), sm: px(theme.radius.sm), md: px(theme.radius.md), lg: px(theme.radius.lg), pill: 999 },
    /** space(1) is one grid unit (8 in Nocturne); space(0.5) is 4. */
    space: (steps: number) => steps * unit,
    gutter: unit * 2,
    hairline: 1,
    /** The smallest touch target on either platform. */
    hit: 44,
  }
}

export const t = build(nocturne)
export type Tokens = typeof t

/**
 * Font families as registered with expo-font. Custom faces on Android need one family per weight,
 * so weights are picked by family name instead of fontWeight.
 */
export const font = {
  display: 'Unbounded_600SemiBold',
  body: 'HankenGrotesk_400Regular',
  bodyMedium: 'HankenGrotesk_500Medium',
  bodySemi: 'HankenGrotesk_600SemiBold',
  bodyBold: 'HankenGrotesk_700Bold',
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
} as const

/** Type scale in px with line heights. Prose in chat is 16 at 1.5 for reading. */
export const type = {
  display: { fontFamily: font.display, fontSize: 24, lineHeight: 30, letterSpacing: -0.2 },
  title: { fontFamily: font.bodySemi, fontSize: 20, lineHeight: 26 },
  heading: { fontFamily: font.bodySemi, fontSize: 17, lineHeight: 23 },
  body: { fontFamily: font.body, fontSize: 16, lineHeight: 24 },
  bodyMedium: { fontFamily: font.bodyMedium, fontSize: 16, lineHeight: 24 },
  label: { fontFamily: font.bodyMedium, fontSize: 14, lineHeight: 20 },
  caption: { fontFamily: font.body, fontSize: 13, lineHeight: 18 },
  mono: { fontFamily: font.mono, fontSize: 13, lineHeight: 18, fontVariant: ['tabular-nums'] },
  monoLarge: { fontFamily: font.monoMedium, fontSize: 20, lineHeight: 26, fontVariant: ['tabular-nums'] },
} satisfies Record<string, TextStyle>

export type TypeVariant = keyof typeof type

/** Palette by meaning, never by hue. Mirrors ROLE in @slicerx/ui. */
export const role = {
  accent: t.color.purple,
  creators: t.color.pink,
  live: t.color.cyan,
  ok: t.color.green,
  attention: t.color.orange,
  error: t.color.red,
} as const

/** Tone of a value in Pilot tool output. */
export const toneColor: Record<Tone, string> = {
  ok: t.color.green,
  warn: t.color.orange,
  bad: t.color.red,
  run: t.color.cyan,
  dim: t.color.dim,
  hl: t.color.fg,
}

/** Durations in ms, matching --t-fast, --t-base and --t-slow. */
export const motion = { fast: 120, base: 160, slow: 260 } as const
