// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The 3D studio follows the theme. Each theme carries a scene block (derived from its colors unless
// the file sets it): a dark theme gets a dark studio, a light theme a light one. The theme layer
// publishes the colors as --scene-* variables; this reads them for the viewport.
import type { ViewportTheme } from '@slicerx/viewport'
import { COLORBLIND_THEME, type GlyphColors } from '@slicerx/viewport/palette'
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

const GLYPHS = {
  '--glyph-line': 'line', '--glyph-picked-line': 'pickedLine',
  '--glyph-node': 'node', '--glyph-picked-node': 'pickedNode', '--glyph-center': 'center',
  '--glyph-halo': 'halo', '--glyph-picked-edge': 'pickedEdge', '--glyph-picked-halo': 'pickedHalo',
} as const

/** The scene colors for the theme applied to the document, or undefined for the default studio. */
export function sceneThemeFromCss(root: HTMLElement = document.documentElement): ViewportTheme | undefined {
  const cs = getComputedStyle(root)
  const scene: Record<string, string> = {}
  for (const [name, key] of MAP) {
    const v = cs.getPropertyValue(name).trim()
    if (parseHex(v)) scene[key] = v
  }
  // Only an explicit edition accent replaces the existing scene selection color.
  const accent = root.style.getPropertyValue('--accent').trim()
  if (/^#[0-9a-fA-F]{6}$/.test(accent)) scene.selection = accent
  const glyphs: GlyphColors = {}
  for (const [name, key] of Object.entries(GLYPHS)) {
    const value = cs.getPropertyValue(name).trim()
    if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)) glyphs[key] = value
  }
  return Object.keys(scene).length || Object.keys(glyphs).length ? { scene, ...(Object.keys(glyphs).length ? { glyphs } : {}) } : undefined
}

/** The scene theme with the toolpath palette the person picked on top. */
export function viewportTheme(palette: 'standard' | 'colorblind', root: HTMLElement = document.documentElement): ViewportTheme | undefined {
  const base = sceneThemeFromCss(root)
  if (palette !== 'colorblind') return base
  return { ...base, features: COLORBLIND_THEME.features, heatRamp: COLORBLIND_THEME.heatRamp, scene: { ...base?.scene, ...COLORBLIND_THEME.scene } }
}
