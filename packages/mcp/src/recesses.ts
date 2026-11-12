// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Blind openings read from the part itself, on any face, flat or curved: a round dent or a row of slits cut into a
// lofted body's curved side as well as a pocket in a flat top. Each opening's rim is a closed loop of sharp convex edges
// (the part's skin turning down into the opening); a line from the rim's middle into the part meets the opening's
// floor, looking back out, before it leaves the part. design.check holds a plan's recess rows (recess true) to these,
// by count and size, and never to its holes; a through hole is not a recess.

type V3 = [number, number, number]

/** Positions and triangles, in mm, as a baked part has them. */
export interface RecessMesh {
  positions: ArrayLike<number>
  indices: ArrayLike<number>
}

/** One blind opening: where its rim's middle is, the way out of it, its size across the rim and its depth, mm. */
export interface Recess {
  at: V3
  axis: V3
  /** Round: the rim lies on a circle, and width is its diameter. Otherwise a slit: width across, length along. */
  round: boolean
  widthMm: number
  lengthMm: number
  depthMm: number
}

/** Two faces meet at a sharp edge when their normals turn more than this. */
const SHARP_COS = Math.cos((30 * Math.PI) / 180)
/** A floor this deep or less is the skin itself, not an opening, mm. */
const SHALLOW_MM = 0.05
/** A blind opening is at most this many times as deep as it is wide; past it the line met a far wall, not a floor. */
const DEEP_SHARE = 8
/** A rim whose points lie within this share of their mean distance from its middle is round. */
const ROUND_SHARE = 0.06
/** Points closer than this are one vertex. */
const WELD_MM = 1e-4

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2])
const unit = (a: V3): V3 => {
  const l = len(a)
  return l > 1e-12 ? scale(a, 1 / l) : [0, 0, 1]
}

/** The blind openings of one part. */
export function recessesOf(m: RecessMesh): Recess[] {
  const nTri = Math.floor(m.indices.length / 3)
  const key = (i: number): string => `${Math.round((m.positions[i * 3] ?? 0) / WELD_MM)},${Math.round((m.positions[i * 3 + 1] ?? 0) / WELD_MM)},${Math.round((m.positions[i * 3 + 2] ?? 0) / WELD_MM)}`
  const pos = new Map<string, V3>()
  const tris: { k: [string, string, string]; p: [V3, V3, V3]; n: V3 }[] = []
  for (let t = 0; t < nTri; t++) {
    const ids = [m.indices[t * 3]!, m.indices[t * 3 + 1]!, m.indices[t * 3 + 2]!]
    const p = ids.map((i) => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!] as V3) as [V3, V3, V3]
    const k = ids.map(key) as [string, string, string]
    k.forEach((kk, j) => pos.set(kk, p[j]!))
    const c = cross(sub(p[1], p[0]), sub(p[2], p[0]))
    tris.push({ k, p, n: len(c) > 1e-12 ? unit(c) : [0, 0, 0] })
  }
  // each undirected edge's two triangles
  const edges = new Map<string, number[]>()
  tris.forEach((t, i) => {
    for (let j = 0; j < 3; j++) {
      const a = t.k[j]!
      const b = t.k[(j + 1) % 3]!
      const e = a < b ? `${a}|${b}` : `${b}|${a}`
      const l = edges.get(e)
      if (l) l.push(i)
      else edges.set(e, [i])
    }
  })
  // the sharp convex edges: two faces turning down away from each other, as a rim does
  const adj = new Map<string, string[]>()
  for (const [e, ts] of edges) {
    if (ts.length !== 2) continue
    const [ta, tb] = [tris[ts[0]!]!, tris[ts[1]!]!]
    if (len(ta.n) === 0 || len(tb.n) === 0 || dot(ta.n, tb.n) > SHARP_COS) continue
    const [a, b] = e.split('|') as [string, string]
    // convex: the far corner of one face lies behind the other
    const far = tb.k.find((x) => x !== a && x !== b)!
    if (dot(sub(pos.get(far)!, pos.get(a)!), ta.n) > 1e-9) continue
    adj.set(a, [...(adj.get(a) ?? []), b])
    adj.set(b, [...(adj.get(b) ?? []), a])
  }
  // simple closed loops of them
  const seen = new Set<string>()
  const out: Recess[] = []
  for (const start of adj.keys()) {
    if (seen.has(start)) continue
    const loop: string[] = []
    const stack = [start]
    let simple = true
    while (stack.length) {
      const v = stack.pop()!
      if (seen.has(v)) continue
      seen.add(v)
      loop.push(v)
      const nb = adj.get(v)!
      if (nb.length !== 2) simple = false
      for (const w of nb) if (!seen.has(w)) stack.push(w)
    }
    if (!simple || loop.length < 3) continue
    const r = opening(loop.map((k) => pos.get(k)!), tris)
    if (r) out.push(r)
  }
  return out
}

/** A rim's opening when a line from its middle into the part meets a floor looking back out; null otherwise. */
function opening(points: readonly V3[], tris: readonly { p: [V3, V3, V3]; n: V3 }[]): Recess | null {
  const c = scale(points.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / points.length)
  // the rim's plane: the normal is the least spread of its points (a covariance's smallest axis, by power iteration)
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (const p of points) {
    const d = sub(p, c)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i * 3 + j]! += d[i]! * d[j]!
  }
  const mul = (v: V3): V3 => [0, 1, 2].map((i) => cov[i * 3]! * v[0] + cov[i * 3 + 1]! * v[1] + cov[i * 3 + 2]! * v[2]) as V3
  let u: V3 = unit([1, 0.3, 0.2])
  for (let i = 0; i < 40; i++) u = unit(mul(u))
  let v: V3 = unit(cross(u, [0.2, 1, 0.3]))
  for (let i = 0; i < 40; i++) {
    v = mul(v)
    v = unit(sub(v, scale(u, dot(v, u))))
  }
  const n = unit(cross(u, v))
  // the way out is the side a line leaves the part from; the way in meets the floor
  for (const out of [n, scale(n, -1)] as V3[]) {
    const inward = scale(out, -1)
    const from = add(c, scale(out, 1e-3))
    const hit = firstHit(from, inward, tris)
    const back = firstHit(add(c, scale(inward, 1e-3)), out, tris)
    if (!hit || back) continue
    const depth = hit.d - 1e-3
    // a floor looking back out, deeper than the skin
    if (depth <= SHALLOW_MM || dot(hit.n, out) <= 0) continue
    // sized as seen down the opening, along its floor's normal: a round dent in a side that turns away has a rim
    // stretched on the skin, but it is round across its own axis
    const fu = unit(Math.abs(hit.n[0]) < 0.9 ? cross(hit.n, [1, 0, 0]) : cross(hit.n, [0, 1, 0]))
    const fv = cross(hit.n, fu)
    const flat0 = points.map((p) => [dot(sub(p, c), fu), dot(sub(p, c), fv)] as [number, number])
    // along and across: the rim's own long and short axes in that view
    let ax: number
    let sxx = 0
    let sxy = 0
    let syy = 0
    for (const [x, y] of flat0) {
      sxx += x * x
      sxy += x * y
      syy += y * y
    }
    ax = 0.5 * Math.atan2(2 * sxy, sxx - syy)
    const flat = flat0.map(([x, y]) => [x * Math.cos(ax) + y * Math.sin(ax), -x * Math.sin(ax) + y * Math.cos(ax)] as [number, number])
    // radii from the middle of its extents: the rim's points crowd where the skin's facets cross it, which pulls their
    // average off the middle
    const mx = (Math.max(...flat.map(([x]) => x)) + Math.min(...flat.map(([x]) => x))) / 2
    const my = (Math.max(...flat.map(([, y]) => y)) + Math.min(...flat.map(([, y]) => y))) / 2
    const radii = flat.map(([x, y]) => Math.hypot(x - mx, y - my))
    const mean = radii.reduce((s, r) => s + r, 0) / radii.length
    const round = radii.every((r) => Math.abs(r - mean) <= ROUND_SHARE * mean)
    const along = flat.map(([x]) => x)
    const across = flat.map(([, y]) => y)
    const length = Math.max(...along) - Math.min(...along)
    const width = Math.max(...across) - Math.min(...across)
    const r2 = (x: number): number => Math.round(x * 1000) / 1000
    // a through hole in a hollow part meets the far wall's inside: far past any blind opening's depth for its size
    if (depth > DEEP_SHARE * Math.max(width, length, 2 * mean)) continue
    return round
      ? { at: c, axis: out, round, widthMm: r2(2 * Math.max(...radii)), lengthMm: r2(2 * Math.max(...radii)), depthMm: r2(depth) }
      : { at: c, axis: out, round, widthMm: r2(Math.min(width, length)), lengthMm: r2(Math.max(width, length)), depthMm: r2(depth) }
  }
  return null
}

/** The nearest face a line from `o` along `d` meets, with its distance and outward normal. */
function firstHit(o: V3, d: V3, tris: readonly { p: [V3, V3, V3]; n: V3 }[]): { d: number; n: V3 } | null {
  let best: { d: number; n: V3 } | null = null
  for (const t of tris) {
    const [a, b, c] = t.p
    const e1 = sub(b, a)
    const e2 = sub(c, a)
    const p = cross(d, e2)
    const det = dot(e1, p)
    if (Math.abs(det) < 1e-12) continue
    const s = sub(o, a)
    const uu = dot(s, p) / det
    if (uu < -1e-9 || uu > 1 + 1e-9) continue
    const q = cross(s, e1)
    const vv = dot(d, q) / det
    if (vv < -1e-9 || uu + vv > 1 + 1e-9) continue
    const dist = dot(e2, q) / det
    if (dist > 1e-9 && (!best || dist < best.d)) best = { d: dist, n: t.n }
  }
  return best
}
