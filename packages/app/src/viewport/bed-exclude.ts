// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The printer's `bed_exclude_area` as polygons for the viewport. Profiles store it as a list of points, one
// polygon, either as number pairs (resolved profiles) or as "XxY" text (OrcaSlicer's own form, and what a
// person types in printer settings). A list without area, such as the usual [[0, 0]], means none.

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
  return pts.length >= 3 && area(pts) > 0.01 ? [pts] : []
}
