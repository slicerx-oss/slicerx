// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Themes the embedded pieces without touching the host page: the variables
// apply to this subtree only.
import { nocturne, nocturneLight, ThemeProvider, type Theme } from '@slicerx/ui'
import { mixHex, parseHex } from '@slicerx/ui/theme'
import type { ViewportTheme } from '@slicerx/viewport'
import type { ReactNode } from 'react'

export interface EmbedThemeProps {
  /** A full theme from @slicerx/ui (createTheme), or "dark" / "light" for the built-in ones. */
  theme?: Theme | 'dark' | 'light'
  children?: ReactNode
}

export function resolveTheme(t: EmbedThemeProps['theme']): Theme {
  if (t === 'light') return nocturneLight
  if (t === undefined || t === 'dark') return nocturne
  return t
}

/** Wrap one or more embed pieces to give them a theme. */
export function EmbedTheme({ theme, children }: EmbedThemeProps) {
  return (
    <ThemeProvider theme={resolveTheme(theme)} scope="scope">
      {children}
    </ThemeProvider>
  )
}

const hex = (v: string | undefined): string | undefined => (v && parseHex(v) ? v : undefined)

/**
 * The 3D scene colors for a theme: its own `scene` block when it has one, a light studio built from
 * its surfaces when it is light, and its accent for the selection outline. Undefined keeps the default
 * dark studio.
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
  set('selection', c.purple)
  set('liveLayer', c.cyan)
  return Object.keys(scene).length ? { scene } : undefined
}
