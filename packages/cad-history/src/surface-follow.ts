// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A row of copies that follows a curved side. A plain row shifts each copy the same way, so on a side that curves away
// the copies leave the surface (cutting nothing) or sink into it (cutting too deep). Following the surface, each copy
// is shifted along the row, then slid along the first copy's normal onto the part's surface there and turned from that
// normal to the surface's own, so every copy keeps the depth the first one has into the side it is on.
import type { StepParams } from './model'
import type { Mat4, Vec3 } from './types'

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a)
  return l > 0 ? scale(a, 1 / l) : [0, 0, 0]
}

/** Where a step works and, for a cut, the box its cutters fill: the faces the cut made lie inside it. */
export interface Anchor {
  at: Vec3
  box?: { min: Vec3; max: Vec3 }
}

/** Where a step works, for the steps a surface row can follow: the middle of a cut's cutters, or a shape's place. */
export function anchorOf(p: StepParams): Anchor | null {
  if (p.op === 'subtract') {
    const lo: Vec3 = [Infinity, Infinity, Infinity]
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
    for (const s of p.solids) {
      const pts: Vec3[] = s.type === 'box' ? [s.min, s.max] : s.type === 'cylinder' ? [s.origin, add(s.origin, scale(unit(s.axis), s.heightMm))] : []
      for (const q of pts) for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a]!, q[a]!)
        hi[a] = Math.max(hi[a]!, q[a]!)
      }
    }
    return Number.isFinite(lo[0]) ? { at: scale(add(lo, hi), 0.5), box: { min: lo, max: hi } } : null
  }
  if (p.op === 'shape.extrude' && p.frame) return { at: p.frame.origin }
  return null
}

export interface SurfaceHit {
  point: Vec3
  normal: Vec3
}

type Tri = { a: Vec3; b: Vec3; c: Vec3; n: Vec3 }

/** Each triangle's corners and normal, from a mesh in world space. */
function triangles(positions: readonly number[], indices: readonly number[]): Tri[] {
  const v = (i: number): Vec3 => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!]
  const out: Tri[] = []
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const [a, b, c] = [v(indices[t]!), v(indices[t + 1]!), v(indices[t + 2]!)]
    const n = unit(cross(sub(b, a), sub(c, a)))
    if (n[0] || n[1] || n[2]) out.push({ a, b, c, n })
  }
  return out
}

/** Where a line through `at` along `dir` meets the surface, the meeting nearest `at`, with the surface's normal. */
export function surfaceAlong(positions: readonly number[], indices: readonly number[], at: Vec3, dir: Vec3): SurfaceHit | null {
  return alongTris(triangles(positions, indices), at, dir)
}

function alongTris(tris: readonly Tri[], at: Vec3, dir: Vec3): SurfaceHit | null {
  const d = unit(dir)
  let best: SurfaceHit | null = null
  let bestT = Infinity
  for (const { a, b, c, n } of tris) {
    // Moller-Trumbore, both ways along the line
    const e1 = sub(b, a)
    const e2 = sub(c, a)
    const p = cross(d, e2)
    const det = dot(e1, p)
    if (Math.abs(det) < 1e-12) continue
    const s = sub(at, a)
    const u = dot(s, p) / det
    if (u < -1e-9 || u > 1 + 1e-9) continue
    const q = cross(s, e1)
    const w = dot(d, q) / det
    if (w < -1e-9 || u + w > 1 + 1e-9) continue
    const t = dot(e2, q) / det
    if (Math.abs(t) < bestT) {
      bestT = Math.abs(t)
      best = { point: add(at, scale(d, t)), normal: n }
    }
  }
  return best
}

/** The point of triangle a, b, c nearest p (Ericson, Real-Time Collision Detection 5.1.5). */
function nearestOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a)
  const ac = sub(c, a)
  const ap = sub(p, a)
  const d1 = dot(ab, ap)
  const d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return a
  const bp = sub(p, b)
  const d3 = dot(ab, bp)
  const d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return b
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)))
  const cp = sub(p, c)
  const d5 = dot(ab, cp)
  const d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return c
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)))
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, scale(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))))
  const den = 1 / (va + vb + vc)
  return add(a, add(scale(ab, vb * den), scale(ac, vc * den)))
}

/** The surface nearest a step's place: the nearest point on any triangle, with that triangle's normal. */
export function surfaceNear(positions: readonly number[], indices: readonly number[], at: Vec3): SurfaceHit | null {
  return nearTris(triangles(positions, indices), at)
}

function nearTris(tris: readonly Tri[], at: Vec3): SurfaceHit | null {
  let best: SurfaceHit | null = null
  let bestD = Infinity
  for (const { a, b, c, n } of tris) {
    const q = nearestOnTriangle(at, a, b, c)
    const dist = Math.hypot(...sub(q, at))
    if (dist < bestD) {
      bestD = dist
      best = { point: q, normal: n }
    }
  }
  return best
}

/** The turn taking unit vector `from` onto unit vector `to`, about the point `at`, then moved by `by`: column-major. */
function turnOnto(from: Vec3, to: Vec3, at: Vec3, by: Vec3): Mat4 {
  const v = cross(from, to)
  const c = dot(from, to)
  // Rodrigues: R = I + [v]x + [v]x^2 / (1 + c); a half turn (c = -1) does not come up, as a normal never flips here
  const k = c > -1 + 1e-9 ? 1 / (1 + c) : 0
  const [x, y, z] = v
  const r = [
    [1 - k * (y * y + z * z), -z + k * x * y, y + k * x * z],
    [z + k * x * y, 1 - k * (x * x + z * z), -x + k * y * z],
    [-y + k * x * z, x + k * y * z, 1 - k * (x * x + y * y)],
  ]
  // p -> R (p - at) + at + by
  const t = add(sub(at, [r[0]![0]! * at[0] + r[0]![1]! * at[1] + r[0]![2]! * at[2], r[1]![0]! * at[0] + r[1]![1]! * at[1] + r[1]![2]! * at[2], r[2]![0]! * at[0] + r[2]![1]! * at[1] + r[2]![2]! * at[2]]), by)
  return [r[0]![0]!, r[1]![0]!, r[2]![0]!, 0, r[0]![1]!, r[1]![1]!, r[2]![1]!, 0, r[0]![2]!, r[1]![2]!, r[2]![2]!, 0, t[0], t[1], t[2], 1]
}

/** A copy of a row that found no side to follow where it lands (copy 1 is the steps themselves), and why. */
export interface OffSurface {
  copy: number
  why: string
}

/**
 * The world moves of a row that follows the part's surface, one for each plain row move (a shift). The first copy's
 * side is read beside it, clear of the faces its own cut made: its normal from the nearest face outside the cut, and its
 * point between the side just past each end of the cut along the row. Each copy then goes from that point to the
 * surface met along that normal through its shifted place, turned from that normal to the surface's there. A copy whose
 * place meets no surface, or a surface turned past the side, is that copy's entry, named with why, for the pattern to
 * leave out; with no side beside the first copy there is no row at all, and that is the whole answer.
 */
export function surfaceMoves(shifts: readonly Mat4[], anchor: Anchor, positions: readonly number[], indices: readonly number[]): (Mat4 | OffSurface)[] | OffSurface {
  const inBox = (t: Tri): boolean => {
    if (!anchor.box) return false
    const m = scale(add(add(t.a, t.b), t.c), 1 / 3)
    return [0, 1, 2].every((k) => m[k]! >= anchor.box!.min[k]! - 0.05 && m[k]! <= anchor.box!.max[k]! + 0.05)
  }
  const tris = triangles(positions, indices).filter((t) => !inBox(t))
  const near = nearTris(tris, anchor.at)
  if (!near) return { copy: 1, why: 'The first copy is not on the part, so there is no surface for the row to follow.' }
  const n0guess = near.normal
  // along the row, just past each end of the first copy's cut
  const m0 = shifts[0]
  const u = m0 ? unit([m0[12]!, m0[13]!, m0[14]!]) : ([0, 0, 0] as Vec3)
  const reach = anchor.box ? Math.abs(dot(scale(sub(anchor.box.max, anchor.box.min), 0.5), [Math.abs(u[0]), Math.abs(u[1]), Math.abs(u[2])])) + 0.5 : 1.5
  const beside = [1, -1].map((sign) => {
    const h = alongTris(tris, add(anchor.at, scale(u, sign * reach)), n0guess)
    return h ? { point: sub(h.point, scale(u, sign * reach)), normal: dot(h.normal, n0guess) < 0 ? scale(h.normal, -1) : h.normal } : null
  }).filter((h): h is SurfaceHit => h !== null)
  const first: SurfaceHit = beside.length ? { point: scale(beside.reduce((a, h) => add(a, h.point), [0, 0, 0] as Vec3), 1 / beside.length), normal: unit(beside.reduce((a, h) => add(a, h.normal), [0, 0, 0] as Vec3)) } : near
  const n0 = first.normal
  return shifts.map((m, k): Mat4 | OffSurface => {
    const shifted = add(first.point, [m[12]!, m[13]!, m[14]!])
    const hit = alongTris(tris, shifted, n0)
    if (!hit) return { copy: k + 2, why: 'The row runs off the part there: no surface along the first copy\'s normal. Shorten the row or space it closer.' }
    // the surface's normal on the same side as the first one's
    const n = dot(hit.normal, n0) < 0 ? scale(hit.normal, -1) : hit.normal
    if (dot(n, n0) < 0.2) return { copy: k + 2, why: 'The row turns past the side there, onto another face. Shorten the row or space it closer.' }
    return turnOnto(n0, n, first.point, sub(hit.point, first.point))
  })
}
