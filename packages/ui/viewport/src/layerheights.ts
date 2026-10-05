// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// sleipnir heights as data: the tops of every layer (the shape core's
// options.layerTopsMm takes), checks on them, and the lookup the Prepare
// shaders repeat on the GPU. Pure, so the shader math is unit tested here.

/** Problems in a list of layer tops, as readable strings. Empty means usable. */
export function layerTopsProblems(tops: ArrayLike<number>): string[] {
  const out: string[] = []
  if (tops.length === 0) out.push('layer tops are empty')
  let prev = 0
  for (let i = 0; i < tops.length; i++) {
    const t = tops[i] ?? 0
    if (!Number.isFinite(t) || t <= prev) {
      out.push(`layer ${i} top ${t} is not above the previous top ${prev}`)
      break
    }
    prev = t
  }
  return out
}

/** Thickness of each layer, mm. The first layer starts at the bed. */
export function layerThicknesses(tops: ArrayLike<number>): Float32Array {
  const out = new Float32Array(tops.length)
  let prev = 0
  for (let i = 0; i < tops.length; i++) {
    const t = tops[i] ?? 0
    out[i] = t - prev
    prev = t
  }
  return out
}

export interface LayerHeightStats {
  layers: number
  minMm: number
  maxMm: number
  /** Height that the most layers have, rounded to 0.01 mm. */
  commonMm: number
}

export function layerHeightStats(tops: ArrayLike<number>): LayerHeightStats {
  const th = layerThicknesses(tops)
  let mn = Infinity
  let mx = 0
  const counts = new Map<number, number>()
  for (const t of th) {
    mn = Math.min(mn, t)
    mx = Math.max(mx, t)
    const k = Math.round(t * 100) / 100
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  let common = 0
  let best = 0
  for (const [k, n] of counts) {
    if (n > best) {
      best = n
      common = k
    }
  }
  return { layers: th.length, minMm: Number.isFinite(mn) ? mn : 0, maxMm: mx, commonMm: common }
}

/**
 * Continuous layer coordinate at height `z`: the layer index plus how far
 * through that layer z is. Below the bed it is 0; above the last top it stays
 * at the last layer's end. This mirrors sxLayerAt in materials.ts.
 */
export function layerCoordAt(tops: ArrayLike<number>, z: number): { coord: number; thicknessMm: number } {
  const n = tops.length
  if (n === 0) return { coord: 0, thicknessMm: 0 }
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((tops[mid] ?? 0) < z) lo = mid + 1
    else hi = mid
  }
  const t1 = tops[lo] ?? 0
  const t0 = lo > 0 ? (tops[lo - 1] ?? 0) : 0
  const th = Math.max(t1 - t0, 1e-4)
  return { coord: lo + Math.min(1, Math.max(0, (z - t0) / th)), thicknessMm: t1 - t0 }
}
