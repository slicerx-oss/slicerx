// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A rail along a path on a plane: round posts standing at an even spacing along it, and a flat top bar following it at
// the posts' tops. The path is an open run of points (a rail along one side) or a closed outline (a rail all round a
// deck or a tray's rim), in the plane's own [u, v] coordinates. This lays it out: where each post stands, and the
// bar's outline as sketch loops, a band the bar's width wide centered on the path. slicerx_geom_rail extrudes both.
import type { SketchLoop, Vec2 } from '@slicerx/cad-history'

export interface RailLayout {
  /** Where each post stands on the path, [u, v]. */
  posts: Vec2[]
  /** The top bar's outline: one loop for an open path, the outer loop and its hole for a closed one. */
  bar: SketchLoop[]
  /** The path's length, mm. */
  lengthMm: number
  /** The largest distance between neighboring posts along the path, mm. */
  spacingMm: number
  /** How many posts stand on a corner of the path (an open path's ends count). */
  cornerPosts: number
}

/** A turn of the path sharper than this, degrees, is a corner, and gets a post. Gentler turns (an arc drawn as short
 * segments) are not corners. */
export const CORNER_DEG = 30

/** How far a mitered corner of the bar may reach past its half width, in half widths, before the corner is cut. */
const MITER_LIMIT = 4

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]]
const norm = (a: Vec2): number => Math.hypot(a[0], a[1])
const r4 = (n: number): number => Math.round(n * 10_000) / 10_000

/** The path's points with repeats (and, closed, a last point back on the first) dropped. */
export function railPath(points: readonly Vec2[], closed: boolean): Vec2[] {
  const out: Vec2[] = []
  for (const p of points) if (!out.length || norm(sub(p, out[out.length - 1]!)) > 1e-6) out.push([p[0], p[1]])
  if (closed && out.length > 1 && norm(sub(out[0]!, out[out.length - 1]!)) <= 1e-6) out.pop()
  return out
}

/** Twice the signed area of a closed outline: positive when it runs counterclockwise. */
function area2(p: readonly Vec2[]): number {
  let s = 0
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!
    const b = p[(i + 1) % p.length]!
    s += a[0] * b[1] - b[0] * a[1]
  }
  return s
}

/**
 * The path moved sideways by `d` mm, to its left for d > 0, each corner mitered (cut at MITER_LIMIT half widths). A
 * closed path's ends join; an open path's end points move square to their own segment.
 */
export function offsetPath(p: readonly Vec2[], closed: boolean, d: number): Vec2[] {
  const n = p.length
  const left = (a: Vec2, b: Vec2): Vec2 => {
    const t = sub(b, a)
    const l = norm(t) || 1
    return [-t[1] / l, t[0] / l]
  }
  return p.map((q, i) => {
    const prev = closed ? p[(i - 1 + n) % n]! : i > 0 ? p[i - 1]! : null
    const next = closed ? p[(i + 1) % n]! : i < n - 1 ? p[i + 1]! : null
    const n0 = prev ? left(prev, q) : left(q, next!)
    const n1 = next ? left(q, next) : n0
    const m: Vec2 = [n0[0] + n1[0], n0[1] + n1[1]]
    const ml = norm(m)
    // a path that turns straight back: square to the segment it arrives on
    if (ml < 1e-9) return [q[0] + n0[0] * d, q[1] + n0[1] * d]
    const along = Math.min(1 / ((m[0] / ml) * n0[0] + (m[1] / ml) * n0[1]), MITER_LIMIT)
    return [q[0] + (m[0] / ml) * d * along, q[1] + (m[1] / ml) * d * along]
  })
}

/** A closed outline moved `d` mm inward (outward for d < 0), whichever way it runs. */
export function insetOutline(p: readonly Vec2[], d: number): Vec2[] {
  return offsetPath(p, true, area2(p) >= 0 ? d : -d)
}

/**
 * A post at every corner of the path (each turn sharper than CORNER_DEG, and an open path's ends), and the rest spread
 * evenly between neighboring corners, no more than `spacingMm` apart; a closed path with no corners gets at least 3,
 * spread evenly all round. The top bar is `barMm` wide, centered on the path; an open path's bar runs `capMm` past each
 * end, over the end posts. Says why when the path is too short to stand a rail on.
 */
export function railLayout(points: readonly Vec2[], closed: boolean, o: { spacingMm: number; barMm: number; capMm?: number }): RailLayout | string {
  const p = railPath(points, closed)
  if (p.length < (closed ? 3 : 2)) return closed ? 'A closed path needs 3 or more different points.' : 'A path needs 2 or more different points.'
  const segs = p.map((a, i) => (i < p.length - 1 || closed ? norm(sub(p[(i + 1) % p.length]!, a)) : 0))
  const lengthMm = segs.reduce((s, l) => s + l, 0)
  if (lengthMm < o.barMm) return `The path is ${r4(lengthMm)} mm long, shorter than the bar is wide (${o.barMm} mm).`
  // how far along the path each point is, and which points are corners
  const along: number[] = []
  segs.reduce((s, l, i) => ((along[i] = s), s + l), 0)
  // cos 30 degrees, written out so every system reads the same corners
  const cos = 0.8660254037844387
  const turns = (i: number): boolean => {
    const a = p[(i - 1 + p.length) % p.length]!
    const b = p[i]!
    const c = p[(i + 1) % p.length]!
    const u = sub(b, a)
    const v = sub(c, b)
    return (u[0] * v[0] + u[1] * v[1]) / (norm(u) * norm(v)) < cos
  }
  const corners = closed ? p.map((_, i) => i).filter(turns).map((i) => along[i]!) : [0, ...p.slice(1, -1).map((_, k) => k + 1).filter(turns).map((i) => along[i]!), lengthMm]
  // the stretches between neighboring corners, each split into gaps no longer than the spacing
  const marks: number[] = []
  let widest = 0
  const spread = (from: number, to: number, least: number) => {
    const gaps = Math.max(least, Math.ceil((to - from) / o.spacingMm - 1e-9))
    const step = (to - from) / gaps
    widest = Math.max(widest, step)
    for (let k = 0; k < gaps; k++) marks.push(from + k * step)
  }
  if (closed && !corners.length) spread(0, lengthMm, 3)
  else if (closed) corners.forEach((c, k) => spread(c, k + 1 < corners.length ? corners[k + 1]! : corners[0]! + lengthMm, 1))
  else {
    corners.slice(0, -1).forEach((c, k) => spread(c, corners[k + 1]!, 1))
    marks.push(lengthMm)
  }
  const at = (s0: number): Vec2 => {
    let left = s0 % lengthMm
    if (!closed && s0 >= lengthMm) left = lengthMm
    for (let i = 0; i < segs.length; i++) {
      const l = segs[i]!
      if (l > 0 && (left <= l || i === segs.length - 1)) {
        const a = p[i]!
        const b = p[(i + 1) % p.length]!
        const t = Math.min(1, left / l)
        return [r4(a[0] + (b[0] - a[0]) * t), r4(a[1] + (b[1] - a[1]) * t)]
      }
      left -= l
    }
    return [p[0]![0], p[0]![1]]
  }
  const posts = marks.map(at)
  const h = o.barMm / 2
  // an open bar reaches past the end posts, so its ends never cut through them
  const cap = o.capMm ?? 0
  const ends = (q: Vec2[]): Vec2[] => {
    if (closed || cap <= 0) return q
    const out = q.map((x): Vec2 => [x[0], x[1]])
    const push = (i: number, j: number) => {
      const d = sub(q[i]!, q[j]!)
      const l = norm(d) || 1
      out[i] = [q[i]![0] + (d[0] / l) * cap, q[i]![1] + (d[1] / l) * cap]
    }
    push(0, 1)
    push(q.length - 1, q.length - 2)
    return out
  }
  const run = ends(p)
  const outer = offsetPath(run, closed, h).map(([u, v]): Vec2 => [r4(u), r4(v)])
  const inner = offsetPath(run, closed, -h).map(([u, v]): Vec2 => [r4(u), r4(v)])
  const bar: SketchLoop[] = closed ? [{ points: outer }, { points: inner }] : [{ points: [...outer, ...inner.reverse()] }]
  return { posts, bar, lengthMm: r4(lengthMm), spacingMm: r4(widest), cornerPosts: corners.length }
}
