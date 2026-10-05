// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plate thumbnail: the bed seen from above with the outline each object casts on it, in its filament color.
// Drawn as SVG from the meshes the plate already holds, so every plate has one without a render, and an
// outline is computed once per object placement.
import type { Bed } from '@slicerx/contracts'
import type { PlateEntry } from '../../state/store'
import { brandAccent } from '../../edition'

/** Points read per object at most; the outline of a sample this size is within a fraction of a millimeter of the full one. */
const SAMPLE = 8000

export interface Footprint {
  /** SVG points in bed millimeters, y up. */
  points: [number, number][]
  color: string
  printable: boolean
}

/** Convex hull, counterclockwise (Andrew's monotone chain). */
export function hull(pts: [number, number][]): [number, number][] {
  if (pts.length < 3) return pts.slice()
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: [number, number][] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: [number, number][] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop()
    upper.push(q)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

const cache = new WeakMap<PlateEntry, Footprint>()

/** The outline an object casts on the bed: the hull of its placed vertices. Entries are replaced on every edit, so the cache follows them. */
export function footprint(e: PlateEntry): Footprint {
  const hit = cache.get(e)
  if (hit) return hit
  const m = e.transform
  const total = e.parts.reduce((a, p) => a + p.positions.length / 3, 0)
  const step = Math.max(1, Math.ceil(total / SAMPLE))
  const pts: [number, number][] = []
  for (const part of e.parts) {
    const v = part.positions
    for (let i = 0; i < v.length / 3; i += step) {
      const x = v[3 * i] ?? 0
      const y = v[3 * i + 1] ?? 0
      const z = v[3 * i + 2] ?? 0
      pts.push([(m[0] ?? 1) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0), (m[1] ?? 0) * x + (m[5] ?? 1) * y + (m[9] ?? 0) * z + (m[13] ?? 0)])
    }
  }
  const out = { points: hull(pts), color: e.colors[0] ?? brandAccent(), printable: e.printable !== false }
  cache.set(e, out)
  return out
}

export function PlateThumb({ objects, bed, size = 44, label }: { objects: readonly PlateEntry[]; bed: Bed; size?: number; label?: string }) {
  const w = Math.max(1, bed.widthMm)
  const d = Math.max(1, bed.depthMm)
  const aspect = d / w
  return (
    <svg className="plate-thumb" width={size} height={Math.round(size * aspect)} viewBox={`0 0 ${w} ${d}`} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <rect x={0} y={0} width={w} height={d} rx={Math.min(w, d) * 0.04} className="plate-thumb-bed" />
      {/* Bed y runs up, SVG y down. */}
      <g transform={`translate(0 ${d}) scale(1 -1)`}>
        {objects.map((e) => {
          const f = footprint(e)
          return f.points.length >= 3 ? <polygon key={e.id} points={f.points.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')} fill={f.printable ? f.color : 'var(--dim)'} className="plate-thumb-obj" /> : null
        })}
      </g>
    </svg>
  )
}
