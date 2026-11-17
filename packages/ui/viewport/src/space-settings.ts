// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The 3D mouse settings a person tunes, their defaults and their check. Apart from the report parser and the motion
// mapping (spacemouse.ts), so the app can hold and save the settings without loading the device code.

/** The five camera moves a person can tune. Roll (RY) is not used: the camera keeps the plate's up direction. */
export type SpaceAxis = 'panX' | 'panY' | 'zoom' | 'tilt' | 'spin'
export const SPACE_AXES: readonly SpaceAxis[] = ['panX', 'panY', 'zoom', 'tilt', 'spin']

export interface SpaceMouseSettings {
  enabled: boolean
  /** Speed multiplier, SPACE_SENSITIVITY.min to max. */
  sensitivity: number
  /** Axes whose direction is flipped. */
  invert: Readonly<Record<SpaceAxis, boolean>>
  /** Only the strongest axis moves the view at a time. */
  dominantAxis: boolean
}

export const SPACE_SENSITIVITY = { min: 0.25, max: 4, step: 0.05 } as const

export const DEFAULT_SPACE_MOUSE: Readonly<SpaceMouseSettings> = Object.freeze({
  enabled: false,
  sensitivity: 1,
  invert: Object.freeze({ panX: false, panY: false, zoom: false, tilt: false, spin: false }),
  dominantAxis: false,
})

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Settings read back from storage or an outside caller: each field checked on its own, a bad one falls back to its default. */
export function normalizeSpaceMouse(v: unknown): SpaceMouseSettings {
  const r = isRec(v) ? v : {}
  const d = DEFAULT_SPACE_MOUSE
  const inv = isRec(r['invert']) ? r['invert'] : {}
  const s = r['sensitivity']
  const sensitivity = typeof s === 'number' && Number.isFinite(s) ? Math.min(SPACE_SENSITIVITY.max, Math.max(SPACE_SENSITIVITY.min, s)) : d.sensitivity
  const invert = Object.fromEntries(SPACE_AXES.map((a) => [a, typeof inv[a] === 'boolean' ? inv[a] : d.invert[a]])) as Record<SpaceAxis, boolean>
  return {
    enabled: typeof r['enabled'] === 'boolean' ? r['enabled'] : d.enabled,
    sensitivity,
    invert,
    dominantAxis: typeof r['dominantAxis'] === 'boolean' ? r['dominantAxis'] : d.dominantAxis,
  }
}
