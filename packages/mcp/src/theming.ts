// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Theming tools: read the built-in themes, and build a theme for an embedded
// SlicerX (colors, fonts, gradient, radii, spacing) with a contrast check and
// the stylesheet the integrator's page loads. The server has no page of its
// own, so "setting" a theme means producing the files the page applies.
import { subban, resolveColor, themes, type Theme } from '@slicerx/ui/theme'
import { z } from 'zod'

export interface ContrastCheck {
  pair: string
  ratio: number | null
  required: number
  ok: boolean | null
}

function rgb(color: string): [number, number, number] | undefined {
  const hex = color.trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(hex)) return [0, 1, 2].map((i) => parseInt(hex.charAt(i).repeat(2), 16)) as [number, number, number]
  if (/^[0-9a-f]{6}$/i.test(hex)) return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
  return undefined
}

function luminance([r, g, b]: [number, number, number]): number {
  const c = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b)
}

/** WCAG contrast ratio of two hex colors, or null when either is not a hex color. */
export function contrast(a: string, b: string): number | null {
  const x = rgb(a)
  const y = rgb(b)
  if (!x || !y) return null
  const [hi, lo] = [luminance(x), luminance(y)].sort((m, n) => n - m) as [number, number]
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}

/** The readability rules from the theming guide: body text at WCAG AA, visible control edges, readable text on the gradient. */
export function checkTheme(theme: Theme): ContrastCheck[] {
  const c = theme.colors
  const pairs: [string, string, string, number][] = [
    ['fg on ink0', c.fg, c.ink0, 4.5],
    ['fg on ink1', c.fg, c.ink1, 4.5],
    ['fg on ink2', c.fg, c.ink2, 4.5],
    ['fg on ink3', c.fg, c.ink3, 4.5],
    ['muted on ink1', c.muted, c.ink1, 4.5],
    // A hairline against a raised fill. Controls are identified by their fill and label, so this edge is
    // decoration: the SlicerX palettes sit at 1.16 (light) to 1.29 (dark), and 1.15 keeps the rule
    // against a border that disappears into its fill.
    ['line against ink3', c.line, c.ink3, 1.15],
    ['onGrad on gradient start', c.onGrad, resolveColor(theme, theme.gradient.from), 4.5],
    ['onGrad on gradient end', c.onGrad, resolveColor(theme, theme.gradient.to), 4.5],
    ['onGrad on accent (primary button)', c.onGrad, c.purple, 4.5],
  ]
  return pairs.map(([pair, a, b, required]) => {
    const ratio = contrast(a, b)
    return { pair, ratio, required, ok: ratio === null ? null : ratio >= required }
  })
}

const color = z.string().min(1).max(64)
const colorKeys = Object.keys(subban.colors) as (keyof Theme['colors'])[]
export const themeInput = z
  .object({
    name: z.string().regex(/^[a-z0-9-]{1,40}$/, 'lowercase letters, digits and dashes').optional(),
    scheme: z.enum(['dark', 'light']).optional(),
    colors: z.object(Object.fromEntries(colorKeys.map((k) => [k, color.optional()])) as Record<keyof Theme['colors'], z.ZodOptional<typeof color>>).partial().optional(),
    gradient: z.object({ from: color, to: color, angle: z.string().max(16) }).partial().optional(),
    fonts: z.object({ display: z.string().max(200), body: z.string().max(200), mono: z.string().max(200), href: z.string().url().max(500) }).partial().optional(),
    radius: z.object({ xs: z.string().max(16), sm: z.string().max(16), md: z.string().max(16), lg: z.string().max(16) }).partial().optional(),
    spacing: z.object({ unit: z.number().min(4).max(16) }).partial().optional(),
  })
  .strict()

// nocturne and nocturneLight are the earlier names of subban and subbanLight, kept for callers that still send them
export const builtInThemes: Record<string, Theme> = { ...themes, nocturne: themes.subban, nocturneLight: themes.subbanLight }
export const builtInNames = Object.keys(builtInThemes) as [string, ...string[]]
