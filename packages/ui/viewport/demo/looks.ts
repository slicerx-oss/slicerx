// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Look lab candidates (look.html). A look is two independent halves: the shading (lights, materials, edges, occlusion,
// exposure) and the studio (backdrop and plate). The lab composes any shading with any studio, so a backdrop never
// decides how a model is judged. Everything here goes through the viewport's setLook; nothing changes the shipped look.
import { BASELINE_LOOK, DARK_PRECISION_LOOK as A, LIGHT_STUDIO_LOOK as C, mergeLook, type ViewportLook, type ViewportLookPatch } from '../src/index'

export type ShadeId = 'base' | 'new'
export type StudioId = 'dark' | 'light' | 'precision' | 'graphite' | 'lightnew'

/** The shading half of a look: lighting, materials and geometry cues. */
export type Shade = Pick<ViewportLook, 'lighting' | 'materials' | 'geometry'>
/** The studio half: backdrop and plate, plus which theme (dark or light app theme) it sits on. */
export interface Studio {
  theme: 'dark' | 'light'
  name: string
  backdrop: ViewportLook['backdrop']
  plate: ViewportLook['plate']
}

const B = BASELINE_LOOK

export const SHADES: Record<ShadeId, { name: string; line: string; shade: Shade }> = {
  base: { name: 'Shipped shading', line: 'What ships today.', shade: { lighting: B.lighting, materials: B.materials, geometry: B.geometry } },
  new: {
    name: 'Studio satin',
    line: 'A high key that stays in the room, a soft fill that turns with the view, the room light cut to what the faces need, satin materials, thin soft edges, light occlusion.',
    shade: { lighting: A.lighting, materials: A.materials, geometry: A.geometry },
  },
}

export const STUDIOS: Record<StudioId, Studio> = {
  dark: { theme: 'dark', name: 'Dark Studio (shipped)', backdrop: B.backdrop, plate: B.plate },
  light: { theme: 'light', name: 'Light Studio (shipped)', backdrop: B.backdrop, plate: B.plate },
  precision: {
    theme: 'dark',
    name: 'Dark Precision',
    backdrop: A.backdrop,
    plate: A.plate,
  },
  graphite: {
    theme: 'dark',
    // kept in the lab only: not a preset the app ships
    name: 'Neutral Graphite',
    backdrop: { top: '#2f3033', bottom: '#1d1e20', center: '#37383c', centerStrength: 0.55, vignette: 0.22, vignetteOnModels: false, dither: 2, ditherTriangular: true },
    plate: { border: '#8e8a9c', borderGlow: 0.2, grid: 0.7, fill: 0.8, contactDarkness: 1.8, contactOpacity: 0.75 },
  },
  lightnew: {
    theme: 'light',
    name: 'Light Studio (refined)',
    backdrop: C.backdrop,
    plate: C.plate,
  },
}

/** The brief's candidates: A, B and C share one shading; D (and Dl, its light studio) is the shipped look. */
export const VARIANTS = {
  A: { shade: 'new', studio: 'precision' },
  B: { shade: 'new', studio: 'graphite' },
  C: { shade: 'new', studio: 'lightnew' },
  D: { shade: 'base', studio: 'dark' },
  Dl: { shade: 'base', studio: 'light' },
} as const satisfies Record<string, { shade: ShadeId; studio: StudioId }>

/** A full look from a shading and a studio, with an optional patch on top (for tuning). */
export function compose(shade: ShadeId, studio: StudioId, patch: ViewportLookPatch = {}): ViewportLook {
  const s = SHADES[shade].shade
  const st = STUDIOS[studio]
  return mergeLook({ version: 1, backdrop: st.backdrop, plate: st.plate, lighting: s.lighting, materials: s.materials, geometry: s.geometry }, patch)
}
