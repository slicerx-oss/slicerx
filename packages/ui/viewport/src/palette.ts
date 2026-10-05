// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Colors the renderer draws with. They follow the Nocturne tokens in
// packages/ui/tokens.css; GL needs them as numbers, so they are listed here.
// Apps should build legends from these exports so swatches match the scene.
import { FEATURE, type FeatureId } from '@slicerx/contracts'

export interface FeatureStyle {
  id: FeatureId
  label: string
  color: string
}

/**
 * Preview colors by SXPV feature id. None sits on a meaning color of the UI
 * (red for errors, cyan for selection and info) or on pink beside purple, so a
 * toolpath never reads as a status.
 */
export const FEATURE_COLORS: readonly FeatureStyle[] = [
  { id: FEATURE.outerWall, label: 'Outer wall', color: '#f0b429' },
  { id: FEATURE.innerWall, label: 'Inner wall', color: '#bd93f9' },
  { id: FEATURE.overhangWall, label: 'Overhang wall', color: '#4f7cff' },
  { id: FEATURE.topSurface, label: 'Top surface', color: '#ff8a3d' },
  { id: FEATURE.bottomSurface, label: 'Bottom surface', color: '#8e9bd4' },
  { id: FEATURE.internalSolid, label: 'Internal solid infill', color: '#9c5a3c' },
  { id: FEATURE.sparseInfill, label: 'Sparse infill', color: '#d6c48a' },
  { id: FEATURE.bridge, label: 'Bridge', color: '#5aa9e6' },
  { id: FEATURE.support, label: 'Support', color: '#50fa7b' },
  { id: FEATURE.supportInterface, label: 'Support interface', color: '#2f9e5a' },
  { id: FEATURE.brimSkirt, label: 'Brim and skirt', color: '#9ad14b' },
  { id: FEATURE.ironing, label: 'Ironing', color: '#f1fa8c' },
  { id: FEATURE.gapFill, label: 'Gap fill', color: '#f8f8f2' },
  { id: FEATURE.primeTower, label: 'Prime tower', color: '#9aa4c1' },
  { id: FEATURE.custom, label: 'Custom', color: '#8f9abb' },
]

/**
 * A palette for color vision deficiency, built on the Okabe and Ito set. Features differ in hue along the
 * blue to orange axis and in lightness, never by red against green. The overhang heat map runs from gray
 * through yellow to vermillion, and speed, flow and layer time run blue to yellow to orange to vermillion.
 */
export const COLORBLIND_THEME: Required<Pick<ViewportTheme, 'features' | 'heatRamp'>> & { scene: Pick<SceneColors, 'overhangRed' | 'overhangAmber'> } = {
  features: {
    [FEATURE.outerWall]: '#e69f00',
    [FEATURE.innerWall]: '#cc79a7',
    [FEATURE.overhangWall]: '#56b4e9',
    [FEATURE.topSurface]: '#d55e00',
    [FEATURE.bottomSurface]: '#c8cbe0',
    [FEATURE.internalSolid]: '#7a4a1e',
    [FEATURE.sparseInfill]: '#f0e442',
    [FEATURE.bridge]: '#0072b2',
    [FEATURE.support]: '#009e73',
    [FEATURE.supportInterface]: '#004d3c',
    [FEATURE.brimSkirt]: '#bdbdbd',
    [FEATURE.ironing]: '#fff7b3',
    [FEATURE.gapFill]: '#ffffff',
    [FEATURE.primeTower]: '#5f6b8a',
    [FEATURE.custom]: '#9b8cff',
  },
  heatRamp: ['#2f6fe0', '#56b4e9', '#f0e442', '#e69f00', '#d55e00'],
  scene: { overhangRed: '#d55e00', overhangAmber: '#f0e442' },
}

/** Ramp for speed, flow and layer time, low to high. */
export const HEAT_RAMP: readonly string[] = ['#4f6bed', '#8be9fd', '#f1fa8c', '#ffb86c', '#ff5555']

/** Default filament colors when the app has not called setToolColors. */
export const DEFAULT_TOOL_COLORS: readonly string[] = ['#f7d959', '#fec600', '#ebebe6', '#1d1d21', '#ff9016', '#de4343', '#56b7e6', '#61c680']

export const SCENE = {
  bgTop: '#2f3241',
  bgBottom: '#20222b',
  bgGlow: '#3c3f50',
  selection: '#bd93f9',
  selectionHidden: '#6a58a0',
  liveLayer: '#8be9fd',
  overhangRed: '#ff4b5c',
  overhangAmber: '#ffb86c',
  clay: '#cbc4b8',
  overhangBase: '#767c98',
  plateSide: '#3c3f50',
  floorGrid: '#9aa4c1',
  edgeDark: '#16171e',
  edgeXray: '#c9d2ff',
  xrayTint: '#a8ecff',
  travel: '#8be9fd',
  retraction: '#f8f8f2',
  seam: '#facc15',
  lift: '#38bdf8',
  wipe: '#c4b5fd',
  toolChange: '#f472b6',
  pause: '#fb923c',
} as const

export type SceneColors = Record<keyof typeof SCENE, string>

/**
 * Colors of the 3D scene an integrator can change. Every field is optional and
 * falls back to the SlicerX default. Colors are `#rrggbb`. Meaning colors
 * (selection, live layer, overhang red and amber) are yours to change, but keep
 * them apart from the toolpath colors so a color never reads as a status.
 */
export interface ViewportTheme {
  /** Background gradient, selection outline, bed, overhang heat map, travel and live layer colors. */
  scene?: Partial<SceneColors>
  /** Toolpath color per SXPV feature id. */
  features?: Partial<Record<FeatureId, string>>
  /** Ramp for speed, flow and layer time, low to high; two to eight stops. */
  heatRamp?: readonly string[]
  /** Filament colors used until the app calls setToolColors. */
  toolColors?: readonly string[]
}

export interface ResolvedTheme {
  scene: SceneColors
  /** In FEATURE_COLORS order. */
  featureColors: string[]
  heatRamp: readonly string[]
  toolColors: readonly string[]
}

const HEX = /^#[0-9a-fA-F]{6}$/

/** Problems in a theme, as readable strings. An empty list means the theme is usable. */
export function themeProblems(theme: ViewportTheme | undefined): string[] {
  const out: string[] = []
  if (!theme) return out
  const check = (where: string, v: unknown): void => {
    if (typeof v !== 'string' || !HEX.test(v)) out.push(`${where} must be a #rrggbb color, got ${String(v)}`)
  }
  const knownScene = new Set<string>(Object.keys(SCENE))
  for (const [k, v] of Object.entries(theme.scene ?? {})) {
    if (!knownScene.has(k)) out.push(`scene.${k} is not a scene color`)
    else if (v !== undefined) check(`scene.${k}`, v)
  }
  const knownFeature = new Set<number>(FEATURE_COLORS.map((f) => f.id))
  for (const [k, v] of Object.entries(theme.features ?? {})) {
    if (!knownFeature.has(Number(k))) out.push(`features.${k} is not a feature id`)
    else if (v !== undefined) check(`features.${k}`, v)
  }
  if (theme.heatRamp) {
    if (theme.heatRamp.length < 2 || theme.heatRamp.length > 8) out.push('heatRamp needs two to eight colors')
    theme.heatRamp.forEach((c, i) => check(`heatRamp[${i}]`, c))
  }
  if (theme.toolColors) theme.toolColors.forEach((c, i) => check(`toolColors[${i}]`, c))
  return out
}

/** Merges a theme onto the defaults. Throws if `themeProblems` is not empty. */
export function resolveTheme(theme?: ViewportTheme): ResolvedTheme {
  const problems = themeProblems(theme)
  if (problems.length) throw new Error(`Invalid viewport theme: ${problems.join('; ')}`)
  const scene = { ...SCENE } as SceneColors
  for (const [k, v] of Object.entries(theme?.scene ?? {})) if (v !== undefined) scene[k as keyof SceneColors] = v
  // the hidden outline is the selection sunk halfway into the backdrop, so a new accent never leaves the old one behind
  if (theme?.scene?.selection && !theme.scene.selectionHidden) scene.selectionHidden = mixHex(scene.selection, scene.bgBottom, 0.5)
  return {
    scene,
    featureColors: FEATURE_COLORS.map((f) => theme?.features?.[f.id] ?? f.color),
    heatRamp: theme?.heatRamp ?? HEAT_RAMP,
    toolColors: theme?.toolColors && theme.toolColors.length ? theme.toolColors : DEFAULT_TOOL_COLORS,
  }
}

/** `a` moved toward `b` by `t` (0 to 1), as #rrggbb. */
export function mixHex(a: string, b: string, t: number): string {
  const x = hexToRgb(a)
  const y = hexToRgb(b)
  return `#${x.map((v, i) => Math.round(v + ((y[i] as number) - v) * t).toString(16).padStart(2, '0')).join('')}`
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1, 7), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function srgbToLinear(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

/** Keeps pure black and white inside a range real filament reaches, so shading still reads. */
export function displayHex(hex: string): string {
  const [r, g, b] = hexToRgb(hex)
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
  if (l < 26) return '#1d1d21'
  if (l > 240) return '#ebebe6'
  return hex
}
