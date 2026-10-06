// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The printer's `bed_exclude_area` as polygons for the viewport. Profiles store it as a list of points, either
// as number pairs (resolved profiles) or as "XxY" text (OrcaSlicer's own form, and what a person types in
// printer settings). Up to four points are one polygon; a longer list is one per four points, as Orca reads
// it (PartPlate::calc_bounding_boxes), which is how the Qidi X-Plus 4 lists its two corner strips. A list or
// group without area, such as the usual [[0, 0]], means none.

type Pt = [number, number]

function point(v: unknown): Pt | null {
  if (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n))) return [v[0] as number, v[1] as number]
  if (typeof v === 'string') {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*x\s*(-?\d+(?:\.\d+)?)\s*$/i.exec(v)
    if (m) return [Number(m[1]), Number(m[2])]
  }
  return null
}

function area(p: readonly Pt[]): number {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i] as Pt
    const [x1, y1] = p[(i + 1) % p.length] as Pt
    a += x0 * y1 - x1 * y0
  }
  return Math.abs(a) / 2
}

/** Polygons to hatch on the bed; empty when the printer has none. */
export function excludedPolygons(value: unknown): Pt[][] {
  const items = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : []
  const pts = items.map(point).filter((p): p is Pt => p !== null)
  return groups(pts).filter((g) => g.length >= 3 && area(g) > 0.01)
}

/** One polygon of up to four points, else one per four points with a shorter tail dropped. */
function groups<T>(pts: readonly T[]): T[][] {
  if (pts.length <= 4) return [[...pts]]
  const out: T[][] = []
  for (let i = 0; i + 4 <= pts.length; i += 4) out.push(pts.slice(i, i + 4))
  return out
}
