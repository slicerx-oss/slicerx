// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Themes as data. A theme file holds the base colors only; everything else (panes, hairlines,
// chips, secondary text, status colors, ink on the accent) is derived here by fixed rules, so a
// theme author never tunes shades by hand and every theme keeps the same contrast floor.

import { FONT_IDS } from './fonts-ids'
import type { Theme, ThemeColors, ThemeScene } from './theme'
import { nocturne } from './theme'
import { resolveFonts, THEME_FONT_CHOICE, type FontChoice } from './fonts'

export const THEME_FILE_VERSION = 1

export interface ThemeFile {
  version: 1
  id: string
  name: string
  isDark: boolean
  background: string
  surface: string
  surfaceAlt: string
  border: string
  text: string
  muted: string
  accent: string
  selection?: string
  /** 16 terminal colors: 1 red, 2 green, 3 yellow, 4 blue, 5 magenta, 6 cyan are used. */
  ansi: string[]
  working?: string
  waiting?: string
  failed?: string
  fonts?: { ui?: string; mono?: string }
  /** The 3D studio colors. Any key left out is derived. */
  scene?: Partial<ThemeScene>
  credit?: string
}

// ---------------------------------------------------------------------------------------------
// Hex math

type Rgb = { r: number; g: number; b: number }

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

/** Same brightness as `hex` with its saturation at least `minSat`, moved to `hue` degrees. */
export function rehue(hex: string, hue: number, minSat: number): string {
  const c = parseHex(hex)
  if (!c) return hex
  const mx = Math.max(c.r, c.g, c.b)
  const mn = Math.min(c.r, c.g, c.b)
  const v = mx
  const s = Math.max(mx === 0 ? 0 : (mx - mn) / mx, minSat)
  const h = hue / 60
  const i = Math.floor(h) % 6
  const f = h - Math.floor(h)
  const p = v * (1 - s)
  const q = v * (1 - s * f)
  const t = v * (1 - s * (1 - f))
  const rgb: [number, number, number][] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ]
  const [r, g, b] = rgb[i] as [number, number, number]
  return formatHex({ r, g, b })
}

// ---------------------------------------------------------------------------------------------
// Derived colors

export interface DerivedPalette {
  background: string
  pane: string
  surface: string
  surfaceAlt: string
  chip: string
  chipStrong: string
  border: string
  hairline: string
  text: string
  secondary: string
  dim: string
  accent: string
  onAccent: string
  selection: string
  red: string
  green: string
  orange: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
}

/** Text must reach this on the background and the surface. */
export const TEXT_CONTRAST = 4.5
/** Glyphs and dots (status colors, accent on a light theme) must reach this. */
export const GLYPH_CONTRAST = 3

export function derivePalette(t: ThemeFile): DerivedPalette {
  const ansi = t.ansi.length >= 16 ? t.ansi : [...t.ansi, ...Array<string>(16 - t.ansi.length).fill(t.accent)]
  const a = (i: number) => ansi[i] as string
  const grounds = [t.background, t.surface]
  const text = (hex: string, min: number) => readable(hex, grounds, t.text, min)
  const m = mixHex
  const accent = t.isDark ? t.accent : text(t.accent, GLYPH_CONTRAST)
  const ink = t.isDark ? m(t.background, '#000000', 0.25) : '#ffffff'
  const other = t.isDark ? '#ffffff' : t.text
  return {
    background: t.background,
    pane: m(t.background, t.surface, 0.5),
    surface: t.surface,
    surfaceAlt: t.surfaceAlt,
    chip: m(t.background, t.border, 0.62),
    chipStrong: m(t.surface, t.border, 0.6),
    border: t.border,
    hairline: m(t.background, t.border, 0.7),
    text: t.text,
    secondary: text(m(t.muted, t.text, 0.37), TEXT_CONTRAST),
    dim: text(t.muted, TEXT_CONTRAST),
    accent,
    onAccent: contrast(ink, accent) >= contrast(other, accent) ? ink : other,
    selection: t.selection ?? t.border,
    red: text(t.failed ?? a(1), GLYPH_CONTRAST),
    green: text(t.working ?? a(2), GLYPH_CONTRAST),
    orange: text(t.waiting ?? rehue(a(3), 30, 0.55), GLYPH_CONTRAST),
    yellow: text(a(3), GLYPH_CONTRAST),
    blue: text(a(4), GLYPH_CONTRAST),
    magenta: text(a(5), GLYPH_CONTRAST),
    cyan: text(a(6), GLYPH_CONTRAST),
  }
}

/** The scene keys a theme file may set. */
export const SCENE_KEYS = ['top', 'bottom', 'glow', 'plate', 'grid', 'edge', 'xray'] as const

/**
 * The 3D studio colors. A dark theme gets a dark studio built from its surfaces; a light theme gets
 * a light studio, with a pale gradient, darker grid lines and dark edges so the model still reads.
 * Anything the file's `scene` block sets wins over the derived value.
 */
export function deriveScene(t: ThemeFile): ThemeScene {
  const p = derivePalette(t)
  const m = mixHex
  const derived: ThemeScene = t.isDark
    ? { top: t.surface, bottom: m(t.background, '#000000', 0.2), glow: p.chipStrong, plate: p.chipStrong, grid: p.secondary, edge: m(t.background, '#000000', 0.45) }
    : {
        top: m(t.background, '#ffffff', 0.55),
        bottom: m(t.surfaceAlt, t.border, 0.6),
        glow: m('#ffffff', t.background, 0.25),
        plate: m(t.border, t.text, 0.18),
        grid: m(t.border, t.text, 0.45),
        edge: m(t.text, '#000000', 0.15),
        xray: m(p.accent, t.text, 0.4),
      }
  return { ...derived, ...(t.scene ?? {}) }
}

/** The app's color variables for a theme file: the derived palette mapped onto --ink-0 and the rest. */
export function themeColors(t: ThemeFile): ThemeColors {
  const p = derivePalette(t)
  return {
    ink0: p.background,
    ink1: p.pane,
    ink2: p.surface,
    ink3: p.surfaceAlt,
    ink4: p.chipStrong,
    line: p.border,
    lineSoft: p.hairline,
    fg: p.text,
    muted: p.secondary,
    dim: p.dim,
    purple: p.accent,
    pink: p.magenta,
    cyan: p.cyan,
    green: p.green,
    orange: p.orange,
    yellow: p.yellow,
    red: p.red,
    onGrad: p.onAccent,
    shadow: t.isDark ? 'rgb(0 0 0 / 70%)' : 'rgb(42 40 51 / 20%)',
  }
}

/** The app Theme object for a theme file and the person's font choice. */
export function themeFromFile(t: ThemeFile, fonts: FontChoice = THEME_FONT_CHOICE): Theme {
  const f = resolveFonts(fonts, t.fonts)
  return {
    name: t.id,
    scheme: t.isDark ? 'dark' : 'light',
    colors: themeColors(t),
    gradient: { ...nocturne.gradient },
    fonts: { display: f.display, body: f.body, mono: f.mono },
    radius: { ...nocturne.radius },
    spacing: { ...nocturne.spacing },
    scene: deriveScene(t),
  }
}

// ---------------------------------------------------------------------------------------------
// Validation

export type ThemeResult = { ok: true; theme: ThemeFile; warnings: string[] } | { ok: false; errors: string[] }

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/
const COLOR_KEYS = ['background', 'surface', 'surfaceAlt', 'border', 'text', 'muted', 'accent'] as const
const OPTIONAL_COLOR_KEYS = ['selection', 'working', 'waiting', 'failed'] as const
/** A theme file is small. Anything bigger is not a theme. */
export const MAX_THEME_BYTES = 16 * 1024

/** Checks an unknown value against the schema. Unknown keys are ignored, bad values are named. */
export function validateThemeFile(input: unknown): ThemeResult {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, errors: ['A theme is a JSON object.'] }
  const o = input as Record<string, unknown>
  if (o['version'] !== THEME_FILE_VERSION) errors.push(`version must be ${THEME_FILE_VERSION}.`)
  const id = o['id']
  if (typeof id !== 'string' || !SLUG.test(id)) errors.push('id must be a lowercase slug of letters, digits and hyphens, up to 40 characters.')
  const name = o['name']
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 40) errors.push('name must be 1 to 40 characters.')
  if (typeof o['isDark'] !== 'boolean') errors.push('isDark must be true or false.')
  const badColors: string[] = []
  for (const k of COLOR_KEYS) if (typeof o[k] !== 'string' || !parseHex(o[k] as string)) badColors.push(k)
  for (const k of OPTIONAL_COLOR_KEYS) if (o[k] !== undefined && (typeof o[k] !== 'string' || !parseHex(o[k] as string))) badColors.push(k)
  if (badColors.length) errors.push(`${badColors.join(', ')} ${badColors.length === 1 ? 'must be a color' : 'must be colors'} like #1a2b3c.`)
  const ansi = o['ansi']
  if (!Array.isArray(ansi) || ansi.length !== 16 || ansi.some((c) => typeof c !== 'string' || !parseHex(c))) errors.push('ansi must be a list of exactly 16 colors like #1a2b3c.')
  const fonts = o['fonts']
  let fontsOut: ThemeFile['fonts']
  if (fonts !== undefined) {
    if (typeof fonts !== 'object' || fonts === null || Array.isArray(fonts)) errors.push('fonts must be an object.')
    else {
      const f = fonts as Record<string, unknown>
      fontsOut = {}
      if (f['ui'] !== undefined) {
        if (typeof f['ui'] === 'string' && (FONT_IDS.ui as readonly string[]).includes(f['ui'])) fontsOut.ui = f['ui']
        else errors.push(`fonts.ui must be one of: ${FONT_IDS.ui.join(', ')}.`)
      }
      if (f['mono'] !== undefined) {
        if (typeof f['mono'] === 'string' && (FONT_IDS.mono as readonly string[]).includes(f['mono'])) fontsOut.mono = f['mono']
        else errors.push(`fonts.mono must be one of: ${FONT_IDS.mono.join(', ')}.`)
      }
    }
  }
  const scene = o['scene']
  let sceneOut: ThemeFile['scene']
  if (scene !== undefined) {
    if (typeof scene !== 'object' || scene === null || Array.isArray(scene)) errors.push('scene must be an object.')
    else {
      const sc = scene as Record<string, unknown>
      sceneOut = {}
      const bad: string[] = []
      for (const k of SCENE_KEYS) {
        if (sc[k] === undefined) continue
        if (typeof sc[k] === 'string' && parseHex(sc[k] as string)) sceneOut[k] = sc[k] as string
        else bad.push(k)
      }
      if (bad.length) errors.push(`scene.${bad.join(', scene.')} must be a color like #1a2b3c.`)
    }
  }
  const credit = o['credit']
  if (credit !== undefined && (typeof credit !== 'string' || credit.length > 200)) errors.push('credit must be text of up to 200 characters.')
  if (errors.length) return { ok: false, errors }
  const theme: ThemeFile = {
    version: 1,
    id: id as string,
    name: (name as string).trim(),
    isDark: o['isDark'] as boolean,
    background: o['background'] as string,
    surface: o['surface'] as string,
    surfaceAlt: o['surfaceAlt'] as string,
    border: o['border'] as string,
    text: o['text'] as string,
    muted: o['muted'] as string,
    accent: o['accent'] as string,
    ansi: [...(ansi as string[])],
  }
  for (const k of OPTIONAL_COLOR_KEYS) if (typeof o[k] === 'string') theme[k] = o[k] as string
  if (fontsOut && Object.keys(fontsOut).length) theme.fonts = fontsOut
  if (sceneOut && Object.keys(sceneOut).length) theme.scene = sceneOut
  if (typeof credit === 'string') theme.credit = credit
  return { ok: true, theme, warnings: themeWarnings(theme) }
}

/** Things worth telling the author. The app still shows the theme, because it derives readable shades. */
export function themeWarnings(t: ThemeFile): string[] {
  const out: string[] = []
  const lum = (h: string) => {
    const c = parseHex(h)
    return c ? 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b : 0
  }
  if (t.isDark !== lum(t.background) < 0.5) out.push(t.isDark ? 'isDark is true but the background is light.' : 'isDark is false but the background is dark.')
  for (const g of [t.background, t.surface]) {
    const c = contrast(t.text, g)
    if (c < TEXT_CONTRAST) out.push(`text on ${g} reaches only ${c.toFixed(1)}:1, below ${TEXT_CONTRAST}:1.`)
  }
  return out
}

/** Parses and validates theme text. Never throws. */
export function parseThemeText(text: string): ThemeResult {
  if (text.length > MAX_THEME_BYTES) return { ok: false, errors: [`A theme file is at most ${MAX_THEME_BYTES / 1024} KB.`] }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, errors: ['This is not valid JSON.'] }
  }
  return validateThemeFile(json)
}

const KEY_ORDER = ['version', 'id', 'name', 'isDark', 'background', 'surface', 'surfaceAlt', 'border', 'text', 'muted', 'accent', 'selection', 'ansi', 'working', 'waiting', 'failed', 'fonts', 'scene', 'credit'] as const

/** Pretty JSON in the documented key order, ready to share. */
export function serializeTheme(t: ThemeFile): string {
  const out: Record<string, unknown> = { $schema: 'https://slicerx.app/schemas/theme-1.json' }
  for (const k of KEY_ORDER) if (t[k] !== undefined) out[k] = t[k]
  return JSON.stringify(out, null, 2) + '\n'
}
