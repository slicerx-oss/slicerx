// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An edition's `brand.theme` block turned into a theme at runtime: the app, the embed pieces and the kit read the same
// keys, so a partner changes its look by editing its edition config. Anything unset or invalid keeps the SlicerX value.
import { createTheme, subban, type Theme, type ThemeColors, type ThemeInput, type ThemeScene } from './theme'
import { subbanLight } from './themes'

/** Studio colors an edition may set, per scheme or shared. All are #rrggbb. */
export type EditionScene = { [K in keyof ThemeScene]?: string | undefined }

/** One scheme's overrides in an edition theme. */
export interface EditionThemeScheme {
  colors?: Record<string, string | undefined> | undefined
  visuals?: Record<string, string | undefined> | undefined
  scene?: EditionScene | undefined
}

/** The `brand.theme` object of an edition config (packages/edition-config schema.ts), as plain data. */
export interface EditionThemeConfig {
  base?: string | undefined
  tokens?:
    | (EditionThemeScheme & {
        fonts?: { [K in 'display' | 'body' | 'mono']?: string | undefined } | undefined
        radius?: { [K in 'sm' | 'md' | 'lg']?: string | undefined } | undefined
      })
    | undefined
  light?: EditionThemeScheme | undefined
  dark?: EditionThemeScheme | undefined
}

export interface EditionThemeOptions {
  /** The theme name, written to data-sx-theme. Defaults to the base theme's name. */
  name?: string
  /** Turns a font family into the stack the theme uses (the app adds its fallbacks). Unset keeps the family as given. */
  font?: (family: string, role: 'display' | 'body' | 'mono') => string
}

/** The SlicerX studio colors (packages/ui/themes/subban-*.json), the fallback for scene keys an edition leaves out. */
export const SUBBAN_SCENE: Readonly<Record<'dark' | 'light', ThemeScene>> = {
  dark: { top: '#2f3241', bottom: '#20222b', glow: '#3c3f50', plate: '#3c3f50', grid: '#9aa4c1', edge: '#16171e' },
  light: { top: '#fbfbfc', bottom: '#dbdbe0', glow: '#fdfdfe', plate: '#b5b4bc', grid: '#88868f', edge: '#26222c', xray: '#583886' },
}

export const EDITION_SCENE_KEYS = ['top', 'bottom', 'glow', 'plate', 'grid', 'edge', 'xray'] as const satisfies readonly (keyof ThemeScene)[]

const HEX6 = /^#[0-9a-fA-F]{6}$/
const HEX8 = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/
const VISUAL = /^--(accent|ti-[a-z0-9]+|stage-[a-z0-9-]+|glyph-[a-z-]+)$/

function strings(o: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(o ?? {})) if (typeof v === 'string' && v) out[k] = v
  return out
}

/** Visual properties with a valid name and color; the accent stays opaque. */
function visualsOf(o: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(strings(o))) if (VISUAL.test(k) && (k === '--accent' ? HEX6 : HEX8).test(v)) out[k] = v
  return out
}

function sceneOf(o: EditionScene | undefined): EditionScene {
  const out: EditionScene = {}
  for (const k of EDITION_SCENE_KEYS) {
    const v = o?.[k]
    if (typeof v === 'string' && HEX6.test(v)) out[k] = v
  }
  return out
}

/** The studio colors an edition sets for a scheme (shared, then the scheme's own), valid #rrggbb values only. */
export function editionSceneOverrides(config: EditionThemeConfig | string | null | undefined, scheme: 'dark' | 'light'): EditionScene {
  if (!config || typeof config !== 'object') return {}
  return { ...sceneOf(config.tokens?.scene), ...sceneOf(config[scheme]?.scene) }
}

/** The visual properties an edition sets for a scheme (shared, then the scheme's own). */
export function editionVisualOverrides(config: EditionThemeConfig | string | null | undefined, scheme: 'dark' | 'light'): Record<string, string> {
  if (!config || typeof config !== 'object') return {}
  return { ...visualsOf(config.tokens?.visuals), ...visualsOf(config[scheme]?.visuals) }
}

/**
 * The theme an edition asks for in a scheme, on top of `base` (Subban dark or light unless given). A string config
 * (`'subban'`) or none returns the base unchanged. Scene keys the edition leaves out keep the base's studio, else the
 * SlicerX one; invalid values are dropped, so a typo never breaks the view.
 */
export function themeFromEdition(config: EditionThemeConfig | string | null | undefined, scheme: 'dark' | 'light', base?: Theme, opts: EditionThemeOptions = {}): Theme {
  const from = base ?? (scheme === 'light' ? subbanLight : subban)
  if (!config || typeof config !== 'object') return from
  const input: ThemeInput = { name: opts.name ?? from.name }
  const colors = { ...strings(config.tokens?.colors), ...strings(config[scheme]?.colors) }
  if (Object.keys(colors).length) input.colors = colors as Partial<ThemeColors>
  const visuals = editionVisualOverrides(config, scheme)
  if (Object.keys(visuals).length) input.visuals = visuals
  const scene = editionSceneOverrides(config, scheme)
  if (Object.keys(scene).length) input.scene = { ...(from.scene ?? SUBBAN_SCENE[from.scheme]), ...scene } as ThemeScene
  const fonts = strings(config.tokens?.fonts)
  if (Object.keys(fonts).length) input.fonts = Object.fromEntries(Object.entries(fonts).map(([k, v]) => [k, opts.font ? opts.font(v, k as 'display' | 'body' | 'mono') : v]))
  const radius = strings(config.tokens?.radius)
  if (Object.keys(radius).length) input.radius = radius
  return createTheme(input, from)
}
