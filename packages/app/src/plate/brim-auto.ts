// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Auto-generate for brim ears, after OrcaSlicer's brim ears gizmo (GLGizmoBrimEars.cpp: first_layer_slicer,
// generate_points, get_detection_radius_max). The first layer is the mesh cut 0.1 mm above the lowest point; its outer
// contours give ears at their convex corners and its holes at their concave corners, after the contour is simplified
// by the detection length (Douglas-Peucker). A corner counts when it turns by more than 180 - max angle degrees.
import type { PlateEntry } from '../state/store'
import { apply, type Mat4 } from './transform'

export type Pt = [number, number]
type Loop = Pt[]

const CUT_ABOVE_MM = 0.1

/** Orca's gizmo defaults. */
export const AUTO_DEFAULTS = { maxAngle: 125, detection: 1 } as const

/** The cross-section of the object's parts 0.1 mm above its lowest point, as closed loops in bed coordinates: counterclockwise for outlines, clockwise for holes. */
export function firstLayerLoops(e: PlateEntry): Loop[] {
  const world = e.parts.map((part) => {
    const p = new Float32Array(part.positions.length)
    for (let i = 0; i + 2 < p.length; i += 3) {
      const [x, y, z] = apply(e.transform as Mat4, [part.positions[i]!, part.positions[i + 1]!, part.positions[i + 2]!])
      p[i] = x
      p[i + 1] = y
      p[i + 2] = z
    }
    return { p, ix: part.indices }
  })
  let low = Infinity
  for (const { p } of world) for (let i = 2; i < p.length; i += 3) low = Math.min(low, p[i]!)
  if (!Number.isFinite(low)) return []
  const h = low + CUT_ABOVE_MM
  const key = (x: number, y: number): string => `${Math.round(x * 1000)},${Math.round(y * 1000)}`
  const next = new Map<string, { to: string; from: Pt; toPt: Pt }>()
  for (const { p, ix } of world) {
    for (let i = 0; i + 2 < ix.length; i += 3) {
      const v = [ix[i]!, ix[i + 1]!, ix[i + 2]!].map((k) => [p[k * 3]!, p[k * 3 + 1]!, p[k * 3 + 2]!] as [number, number, number])
      const hit: Pt[] = []
      for (let k = 0; k < 3; k++) {
        const a = v[k]!
        const b = v[(k + 1) % 3]!
        if ((a[2] < h) !== (b[2] < h)) {
          const t = (h - a[2]) / (b[2] - a[2])
          hit.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])
        }
      }
      if (hit.length !== 2) continue
      const [pa, pb] = hit as [Pt, Pt]
      // The triangle's outward normal in the plane: solid is on the left of the segment, so outward is on its right.
      const u = [v[1]![0] - v[0]![0], v[1]![1] - v[0]![1], v[1]![2] - v[0]![2]]
      const w = [v[2]![0] - v[0]![0], v[2]![1] - v[0]![1], v[2]![2] - v[0]![2]]
      const nx = u[1]! * w[2]! - u[2]! * w[1]!
      const ny = u[2]! * w[0]! - u[0]! * w[2]!
      const dx = pb[0] - pa[0]
      const dy = pb[1] - pa[1]
      if (Math.hypot(nx, ny) < 1e-9 || Math.hypot(dx, dy) < 1e-6) continue
      const [s, t2] = nx * dy - ny * dx > 0 ? [pa, pb] : [pb, pa]
      next.set(key(s[0], s[1]), { to: key(t2[0], t2[1]), from: s, toPt: t2 })
    }
  }
  const loops: Loop[] = []
  const used = new Set<string>()
  for (const [start, first] of next) {
    if (used.has(start)) continue
    const loop: Loop = []
    let k = start
    let seg: { to: string; from: Pt; toPt: Pt } | undefined = first
    let guard = 0
    while (seg && !used.has(k) && guard++ < 1_000_000) {
      used.add(k)
      loop.push(seg.from)
      k = seg.to
      seg = next.get(k)
    }
    if (k === start && loop.length >= 3) loops.push(loop)
  }
  return loops
}

const area2 = (l: Loop): number => l.reduce((s, p, i) => s + p[0] * l[(i + 1) % l.length]![1] - l[(i + 1) % l.length]![0] * p[1], 0)

function douglasPeucker(pts: Pt[], tol: number): Pt[] {
  const n = pts.length
  if (n < 3) return pts
  const keep = new Array<boolean>(n).fill(false)
  keep[0] = true
  keep[n - 1] = true
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    const pa = pts[a]!
    const pb = pts[b]!
    const dx = pb[0] - pa[0]
    const dy = pb[1] - pa[1]
    const l2 = dx * dx + dy * dy
    let far = 0
    let at = a
    for (let i = a + 1; i < b; i++) {
      const px = pts[i]![0] - pa[0]
      const py = pts[i]![1] - pa[1]
      const t = l2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / l2)) : 0
      const d2 = (px - t * dx) ** 2 + (py - t * dy) ** 2
      if (d2 > far) {
        far = d2
        at = i
      }
    }
    if (far > tol * tol) {
      keep[at] = true
      stack.push([a, at], [at, b])
    }
  }
  return pts.filter((_, i) => keep[i])
}

/** Vertices of a counterclockwise ring that turn by more than `threshold` radians, left (convex) or right (concave). */
function corners(ring: Loop, threshold: number, convex: boolean): Pt[] {
  const n = ring.length
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = ring[(i + n - 1) % n]!
    const b = ring[i]!
    const c = ring[(i + 1) % n]!
    const v1: Pt = [b[0] - a[0], b[1] - a[1]]
    const v2: Pt = [c[0] - b[0], c[1] - b[1]]
    const cross = v1[0] * v2[1] - v1[1] * v2[0]
    if ((convex && cross <= 0) || (!convex && cross >= 0)) continue
    const n1 = Math.hypot(v1[0], v1[1])
    const n2 = Math.hypot(v2[0], v2[1])
    if (n1 === 0 || n2 === 0) continue
    if (threshold > 1e-9 && (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2) >= Math.cos(threshold)) continue
    out.push(b)
  }
  return out
}

/** Where Orca's Auto-generate puts ears for these loops, bed coordinates. */
export function autoEarPositions(loops: Loop[], detectionMm: number, maxAngleDeg: number): Pt[] {
  const threshold = ((180 - maxAngleDeg) * Math.PI) / 180
  const out: Pt[] = []
  for (const loop of loops) {
    const hole = area2(loop) < 0
    let ring = hole ? [...loop].reverse() : loop
    if (detectionMm > 0) {
      const dp = douglasPeucker([...ring, ring[0]!], detectionMm)
      // Not decimated below 4 points: that is surely enough to fill everything.
      if (dp.length > 4) ring = dp.slice(0, -1)
    }
    out.push(...corners(ring, threshold, !hole))
  }
  return out
}

/** The largest detection length that still changes the simplified outline (Orca's get_detection_radius_max), capped at 100 mm. */
export function detectionMax(loops: Loop[]): number {
  let max = 0
  for (const loop of loops) {
    if (area2(loop) < 0) continue
    const ring = [...loop, loop[0]!]
    let tol = 0
    let min = douglasPeucker(ring, 0).length
    let repeat = 0
    for (let guard = 0; guard < 100; guard++) {
      tol += 10
      const num = douglasPeucker(ring, tol).length
      if (num === min) {
        if (++repeat > 1) break
      }
      min = num
    }
    for (let guard = 0; guard < 100; guard++) {
      tol -= 1
      const num = douglasPeucker(ring, tol).length
      if (num <= min) min = num
      else break
    }
    tol += 1
    max = Math.max(max, tol)
  }
  return max > 100 || max <= 0 ? 100 : max
}
