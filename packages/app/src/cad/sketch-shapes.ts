// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The drawing tools' shapes past the first ones: rectangles by an edge or the center, circles by a diameter, arcs by
// the center or tangent to a chain, polygons and slots. Plain geometry on the plane, in mm; closed shapes run
// counterclockwise, like rectangle() in sketch-model.ts.
import type { Chain, Seg, V2 } from './sketch-model'

const EPS = 1e-6
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6
const pt = (x: number, y: number): V2 => [r6(x), r6(y)]
const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]]
const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]]
const mul = (a: V2, k: number): V2 => [a[0] * k, a[1] * k]
const dot = (a: V2, b: V2): number => a[0] * b[0] + a[1] * b[1]
const cross = (a: V2, b: V2): number => a[0] * b[1] - a[1] * b[0]
const len = (a: V2): number => Math.hypot(a[0], a[1])
const unit = (a: V2): V2 | null => (len(a) < EPS ? null : mul(a, 1 / len(a)))
const left = (a: V2): V2 => [-a[1], a[0]]
const at = (c: V2, r: number, t: number): V2 => pt(c[0] + r * Math.cos(t), c[1] + r * Math.sin(t))

/** A closed chain of lines through the corners, counterclockwise whichever way they came. */
export function ring(corners: readonly V2[]): Chain | null {
  if (corners.length < 3) return null
  let area = 0
  corners.forEach((p, i) => (area += cross(p, corners[(i + 1) % corners.length]!)))
  if (Math.abs(area) < EPS) return null
  const c = area > 0 ? [...corners] : [corners[0]!, ...corners.slice(1).reverse()]
  const start = pt(...c[0]!)
  const segs: Seg[] = [...c.slice(1).map((p): Seg => ({ kind: 'line', to: pt(...p) })), { kind: 'line', to: start }]
  return { kind: 'chain', start, segs, closed: true }
}

/** The signed distance of `p` from the line through `a` and `b`, positive on the left. */
export function offsetFrom(a: V2, b: V2, p: V2): number {
  const d = unit(sub(b, a))
  return d ? cross(d, sub(p, a)) : 0
}

/** A rectangle with its first edge from `a` to `b` and its width out to `p`: it can sit at any angle. */
export function rect3(a: V2, b: V2, p: V2): Chain | null {
  const d = unit(sub(b, a))
  if (!d) return null
  const w = offsetFrom(a, b, p)
  if (Math.abs(w) < EPS) return null
  const n = mul(left(d), w)
  return ring([a, b, add(b, n), add(a, n)])
}

/** A rectangle from its center to a corner. */
export function rectCenter(c: V2, p: V2): Chain | null {
  const q = sub(mul(c, 2), p)
  if (Math.abs(p[0] - c[0]) < EPS || Math.abs(p[1] - c[1]) < EPS) return null
  return ring([q, [p[0], q[1]], p, [q[0], p[1]]])
}

/** A circle on the two ends of a diameter. */
export function circle2(a: V2, b: V2): { center: V2; diameterMm: number } | null {
  const d = len(sub(b, a))
  return d < EPS ? null : { center: pt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), diameterMm: r6(d) }
}

/** An arc around `c` from `s`, ending where `p` points; the shorter way round. */
export function arcCenter(c: V2, s: V2, p: V2): { to: V2; through: V2 } | null {
  const r = len(sub(s, c))
  if (r < EPS || len(sub(p, c)) < EPS) return null
  const t0 = Math.atan2(s[1] - c[1], s[0] - c[0])
  let sweep = Math.atan2(p[1] - c[1], p[0] - c[0]) - t0
  while (sweep > Math.PI) sweep -= 2 * Math.PI
  while (sweep < -Math.PI) sweep += 2 * Math.PI
  if (Math.abs(sweep) < 1e-4) return null
  return { to: at(c, r, t0 + sweep), through: at(c, r, t0 + sweep / 2) }
}

/** An arc from `a`, leaving along `t`, to `b`. Null when `b` is straight ahead or behind. */
export function arcTangent(a: V2, t: V2, b: V2): { to: V2; through: V2 } | null {
  const u = unit(t)
  if (!u) return null
  const n = left(u)
  const d = sub(b, a)
  const den = 2 * dot(n, d)
  if (Math.abs(den) < EPS) return null
  const c = add(a, mul(n, dot(d, d) / den))
  const r = len(sub(a, c))
  const t0 = Math.atan2(a[1] - c[1], a[0] - c[0])
  // counterclockwise when the tangent turns left
  const ccw = cross(sub(a, c), u) > 0
  let sweep = Math.atan2(b[1] - c[1], b[0] - c[0]) - t0
  if (ccw) while (sweep <= 0) sweep += 2 * Math.PI
  else while (sweep >= 0) sweep -= 2 * Math.PI
  return { to: pt(...b), through: at(c, r, t0 + sweep / 2) }
}

export type PolygonMode = 'inscribed' | 'circumscribed' | 'edge'

/**
 * A regular polygon of `sides`. Inscribed: center `a`, a corner at `b`. Circumscribed: center `a`, the middle of an
 * edge at `b`. Edge: one edge from `a` to `b`, the polygon on the side of `p`.
 */
export function polygon(mode: PolygonMode, a: V2, b: V2, sides: number, p: V2 = b): Chain | null {
  const k = Math.max(3, Math.min(64, Math.round(sides)))
  const step = (2 * Math.PI) / k
  let c = a
  let r: number
  let t0: number
  if (mode === 'edge') {
    const e = len(sub(b, a))
    const d = unit(sub(b, a))
    if (!d) return null
    const side = offsetFrom(a, b, p) < 0 ? -1 : 1
    c = add(mul(add(a, b), 0.5), mul(left(d), (side * e) / (2 * Math.tan(Math.PI / k))))
    r = e / (2 * Math.sin(Math.PI / k))
    t0 = Math.atan2(a[1] - c[1], a[0] - c[0])
  } else {
    const q = len(sub(b, a))
    if (q < EPS) return null
    const tb = Math.atan2(b[1] - a[1], b[0] - a[0])
    r = mode === 'inscribed' ? q : q / Math.cos(Math.PI / k)
    t0 = mode === 'inscribed' ? tb : tb + Math.PI / k
  }
  return ring(Array.from({ length: k }, (_, i) => at(c, r, t0 + i * step)))
}

export type SlotMode = 'centers' | 'overall' | 'center'

/** The centers of a slot's two end arcs from the first two picks: center to center, the overall ends, or the center and one end. */
export function slotCenters(mode: SlotMode, a: V2, b: V2, width: number): [V2, V2] | null {
  if (mode === 'center') return [sub(mul(a, 2), b), b]
  if (mode === 'centers') return [a, b]
  const d = unit(sub(b, a))
  if (!d || len(sub(b, a)) <= width + EPS) return null
  return [add(a, mul(d, width / 2)), sub(b, mul(d, width / 2))]
}

/** A slot: two half circles of `width` joined by straight sides, around the line from `c1` to `c2`. */
export function slot(c1: V2, c2: V2, width: number): Chain | null {
  const d = unit(sub(c2, c1))
  if (!d || !(width > EPS)) return null
  const h = width / 2
  const n = mul(left(d), h)
  const start = pt(...sub(c1, n))
  const segs: Seg[] = [
    { kind: 'line', to: pt(...sub(c2, n)) },
    { kind: 'arc', through: pt(...add(c2, mul(d, h))), to: pt(...add(c2, n)) },
    { kind: 'line', to: pt(...add(c1, n)) },
    { kind: 'arc', through: pt(...sub(c1, mul(d, h))), to: start },
  ]
  return { kind: 'chain', start, segs, closed: true }
}
