// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// sleipnir, the automatic variable layer height: the window its layer heights may use. The window
// is a share of the nozzle diameter (at least a quarter, at most three quarters) unless a material's
// research says otherwise. Each mode has its own band inside that window: Quality 0.2 to 0.5 and
// Strength 0.3 to 0.5 of the nozzle, intersected with the material's window for the mode, and never
// above 0.75. src/smart_layer.rs does the same.
import type { SmartLayerMode } from '@slicerx/contracts/settings'
import type { MaterialKnowledge } from './knowledge'

type WithResearch = Pick<MaterialKnowledge, 'smartLayer' | 'layerBand'>
type Mode = 'quality' | 'strength'

export const SMART_LAYER_MIN_RATIO = 0.25
export const SMART_LAYER_MAX_RATIO = 0.75
/** The share of the nozzle each mode may use, before the material narrows it. */
export const SMART_LAYER_MODE_BANDS: Record<Mode, { min: number; max: number }> = {
  quality: { min: 0.2, max: 0.5 },
  strength: { min: 0.3, max: 0.5 },
}
/** Layer heights move in steps of this many millimeters. */
export const LAYER_STEP = 0.02

const snap = (v: number): number => Math.round(v * 1e9) / 1e9

export interface SmartLayerLimits {
  minRatio: number
  maxRatio: number
  /** The research behind a non default window, when there is one. */
  note?: string
  src: string[]
}

/**
 * The share of the nozzle sleipnir may use for this material: the material's safe layer height band
 * (never above 75 percent) when the knowledge base has one, unless sleipnir research says otherwise.
 * With a mode, the mode's band is intersected with that window (the material's own window for the mode
 * when its research gives one); when the two do not overlap the material's window wins.
 */
export function smartLayerLimits(material?: WithResearch, mode?: Mode): SmartLayerLimits {
  const r = material?.smartLayer
  const band = material?.layerBand
  const bandSrc = band ? band.src : []
  const m = mode ? r?.modes?.[mode] : undefined
  const matMin = m?.minRatio ?? r?.minRatio ?? band?.min
  const matMax = m?.maxRatio ?? r?.maxRatio ?? (band?.max !== undefined ? Math.min(band.max, SMART_LAYER_MAX_RATIO) : undefined)
  let minRatio = matMin ?? SMART_LAYER_MIN_RATIO
  let maxRatio = matMax ?? SMART_LAYER_MAX_RATIO
  if (mode) {
    // Without material data the mode band stands alone.
    const b = SMART_LAYER_MODE_BANDS[mode]
    const lo = Math.max(b.min, matMin ?? 0)
    const hi = Math.min(b.max, matMax ?? SMART_LAYER_MAX_RATIO, SMART_LAYER_MAX_RATIO)
    if (lo <= hi) {
      minRatio = lo
      maxRatio = hi
    } else {
      minRatio = matMin ?? b.min
      maxRatio = matMax ?? b.max
    }
  }
  return {
    minRatio,
    maxRatio,
    ...(r?.note ? { note: r.note } : {}),
    src: r ? r.src : bandSrc,
  }
}

/** The thinnest and thickest layer the window allows on a nozzle, on the layer step grid. */
export function smartLayerWindow(nozzleDiameter: number, material?: WithResearch, mode?: Mode): { min: number; max: number } {
  const l = smartLayerLimits(material, mode)
  return {
    min: snap(Math.ceil(snap((l.minRatio * nozzleDiameter) / LAYER_STEP) - 1e-9) * LAYER_STEP),
    max: snap(Math.floor(snap((l.maxRatio * nozzleDiameter) / LAYER_STEP) + 1e-9) * LAYER_STEP),
  }
}

/**
 * Bounds for a nozzle. With `layerHeight` (what the Detail slider gives) the bounds sit around it,
 * at about half to one and a half times, inside the window; without it they are the whole window.
 * The thickest layer is always at least one step above the thinnest.
 */
export function smartLayerBounds(opts: { nozzleDiameter: number; layerHeight?: number; material?: WithResearch; mode?: Mode }): { min: number; max: number } {
  const w = smartLayerWindow(opts.nozzleDiameter, opts.material, opts.mode)
  const lh = opts.layerHeight
  const step = (v: number): number => snap(Math.round(v / LAYER_STEP) * LAYER_STEP)
  const min = lh === undefined ? w.min : Math.max(w.min, step(0.5 * lh))
  const max = Math.max(lh === undefined ? w.max : Math.min(w.max, step(1.5 * lh)), snap(min + LAYER_STEP))
  return { min: snap(min), max: snap(max) }
}

export function isSmartLayerOn(mode: unknown): mode is Exclude<SmartLayerMode, 'off'> {
  return mode === 'quality' || mode === 'strength'
}
