// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// sleipnir height planning from mesh slope, used when the host has no
// geometry service: thin where shallow slopes would stair step, thick on
// vertical walls.
import type { MeshPart } from '@slicerx/contracts'
import { round } from '../common'
import { eachTri, partsBox } from '../orientation_search/geometry'

export type LayerQuality = 'fine' | 'standard' | 'draft'

/** Largest stair step (cusp height) allowed on a slope, mm for a 0.4 mm nozzle. */
export const CUSP_MM: Record<LayerQuality, number> = { fine: 0.05, standard: 0.1, draft: 0.16 }

export interface LayerSegment {
  fromMm: number
  toMm: number
  heightMm: number
  /** Steepest shallow slope in the segment, degrees from horizontal; null when only vertical walls or flats. */
  slopeDeg: number | null
}

export interface LayerPlan {
  segments: LayerSegment[]
  layers: number
  minMm: number
  maxMm: number
  heightMm: number
}

/**
 * The plan, as pure code. The part is cut into bands (0.5 mm, or more for tall
 * parts so there are at most 400). In each band the most horizontal sloped
 * face that is not flat (normal Z between 0.05 and 0.99) sets the layer
 * height: cusp limit over that normal Z, clamped to the allowed heights and
 * floored to the height grid. Flat tops and bottoms do not need thin layers.
 * Neighboring bands with the same height are merged.
 */
export function layerPlan(parts: MeshPart[], heights: number[], quality: LayerQuality, nozzle: number): LayerPlan {
  const sorted = [...heights].sort((a, b) => a - b)
  const minH = sorted[0] ?? 0.1
  const maxH = sorted[sorted.length - 1] ?? 0.3
  const box = partsBox(parts)
  const z0 = box.min[2]
  const H = box.size[2]
  if (H <= 0) return { segments: [], layers: 0, minMm: minH, maxMm: maxH, heightMm: 0 }
  const band = Math.max(0.5, H / 400)
  const n = Math.max(1, Math.ceil(H / band))
  const steep = new Float64Array(n)
  eachTri(parts, (t) => {
    const nz = Math.abs(t.n[2])
    if (nz <= 0.05 || nz >= 0.99) return
    const lo = Math.min(t.a[2], t.b[2], t.c[2]) - z0
    const hi = Math.max(t.a[2], t.b[2], t.c[2]) - z0
    const b0 = Math.max(0, Math.floor(lo / band))
    const b1 = Math.min(n - 1, Math.floor(hi / band))
    for (let b = b0; b <= b1; b++) if (nz > (steep[b] ?? 0)) steep[b] = nz
  })
  const cusp = CUSP_MM[quality] * (nozzle / 0.4)
  const pick = (nz: number): number => {
    if (nz <= 0) return maxH
    const want = cusp / nz
    const fit = sorted.filter((h) => h <= want + 1e-9)
    return fit.length ? (fit[fit.length - 1] ?? minH) : minH
  }
  const segments: LayerSegment[] = []
  for (let b = 0; b < n; b++) {
    const nz = steep[b] ?? 0
    const h = pick(nz)
    const from = round(b * band, 2)
    const to = round(Math.min(H, (b + 1) * band), 2)
    const slope = nz > 0 ? round((Math.acos(nz) * 180) / Math.PI, 0) : null
    const last = segments[segments.length - 1]
    if (last && Math.abs(last.heightMm - h) < 1e-9) {
      last.toMm = to
      if (slope !== null && (last.slopeDeg === null || slope < last.slopeDeg)) last.slopeDeg = slope
    } else segments.push({ fromMm: from, toMm: to, heightMm: h, slopeDeg: slope })
  }
  const layers = Math.round(segments.reduce((s, x) => s + (x.toMm - x.fromMm) / x.heightMm, 0))
  return { segments, layers, minMm: minH, maxMm: maxH, heightMm: round(H, 2) }
}

/** Layer tops for the core's `layerTopsMm`, from a plan. The first layer keeps its own height. */
export function planTops(plan: LayerPlan, firstLayerMm: number): number[] {
  const tops: number[] = []
  let z = Math.min(firstLayerMm, plan.heightMm)
  tops.push(round(z, 3))
  for (const seg of plan.segments) {
    while (z + seg.heightMm <= seg.toMm + 1e-6 && z + 1e-6 < plan.heightMm) {
      z = round(z + seg.heightMm, 3)
      tops.push(z)
    }
  }
  const last = tops[tops.length - 1] ?? 0
  if (last < plan.heightMm - 1e-6) tops.push(round(plan.heightMm, 3))
  return tops
}
