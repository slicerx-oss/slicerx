// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Hex color math shared by the theme files and the surface text derivation: parse, format, mix and WCAG contrast.

export type Rgb = { r: number; g: number; b: number }

/** Parses "#rrggbb" or "#rrggbbaa" (alpha ignored) into 0 to 1 components, or null. */
export function parseHex(s: string): Rgb | null {
  const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(s)
  if (!m) return null
  const n = Number.parseInt(m[1] as string, 16)
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}

export function formatHex(c: Rgb): string {
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')
  return `#${byte(c.r)}${byte(c.g)}${byte(c.b)}`
}

/** Moves `from` the fraction `amount` of the way to `to`. */
export function mixHex(from: string, to: string, amount: number): string {
  const f = parseHex(from)
  const t = parseHex(to)
  if (!f || !t) return from
  return formatHex({ r: f.r + (t.r - f.r) * amount, g: f.g + (t.g - f.g) * amount, b: f.b + (t.b - f.b) * amount })
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const lum = (h: string) => {
    const c = parseHex(h)
    return c ? 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b) : 0
  }
  const x = lum(a)
  const y = lum(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/**
 * `hex` mixed toward `toward` in 5% steps until it reaches `min` contrast on every ground.
 * Unchanged when it already does. On a light theme `toward` is the dark text, so colors deepen;
 * on a dark theme they brighten.
 */
export function readable(hex: string, grounds: readonly string[], toward: string, min: number): string {
  if (!parseHex(hex)) return hex
  const reads = (c: string) => grounds.every((g) => contrast(c, g) >= min)
  if (reads(hex)) return hex
  for (let t = 0.05; t < 1; t += 0.05) {
    const m = mixHex(hex, toward, t)
    if (reads(m)) return m
  }
  return toward
}
