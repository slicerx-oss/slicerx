// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Themes the embedded pieces without touching the host page: the variables
// apply to this subtree only. An edition config (its brand.theme block) sets
// the accent, the studio colors and the rest at runtime, over the theme.
import { subban, subbanLight, ThemeProvider, type Theme } from '@slicerx/ui'
import { editionSceneOverrides, editionVisualOverrides, mixHex, parseHex, themeFromEdition, type EditionThemeConfig } from '@slicerx/ui/theme'
import type { ViewportTheme } from '@slicerx/viewport'
import type { ReactNode } from 'react'

/**
 * An edition config as JSON: the whole file (`{ brand: { theme } }`), or its `brand.theme` block alone. Only the theme
 * is read; anything unset or invalid keeps the SlicerX value.
 */
export type EmbedEdition = { brand?: { theme?: EditionThemeConfig | string } } | EditionThemeConfig

export interface EmbedThemeProps {
  /** A full theme from @slicerx/ui (createTheme), or "dark" / "light" for the built-in ones. */
  theme?: Theme | 'dark' | 'light'
  /**
   * Your edition config, read at runtime: its `brand.theme` colors, visual properties (`--accent` and the rest) and
   * studio colors (`scene`) for the theme's scheme go over the theme. Change the config to change the look; no kit
   * release is needed.
   */
  edition?: EmbedEdition | null
  children?: ReactNode
}

/** The `brand.theme` block of an edition, whichever form it came in. */
export function editionThemeConfig(edition: EmbedEdition | null | undefined): EditionThemeConfig | undefined {
  if (!edition || typeof edition !== 'object') return undefined
  if ('brand' in edition) {
    const t = edition.brand?.theme
    return t && typeof t === 'object' ? t : undefined
  }
  return edition as EditionThemeConfig
}

/** The theme for the pieces: the built-in or given theme, with the edition's values for its scheme on top. */
export function resolveTheme(t: EmbedThemeProps['theme'], edition?: EmbedEdition | null): Theme {
  const base = t === 'light' ? subbanLight : t === undefined || t === 'dark' ? subban : t
  const config = editionThemeConfig(edition)
  return config ? themeFromEdition(config, base.scheme, base) : base
}

/**
 * The theme an edition asks for in a scheme, on top of `base` (Subban dark or light unless given), for hosts that
 * pass a full theme: `theme={editionTheme(editionJson, 'light')}`.
 */
export function editionTheme(edition: EmbedEdition | null | undefined, scheme: 'dark' | 'light', base?: Theme): Theme {
  return themeFromEdition(editionThemeConfig(edition), scheme, base)
}

/**
 * What an edition sets for a scheme, as the pieces apply it: visual properties and studio colors. For a host or a
 * client checking that its config was read.
 */
export function editionOverrides(edition: EmbedEdition | null | undefined, scheme: 'dark' | 'light'): { visuals: Record<string, string>; scene: Record<string, string> } {
  const config = editionThemeConfig(edition)
  return { visuals: editionVisualOverrides(config, scheme), scene: editionSceneOverrides(config, scheme) as Record<string, string> }
}

/** Wrap one or more embed pieces to give them a theme. */
export function EmbedTheme({ theme, edition, children }: EmbedThemeProps) {
  return (
    <ThemeProvider theme={resolveTheme(theme, edition)} scope="scope">
      {children}
    </ThemeProvider>
  )
}

const hex = (v: string | undefined): string | undefined => (v && parseHex(v) ? v : undefined)

/**
 * The 3D scene colors for a theme: its own `scene` block when it has one, a light studio built from
 * its surfaces when it is light, and its accent (`--accent` when set, else the palette purple) for the selection
 * outline. Undefined keeps the default dark studio.
 */
export function sceneFor(theme: Theme): ViewportTheme | undefined {
  const c = theme.colors
  const scene: Record<string, string> = {}
  const set = (key: string, v: string | undefined) => {
    if (hex(v)) scene[key] = v as string
  }
  if (theme.scene) {
    set('bgTop', theme.scene.top)
    set('bgBottom', theme.scene.bottom)
    set('bgGlow', theme.scene.glow)
    set('plateSide', theme.scene.plate)
    set('floorGrid', theme.scene.grid)
    set('edgeDark', theme.scene.edge)
    set('edgeXray', theme.scene.xray)
  } else if (theme.scheme === 'light' && hex(c.ink0) && hex(c.line) && hex(c.fg)) {
    set('bgTop', mixHex(c.ink0, '#ffffff', 0.55))
    set('bgBottom', mixHex(c.ink2, c.line, 0.6))
    set('bgGlow', mixHex('#ffffff', c.ink0, 0.25))
    set('plateSide', mixHex(c.line, c.fg, 0.18))
    set('floorGrid', mixHex(c.line, c.fg, 0.45))
    set('edgeDark', mixHex(c.fg, '#000000', 0.15))
  }
  // an edition's explicit accent wins over the palette purple, as in the app
  set('selection', theme.visuals?.['--accent'] ?? c.purple)
  set('liveLayer', c.cyan)
  return Object.keys(scene).length ? { scene } : undefined
}
