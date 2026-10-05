// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The 3D studio follows the theme. Each theme carries a scene block (derived from its colors unless
// the file sets it): a dark theme gets a dark studio, a light theme a light one. The theme layer
// publishes the colors as --scene-* variables; this reads them for the viewport.
import type { ViewportTheme } from '@slicerx/viewport'
import { COLORBLIND_THEME } from '@slicerx/viewport/palette'
import { parseHex } from '@slicerx/ui/theme'

const MAP = [
  ['--scene-top', 'bgTop'],
  ['--scene-bottom', 'bgBottom'],
  ['--scene-glow', 'bgGlow'],
  ['--scene-plate', 'plateSide'],
  ['--scene-grid', 'floorGrid'],
  ['--scene-edge', 'edgeDark'],
  ['--scene-xray', 'edgeXray'],
  // the accent marks the selection, the bed outline and the guides; an edition's accent replaces the purple
  ['--purple', 'selection'],
  ['--cyan', 'liveLayer'],
] as const

/** The scene colors for the theme applied to the document, or undefined for the default studio. */
export function sceneThemeFromCss(root: HTMLElement = document.documentElement): ViewportTheme | undefined {
  const cs = getComputedStyle(root)
  const scene: Record<string, string> = {}
  for (const [name, key] of MAP) {
    const v = cs.getPropertyValue(name).trim()
    if (parseHex(v)) scene[key] = v
  }
  return Object.keys(scene).length ? { scene } : undefined
}

/** The scene theme with the toolpath palette the person picked on top. */
export function viewportTheme(palette: 'standard' | 'colorblind', root: HTMLElement = document.documentElement): ViewportTheme | undefined {
  const base = sceneThemeFromCss(root)
  if (palette !== 'colorblind') return base
  return { ...base, features: COLORBLIND_THEME.features, heatRamp: COLORBLIND_THEME.heatRamp, scene: { ...base?.scene, ...COLORBLIND_THEME.scene } }
}
