// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Splines through points, as the engine draws them (sx-geom sketch_spline.rs): centripetal Catmull-Rom, each span a
// cubic Bezier, flattened so no chord strays more than 0.005 mm from the curve. The engine's polygons make the solid;
// these points only draw the sketch, and a test keeps the two the same.
import type { Vec2 as V2 } from '@slicerx/cad-history'

/** Chord error of a flattened spline, mm: half the default slice resolution, the same as arcs. */
export const SPLINE_TOL_MM = 0.005
/** Most steps one span may take; a span that needs more is refused, as the engine refuses it. */
export const SPLINE_MAX_STEPS = 1024
/** Most points one loop may have once flattened, counted as the engine counts them. The engine's sketch-wide limit is left to its check. */
export const RING_POINTS = 65_536

const len = (a: V2): number => Math.hypot(a[0], a[1])
const knot = (a: V2, b: V2): number => Math.max(Math.sqrt(len([b[0] - a[0], b[1] - a[1]])), 1e-12)

/** The Bezier of the span from `p1` to `p2`, with `p0` before it and `p3` after. */
export function span(p0: V2, p1: V2, p2: V2, p3: V2): [V2, V2, V2, V2] {
  const t01 = knot(p0, p1)
  const t12 = knot(p1, p2)
  const t23 = knot(p2, p3)
  const m1 = (i: 0 | 1) => p2[i] - p1[i] + t12 * ((p1[i] - p0[i]) / t01 - (p2[i] - p0[i]) / (t01 + t12))
  const m2 = (i: 0 | 1) => p2[i] - p1[i] + t12 * ((p3[i] - p2[i]) / t23 - (p3[i] - p1[i]) / (t12 + t23))
  return [p1, [p1[0] + m1(0) / 3, p1[1] + m1(1) / 3], [p2[0] - m2(0) / 3, p2[1] - m2(1) / 3], p2]
}

/** The spans through `pts`, closing round to the first when `closed`; an open end mirrors its neighbor. */
export function spans(pts: readonly V2[], closed: boolean): [V2, V2, V2, V2][] {
  const n = pts.length
  if (n < 2) return []
  const mirror = (a: V2, b: V2): V2 => [2 * a[0] - b[0], 2 * a[1] - b[1]]
  const at = (i: number): V2 => {
    if (closed) return pts[((i % n) + n) % n]!
    if (i < 0) return mirror(pts[0]!, pts[1]!)
    if (i > n - 1) return mirror(pts[n - 1]!, pts[n - 2]!)
    return pts[i]!
  }
  const out: [V2, V2, V2, V2][] = []
  for (let i = 0; i < (closed ? n : n - 1); i++) out.push(span(at(i - 1), at(i), at(i + 1), at(i + 2)))
  return out
}

/** The points after `b[0]` along a span, or null when it bends too sharply to stay within the tolerance. */
export function flattenSpan(b: readonly [V2, V2, V2, V2]): V2[] | null {
  const dd = (i: number, j: number, k: number) => len([b[i]![0] - 2 * b[j]![0] + b[k]![0], b[i]![1] - 2 * b[j]![1] + b[k]![1]])
  const m = 6 * Math.max(dd(0, 1, 2), dd(1, 2, 3))
  const steps = Math.ceil(Math.sqrt(m / (8 * SPLINE_TOL_MM)))
  if (!(steps <= SPLINE_MAX_STEPS)) return null
  const n = Math.max(1, steps)
  const out: V2[] = []
  for (let s = 1; s <= n; s++) {
    if (s === n) {
      out.push(b[3])
      continue
    }
    const t = s / n
    const u = 1 - t
    const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t] as const
    out.push([w[0] * b[0][0] + w[1] * b[1][0] + w[2] * b[2][0] + w[3] * b[3][0], w[0] * b[0][1] + w[1] * b[1][1] + w[2] * b[2][1] + w[3] * b[3][1]])
  }
  return out
}

/**
 * A spline as a polyline: through `pts` with both ends, or round them back to the first when `closed`. Null when the
 * engine would refuse it: a span past the step limit, or more than `budget` points.
 */
export function splinePoints(pts: readonly V2[], closed: boolean, budget = RING_POINTS): V2[] | null {
  if (pts.length < 2) return [...pts]
  const out: V2[] = [pts[0]!]
  for (const b of spans(pts, closed)) {
    const f = flattenSpan(b)
    if (!f || out.length + f.length > budget + 1) return null
    out.push(...f)
  }
  return out
}

/** The unit direction a spline through `pts` leaves its last point in. */
export function splineEndDir(pts: readonly V2[]): V2 | null {
  const b = spans(pts, false).at(-1)
  if (!b) return null
  for (const q of [b[2], b[1], b[0]]) {
    const d: V2 = [b[3][0] - q[0], b[3][1] - q[1]]
    const l = len(d)
    if (l > 1e-12) return [d[0] / l, d[1] / l]
  }
  return null
}
