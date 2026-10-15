// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Viewport look: every knob that decides how the studio and the models are lit and graded, grouped by what owns it
// (backdrop, plate, lighting, materials, geometry cues, output). BASELINE_LOOK holds the values the viewport draws with
// when no look is set, so a look can always be reset, compared or saved against it.
//
// Units and color spaces:
// - Colors are sRGB hex strings, as a person picks them. They are turned into linear values once, where they enter the
//   renderer (three.js Color for lights, materials and edges; the grade pass decodes the backdrop).
// - Light intensities are in the viewport's own scale: the value times pi is the three.js (physical) intensity, so 1 is
//   a light that brings a white face square to it to full white before tone mapping.
// - Light directions point from the bed center toward the light, in three.js world axes (x right, y up, z toward the
//   front of the bed), in millimeters; about 380 mm long keeps the key's shadow camera in range. A camera-relative
//   fill or rim uses view axes instead and turns with the view; the key always stays in the room.
// - Lengths are millimeters at the bed; widths on screen are CSS pixels.
// - Shading is linear light, then one tone map (Khronos PBR Neutral) and one sRGB encode in the grade pass.

export type LookVec3 = [number, number, number]

export interface LookLight {
  /** Viewport units (times pi in three.js); 0 turns the light off. */
  intensity: number
  /** From the bed center toward the light, three.js world axes, mm. */
  direction: LookVec3
}

export interface ViewportLook {
  version: 1
  backdrop: {
    /** Vertical gradient top and bottom and the lift behind the plate, sRGB hex; null keeps the theme's color. */
    top: string | null
    bottom: string | null
    center: string | null
    /** How far the center lift reaches toward its color, 0 to 1. */
    centerStrength: number
    /** Corner darkening of the final picture, 0 to 1 (0.42 darkens the corners by about a tenth). */
    vignette: number
    /** Whether the vignette darkens the models too, or only the backdrop behind them. */
    vignetteOnModels: boolean
    /** Dither added at the 8-bit output, peak to peak, in 8-bit steps; 0 turns it off. */
    dither: number
    /** Triangular (two-sample) dither instead of a single uniform sample: no level is left undithered. */
    ditherTriangular: boolean
  }
  plate: {
    /** The bed outline and corner marks, sRGB hex; null uses the theme's selection color. */
    border: string | null
    /** Scales the soft glow around the outline, and the corner marks with it (down to 30 percent at 0); 1 is the shipped glow. */
    borderGlow: number
    /** Scales the 10 mm and 50 mm grid lines; 1 is the shipped grid. */
    grid: number
    /** Scales the faint fill inside the bed; 1 is the shipped fill. */
    fill: number
    /** Contact shadow under objects that touch the plate: darkness of the bake and the plane's opacity. */
    contactDarkness: number
    contactOpacity: number
  }
  lighting: {
    /** The key casts the only shadow map. */
    key: LookLight & { shadow: boolean }
    /** camera: the direction is in view axes (x right, y up, z toward the viewer) and turns with the view. */
    fill: LookLight & { camera: boolean }
    rim: LookLight & { camera: boolean }
    /** The room environment's light on every lit material (diffuse and reflections), 1 is the room as generated. */
    environment: number
    /** Linear gain before the tone map. */
    exposure: number
  }
  materials: {
    /**
     * Model's CAD body: one neutral color per studio kind (light or dark backdrop), sRGB hex, and its own share of the
     * room light (replaces lighting.environment on the CAD body only).
     */
    cad: { light: string; dark: string; roughness: number; specular: number; clearcoat: number; sheen: number; environment: number }
    /**
     * Basic-finish filament in the Slice tab's model view. Other finishes (matte, silk, PETG, translucent) keep their
     * own physical values. null keeps the shipped basic finish.
     */
    filament: { roughness: number; specular: number; clearcoat: number; sheen: number } | null
  }
  geometry: {
    /** Screen-space ambient occlusion reach in mm at the bed, and how strong it is, 0 to 1. */
    aoRadiusMm: number
    aoStrength: number
    /** Model's CAD feature edges: width in CSS pixels, opacity, and color per studio kind (null derives it). */
    edgeWidthPx: number
    edgeOpacity: number
    edgeLight: string | null
    edgeDark: string | null
    /** Model's CAD silhouette (outer outline and depth steps): strength 0 to 1, reach in CSS pixels. */
    silhouette: number
    silhouetteWidthPx: number
  }
}

/** What the viewport draws when no look is set. Changing these values changes the shipped viewport. */
export const BASELINE_LOOK: ViewportLook = {
  version: 1,
  backdrop: { top: null, bottom: null, center: null, centerStrength: 0.8, vignette: 0.42, vignetteOnModels: true, dither: 1, ditherTriangular: false },
  plate: { border: null, borderGlow: 1, grid: 1, fill: 1, contactDarkness: 2.1, contactOpacity: 0.95 },
  lighting: {
    key: { intensity: 1.6, direction: [-150, 300, 190], shadow: true },
    fill: { intensity: 0.35, direction: [220, 80, 200], camera: false },
    rim: { intensity: 0.5, direction: [180, 140, -260], camera: false },
    environment: 1,
    exposure: 1,
  },
  materials: {
    cad: { light: '#7b7e83', dark: '#6f757e', roughness: 0.5, specular: 1, clearcoat: 0.2, sheen: 0, environment: 1 },
    filament: null,
  },
  geometry: { aoRadiusMm: 6, aoStrength: 0.9, edgeWidthPx: 1.5, edgeOpacity: 0.95, edgeLight: '#121318', edgeDark: '#08090c', silhouette: 0.95, silhouetteWidthPx: 1.5 },
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object | null ? DeepPartial<NonNullable<T[K]>> | null : T[K] }
export type ViewportLookPatch = DeepPartial<Omit<ViewportLook, 'version'>>

const HEX = /^#[0-9a-fA-F]{6}$/
/** Colors a look may leave null, so the theme decides them. */
const NULLABLE = new Set(['backdrop.top', 'backdrop.bottom', 'backdrop.center', 'plate.border', 'geometry.edgeLight', 'geometry.edgeDark'])

/** A look with a patch on top: objects merge key by key, arrays and colors replace. */
export function mergeLook(base: ViewportLook, patch: ViewportLookPatch): ViewportLook {
  const out = structuredClone(base) as unknown as Record<string, unknown>
  const merge = (dst: Record<string, unknown>, src: Record<string, unknown>): void => {
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined) continue
      const d = dst[k]
      if (v && typeof v === 'object' && !Array.isArray(v) && d && typeof d === 'object' && !Array.isArray(d)) merge(d as Record<string, unknown>, v as Record<string, unknown>)
      else dst[k] = Array.isArray(v) ? [...v] : v && typeof v === 'object' ? structuredClone(v) : v
    }
  }
  merge(out, patch as Record<string, unknown>)
  return out as unknown as ViewportLook
}

/** Problems in a look, as readable strings; an empty list means the viewport can draw it. */
export function lookProblems(look: ViewportLook): string[] {
  const out: string[] = []
  if (look.version !== 1) out.push(`version must be 1, got ${String(look.version)}`)
  const walk = (path: string, base: unknown, v: unknown): void => {
    if (base === null || typeof base === 'string') {
      const nullable = base === null || NULLABLE.has(path)
      if (v === null && nullable) return
      if (typeof v !== 'string' || !HEX.test(v)) out.push(`${path} must be a #rrggbb color${nullable ? ' or null' : ''}`)
      return
    }
    if (typeof base === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < -1000 || v > 1000) out.push(`${path} must be a finite number`)
      return
    }
    if (typeof base === 'boolean') {
      if (typeof v !== 'boolean') out.push(`${path} must be true or false`)
      return
    }
    if (Array.isArray(base)) {
      if (!Array.isArray(v) || v.length !== base.length || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) out.push(`${path} must be ${base.length} numbers`)
      return
    }
    if (base && typeof base === 'object') {
      if (!v || typeof v !== 'object') {
        if (v === null && path === 'materials.filament') return
        out.push(`${path} must be an object`)
        return
      }
      for (const k of Object.keys(base)) walk(path ? `${path}.${k}` : k, (base as Record<string, unknown>)[k], (v as Record<string, unknown>)[k])
    }
  }
  const shape = mergeLook(BASELINE_LOOK, { materials: { filament: { roughness: 0, specular: 0, clearcoat: 0, sheen: 0 } } })
  for (const k of ['backdrop', 'plate', 'lighting', 'materials', 'geometry'] as const) walk(k, shape[k], look[k])
  for (const [p, v] of [
    ['geometry.aoStrength', look.geometry?.aoStrength],
    ['geometry.silhouette', look.geometry?.silhouette],
    ['backdrop.vignette', look.backdrop?.vignette],
    ['backdrop.centerStrength', look.backdrop?.centerStrength],
  ] as const)
    if (typeof v === 'number' && (v < 0 || v > 1)) out.push(`${p} must be between 0 and 1`)
  return out
}

/**
 * Studio satin shading, shared by both studio presets: a high key that stays in the room, a soft fill that turns with
 * the view, the room light cut to what the faces need, satin materials, thin soft edges and light occlusion. White
 * parts keep their curvature under the tone map's shoulder, black parts stay black with their edges readable, and the
 * Slice tab's basic filament keeps its hue.
 */
const STUDIO_SATIN: Pick<ViewportLook, 'lighting' | 'materials' | 'geometry'> = {
  lighting: {
    key: { intensity: 0.7, direction: [-190, 330, -20], shadow: true },
    fill: { intensity: 0.2, direction: [-0.3, 0.3, 0.9], camera: true },
    rim: { intensity: 0.5, direction: [160, 150, -280], camera: false },
    environment: 0.35,
    exposure: 1,
  },
  materials: {
    cad: { light: '#b9bdc2', dark: '#b9bdc2', roughness: 0.62, specular: 0.55, clearcoat: 0, sheen: 0, environment: 0.15 },
    filament: { roughness: 0.62, specular: 1, clearcoat: 0, sheen: 0.7 },
  },
  geometry: { aoRadiusMm: 6, aoStrength: 0.55, edgeWidthPx: 1, edgeOpacity: 0.8, edgeLight: '#252b31', edgeDark: '#252b31', silhouette: 0.6, silhouetteWidthPx: 1 },
}

/** How strongly the bed outline glows in both studio presets (1 is the shipped glow). */
export const STUDIO_PLATE_GLOW = 0.2

/** Dark precision: Studio satin on a navy slate studio. The vignette darkens only the backdrop. */
export const DARK_PRECISION_LOOK: ViewportLook = {
  version: 1,
  backdrop: { top: '#2a2e3a', bottom: '#1b1e26', center: '#333847', centerStrength: 0.55, vignette: 0.22, vignetteOnModels: false, dither: 2, ditherTriangular: true },
  plate: { border: null, borderGlow: STUDIO_PLATE_GLOW, grid: 0.7, fill: 0.8, contactDarkness: 1.8, contactOpacity: 0.75 },
  ...structuredClone(STUDIO_SATIN),
}

/** Light studio: Studio satin on a light gray studio a touch darker than the light theme's own, so white parts keep their outline. */
export const LIGHT_STUDIO_LOOK: ViewportLook = {
  version: 1,
  backdrop: { top: '#e3e6ea', bottom: '#c3c8cf', center: '#eceef1', centerStrength: 0.5, vignette: 0.12, vignetteOnModels: false, dither: 2, ditherTriangular: true },
  plate: { border: null, borderGlow: STUDIO_PLATE_GLOW, grid: 0.8, fill: 0.8, contactDarkness: 1.8, contactOpacity: 0.7 },
  ...structuredClone(STUDIO_SATIN),
}

/** The named looks a host can pick: one per studio kind. */
export const LOOK_PRESETS = { 'dark-precision': DARK_PRECISION_LOOK, 'light-studio': LIGHT_STUDIO_LOOK } as const
export type LookPresetId = keyof typeof LOOK_PRESETS

/**
 * The preset for a theme: Dark precision on a dark theme, Light studio on a light one. With `themeBackdrop` the
 * backdrop colors and the bed outline color are left to the theme (a rebranded theme keeps its own studio colors),
 * and everything else in the preset still applies.
 */
export function lookForScheme(scheme: 'dark' | 'light', o: { themeBackdrop?: boolean } = {}): { preset: LookPresetId; look: ViewportLook } {
  const preset: LookPresetId = scheme === 'light' ? 'light-studio' : 'dark-precision'
  const base = LOOK_PRESETS[preset]
  const look = o.themeBackdrop ? mergeLook(base, { backdrop: { top: null, bottom: null, center: null }, plate: { border: null } }) : structuredClone(base)
  return { preset, look }
}
