// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The facts design.check compares with a plan, read from a design's current body: its bounds (as geom.info gives
// them), whether each part is closed (the engine's info, as geom.info asks it), its round holes (the inner loops of
// its flat faces, as geom.faces finds them, each measured with the engine's hole finder as geom.measure and geom.hole
// do), its feature steps, and its thinnest wall (a ray from each facet inward to the far side, through a grid of the
// facets, within a budget).
import { bakeMesh, type Design as HostDesign, type DesignHost, type HistoryMesh } from '@slicerx/cad-history'
import type { BodyFacts } from './design-check'

type V3 = [number, number, number]
type Mesh = Pick<HistoryMesh, 'positions' | 'indices'>

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2])

const vertex = (m: Mesh, i: number): V3 => [m.positions[i * 3] ?? 0, m.positions[i * 3 + 1] ?? 0, m.positions[i * 3 + 2] ?? 0]
const corners = (m: Mesh, t: number): [V3, V3, V3] => [vertex(m, m.indices[t * 3] ?? 0), vertex(m, m.indices[t * 3 + 1] ?? 0), vertex(m, m.indices[t * 3 + 2] ?? 0)]

/** The facts about the design's body now. */
export async function bodyFacts(host: DesignHost, d: HostDesign): Promise<BodyFacts> {
  const world = d.parts.map((p) => bakeMesh(p, d.transform))
  let watertight = d.parts.length > 0
  for (const w of world) {
    const info = await host.call('info', { mesh: { positions: Array.from(w.positions), indices: Array.from(w.indices) } })
    if ((info as { watertight?: unknown }).watertight !== true) watertight = false
  }
  const holes: { part: number; at: V3; axis: V3; diameterMm: number }[] = []
  for (const [part, w] of world.entries()) {
    const loops = holeLoops(w)
    if (loops.length === 0) continue
    // the part as the engine takes it, copied once for all of its holes
    const mesh = { positions: Array.from(d.parts[part]!.positions), indices: Array.from(d.parts[part]!.indices) }
    for (const loop of loops) {
      let diameterMm = loop.diameterMm
      try {
        // the request geom.hole makes for a hole picked by its axis: the part with the object's transform
        const found = (await host.call('hole.find', { mesh: { mesh, transform: d.transform }, at: loop.at, axis: loop.axis })) as { diameterMm?: unknown }
        if (typeof found.diameterMm === 'number' && Number.isFinite(found.diameterMm)) diameterMm = found.diameterMm
      } catch {
        // the engine finds no hole on that line (a pocket it does not take, say): the loop's own size stands
      }
      holes.push({ part, at: loop.at, axis: loop.axis, diameterMm })
    }
  }
  const wall = minWall(world)
  return {
    size: bounds(world),
    holes: sameHoles(holes).map((h) => ({ diameterMm: h.diameterMm })),
    features: d.history.steps.filter((s) => !s.suppressed && s.params.op !== 'paint').length,
    watertight,
    minWallMm: wall.mm,
    ...(wall.why ? { minWallWhy: wall.why } : {}),
  }
}

/** The size of the bounds of the meshes together, zero with no triangles. */
function bounds(meshes: readonly Mesh[]): BodyFacts['size'] {
  const lo: V3 = [Infinity, Infinity, Infinity]
  const hi: V3 = [-Infinity, -Infinity, -Infinity]
  for (const m of meshes)
    for (let j = 0; j < m.indices.length; j++) {
      const v = vertex(m, m.indices[j] ?? 0)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, v[k]!)
        hi[k] = Math.max(hi[k]!, v[k]!)
      }
    }
  const r = (k: number): number => (hi[k]! >= lo[k]! ? Math.round((hi[k]! - lo[k]!) * 1000) / 1000 : 0)
  return { x: r(0), y: r(1), z: r(2) }
}

/** A hole seen at one end, and the same hole at its other end, are one hole: the narrower reading stands. */
function sameHoles<H extends { part: number; at: V3; axis: V3; diameterMm: number }>(found: readonly H[]): H[] {
  const out: H[] = []
  for (const h of found) {
    const k = out.findIndex((o) => {
      if (o.part !== h.part || Math.abs(Math.abs(dot(o.axis, h.axis)) - 1) > 1e-3) return false
      const off = sub(h.at, o.at)
      const across = len(sub(off, scale(o.axis, dot(off, o.axis))))
      return across <= Math.max(0.05, 0.1 * Math.min(o.diameterMm, h.diameterMm))
    })
    if (k < 0) out.push(h)
    else if (h.diameterMm < out[k]!.diameterMm) out[k] = h
  }
  return out
}

/** Points closer than this are one vertex: STL coordinates are float32. */
const WELD_MM = 1e-4
const keyOf = (v: V3): string => `${Math.round(v[0] / WELD_MM)},${Math.round(v[1] / WELD_MM)},${Math.round(v[2] / WELD_MM)}`

/**
 * The round holes that open on the mesh's flat faces: each face's inner boundary loops (they run clockwise seen from
 * outside) that lie on a circle and whose walls face in toward the center, with a point on the axis (the loop's
 * center), the axis out of the hole and the circle's diameter.
 */
export function holeLoops(m: Mesh): { at: V3; axis: V3; diameterMm: number }[] {
  const tris = m.indices.length / 3
  const normals: (V3 | undefined)[] = []
  const keys: [string, string, string][] = []
  const pos = new Map<string, V3>()
  // every directed edge of the mesh, to find the face across a boundary edge
  const across = new Map<string, number>()
  for (let t = 0; t < tris; t++) {
    const c = corners(m, t)
    const n = cross(sub(c[1], c[0]), sub(c[2], c[0]))
    const l = len(n)
    normals.push(l > 1e-12 ? scale(n, 1 / l) : undefined)
    const k = c.map(keyOf) as [string, string, string]
    keys.push(k)
    c.forEach((v, j) => pos.set(k[j]!, v))
    for (let j = 0; j < 3; j++) across.set(`${k[j]}>${k[(j + 1) % 3]}`, t)
  }
  // flat faces: triangles on one plane facing one way
  const planes = new Map<string, number[]>()
  for (let t = 0; t < tris; t++) {
    const n = normals[t]
    if (!n) continue
    const at = pos.get(keys[t]![0])!
    const id = `${n.map((c) => Math.round(c * 1000)).join(',')}|${Math.round(dot(n, at) * 1000)}`
    const list = planes.get(id)
    if (list) list.push(t)
    else planes.set(id, [t])
  }
  const out: { at: V3; axis: V3; diameterMm: number }[] = []
  for (const group of planes.values()) {
    const n = normals[group[0]!]!
    const inFace = new Set<string>()
    for (const t of group) for (let j = 0; j < 3; j++) inFace.add(`${keys[t]![j]}>${keys[t]![(j + 1) % 3]}`)
    // boundary edges: a directed edge whose reverse is not in the face
    const next = new Map<string, string>()
    for (const e of inFace) {
      const [a, b] = e.split('>') as [string, string]
      if (!inFace.has(`${b}>${a}`)) next.set(a, b)
    }
    const seen = new Set<string>()
    for (const start of next.keys()) {
      if (seen.has(start)) continue
      const loop: string[] = []
      let at: string | undefined = start
      while (at !== undefined && !seen.has(at)) {
        seen.add(at)
        loop.push(at)
        at = next.get(at)
      }
      if (at !== start || loop.length < 8) continue
      const hole = roundHole(loop.map((k) => pos.get(k)!), n)
      if (!hole) continue
      // its walls face in toward the center: a hole, not a boss standing on the face
      const [a, b] = [loop[0]!, loop[1]!]
      const wall = across.get(`${b}>${a}`)
      const wn = wall === undefined ? undefined : normals[wall]
      const mid = scale([...pos.get(a)!].map((c, k) => c + pos.get(b)![k]!) as V3, 0.5)
      if (!wn || dot(wn, sub(hole.at, mid)) <= 0) continue
      out.push({ ...hole, axis: n })
    }
  }
  return out
}

/** A closed loop on a plane (normal n) that runs clockwise seen from n and lies on a circle: its center and diameter. */
function roundHole(points: readonly V3[], n: V3): { at: V3; diameterMm: number } | null {
  const u0: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u = cross(n, u0)
  const ul = len(u)
  const uu = scale(u, 1 / ul)
  const v = cross(n, uu)
  const flat = points.map((p) => [dot(p, uu), dot(p, v)] as [number, number])
  let area = 0
  for (let k = 0; k < flat.length; k++) {
    const [a, b] = [flat[k]!, flat[(k + 1) % flat.length]!]
    area += a[0] * b[1] - b[0] * a[1]
  }
  if (area >= 0) return null
  const at = scale(points.reduce<V3>((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]), 1 / points.length)
  const radii = points.map((p) => len(sub(sub(p, at), scale(n, dot(sub(p, at), n)))))
  const most = Math.max(...radii)
  const least = Math.min(...radii)
  // a polygon's corners lie on its circle; an edge split on the way is a little inside it
  if (most <= 0 || (most - least) / most > 0.03) return null
  return { at, diameterMm: 2 * most }
}

/** How much work the thinnest wall may take. Past it the wall is reported as not measured, never as a guess. */
export interface WallBudget {
  /** Facets over every part together. */
  maxFacets: number
  /** Wall-clock time in ms (the app measures on its main thread). */
  maxMs: number
}
export const WALL_BUDGET: WallBudget = { maxFacets: 250_000, maxMs: 1500 }

/** The thinnest wall, in mm, or null with the reason when it was not measured (null alone: no ray met a far side). */
export interface WallReading {
  mm: number | null
  why?: string
}

const TOO_DENSE = 'part too dense'
/** Grid cells per part at most, and facet entries over all cells (a facet is listed in each cell its bounds cross). */
const MAX_CELLS = 1 << 21
const MAX_ENTRIES = 4_000_000

/**
 * The thinnest wall: from the center of every facet a ray goes in, against its outward normal, to the first facet of
 * the same part it meets on the far side. The shortest such distance over every part. Each part's facets sit in a
 * uniform grid, so a ray only tests the facets of the cells it passes through. Over the budget (too many facets, or too
 * long) the reading is null with why "part too dense".
 */
export function minWall(meshes: readonly Mesh[], budget: WallBudget = WALL_BUDGET, now: () => number = Date.now): WallReading {
  const facets = meshes.reduce((n, m) => n + Math.floor(m.indices.length / 3), 0)
  if (facets > budget.maxFacets) return { mm: null, why: TOO_DENSE }
  const start = now()
  const late = (): boolean => now() - start > budget.maxMs
  if (late()) return { mm: null, why: TOO_DENSE }
  let best = Infinity
  for (const m of meshes) {
    const r = partWall(m, best, late)
    if (r === null) return { mm: null, why: TOO_DENSE }
    best = r
  }
  return { mm: Number.isFinite(best) ? Math.round(best * 1000) / 1000 : null }
}

/** The thinnest wall of one part, no more than `bestSoFar`; null when `late` says the time ran out. */
function partWall(m: Mesh, bestSoFar: number, late: () => boolean): number | null {
  const tris = Math.floor(m.indices.length / 3)
  if (tris === 0) return bestSoFar
  // every facet's corners, nine numbers each
  const tri = new Float64Array(tris * 9)
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let t = 0; t < tris; t++)
    for (let j = 0; j < 3; j++) {
      const vi = m.indices[t * 3 + j] ?? 0
      for (let k = 0; k < 3; k++) {
        const v = m.positions[vi * 3 + k] ?? 0
        tri[t * 9 + j * 3 + k] = v
        if (v < lo[k]!) lo[k] = v
        if (v > hi[k]!) hi[k] = v
      }
    }
  const span = Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!, 1e-9)
  const pad = span * 1e-6
  const ext = [0, 1, 2].map((k) => Math.max(hi[k]! - lo[k]!, span * 1e-3))
  // about one facet per cell, coarser until the cells and the entries fit
  let h = Math.cbrt((ext[0]! * ext[1]! * ext[2]!) / Math.min(tris, MAX_CELLS))
  let n0 = 1
  let n1 = 1
  let n2 = 1
  let cs0 = ext[0]!
  let cs1 = ext[1]!
  let cs2 = ext[2]!
  const cell = (v: number, k: number, size: number, count: number): number => Math.min(count - 1, Math.max(0, Math.floor((v - lo[k]!) / size)))
  const range = (t: number, k: number, size: number, count: number): [number, number] => {
    const b = t * 9 + k
    const a = Math.min(tri[b]!, tri[b + 3]!, tri[b + 6]!)
    const z = Math.max(tri[b]!, tri[b + 3]!, tri[b + 6]!)
    return [cell(a - pad, k, size, count), cell(z + pad, k, size, count)]
  }
  let entries = 0
  for (;;) {
    n0 = Math.max(1, Math.ceil(ext[0]! / h))
    n1 = Math.max(1, Math.ceil(ext[1]! / h))
    n2 = Math.max(1, Math.ceil(ext[2]! / h))
    cs0 = ext[0]! / n0
    cs1 = ext[1]! / n1
    cs2 = ext[2]! / n2
    const cells = n0 * n1 * n2
    if (cells > MAX_CELLS) {
      h *= 1.26
      continue
    }
    entries = 0
    for (let t = 0; t < tris; t++) {
      const [a0, z0] = range(t, 0, cs0, n0)
      const [a1, z1] = range(t, 1, cs1, n1)
      const [a2, z2] = range(t, 2, cs2, n2)
      entries += (z0 - a0 + 1) * (z1 - a1 + 1) * (z2 - a2 + 1)
    }
    if (entries > MAX_ENTRIES && cells > 1) {
      h *= 1.26
      continue
    }
    break
  }
  // the facets of each cell, in one list: cell c holds items[start[c]] up to items[start[c + 1]]
  const cells = n0 * n1 * n2
  const start = new Int32Array(cells + 1)
  const items = new Int32Array(entries)
  for (let pass = 0; pass < 2; pass++) {
    const fill = pass === 1 ? start.slice(0, cells) : null
    for (let t = 0; t < tris; t++) {
      const [a0, z0] = range(t, 0, cs0, n0)
      const [a1, z1] = range(t, 1, cs1, n1)
      const [a2, z2] = range(t, 2, cs2, n2)
      for (let c2 = a2; c2 <= z2; c2++)
        for (let c1 = a1; c1 <= z1; c1++)
          for (let c0 = a0; c0 <= z0; c0++) {
            const c = (c2 * n1 + c1) * n0 + c0
            if (fill) items[fill[c]!++] = t
            else start[c + 1]!++
          }
    }
    if (pass === 0) for (let c = 0; c < cells; c++) start[c + 1] = start[c + 1]! + start[c]!
  }
  // the ray each facet was last tested against, so a facet in several cells is tested once per ray
  const tested = new Int32Array(tris).fill(-1)
  let best = bestSoFar
  for (let t = 0; t < tris; t++) {
    if ((t & 255) === 0 && late()) return null
    const b = t * 9
    const e10 = tri[b + 3]! - tri[b]!
    const e11 = tri[b + 4]! - tri[b + 1]!
    const e12 = tri[b + 5]! - tri[b + 2]!
    const e20 = tri[b + 6]! - tri[b]!
    const e21 = tri[b + 7]! - tri[b + 1]!
    const e22 = tri[b + 8]! - tri[b + 2]!
    const nx = e11 * e22 - e12 * e21
    const ny = e12 * e20 - e10 * e22
    const nz = e10 * e21 - e11 * e20
    const l = Math.hypot(nx, ny, nz)
    if (l < 1e-12) continue
    const d0 = -nx / l
    const d1 = -ny / l
    const d2 = -nz / l
    const o0 = (tri[b]! + tri[b + 3]! + tri[b + 6]!) / 3
    const o1 = (tri[b + 1]! + tri[b + 4]! + tri[b + 7]!) / 3
    const o2 = (tri[b + 2]! + tri[b + 5]! + tri[b + 8]!) / 3
    // walk the cells the ray passes through, nearest first (Amanatides and Woo)
    let i0 = cell(o0, 0, cs0, n0)
    let i1 = cell(o1, 1, cs1, n1)
    let i2 = cell(o2, 2, cs2, n2)
    const s0 = d0 > 0 ? 1 : -1
    const s1 = d1 > 0 ? 1 : -1
    const s2 = d2 > 0 ? 1 : -1
    let t0 = d0 !== 0 ? (lo[0]! + (i0 + (d0 > 0 ? 1 : 0)) * cs0 - o0) / d0 : Infinity
    let t1 = d1 !== 0 ? (lo[1]! + (i1 + (d1 > 0 ? 1 : 0)) * cs1 - o1) / d1 : Infinity
    let t2 = d2 !== 0 ? (lo[2]! + (i2 + (d2 > 0 ? 1 : 0)) * cs2 - o2) / d2 : Infinity
    const dt0 = d0 !== 0 ? cs0 / Math.abs(d0) : Infinity
    const dt1 = d1 !== 0 ? cs1 / Math.abs(d1) : Infinity
    const dt2 = d2 !== 0 ? cs2 / Math.abs(d2) : Infinity
    let hit = Infinity
    for (;;) {
      const c = (i2 * n1 + i1) * n0 + i0
      for (let q = start[c]!; q < start[c + 1]!; q++) {
        const f = items[q]!
        if (f === t || tested[f] === t) continue
        tested[f] = t
        const d = rayHit(o0, o1, o2, d0, d1, d2, tri, f * 9)
        if (d > 1e-6 && d < hit) hit = d
      }
      const exit = Math.min(t0, t1, t2)
      // a hit inside the cells walked so far is the first; a cell past the best wall cannot beat it
      if (hit <= exit || exit >= best) break
      if (t0 === exit) {
        i0 += s0
        if (i0 < 0 || i0 >= n0) break
        t0 += dt0
      } else if (t1 === exit) {
        i1 += s1
        if (i1 < 0 || i1 >= n1) break
        t1 += dt1
      } else {
        i2 += s2
        if (i2 < 0 || i2 >= n2) break
        t2 += dt2
      }
    }
    if (hit < best) best = hit
  }
  return best
}

/** Where a ray meets the triangle at `tri[at]` (nine numbers), as its distance along the ray (Moller and Trumbore), or -1. */
function rayHit(f0: number, f1: number, f2: number, d0: number, d1: number, d2: number, tri: Float64Array, at: number): number {
  const a0 = tri[at]!
  const a1 = tri[at + 1]!
  const a2 = tri[at + 2]!
  const e10 = tri[at + 3]! - a0
  const e11 = tri[at + 4]! - a1
  const e12 = tri[at + 5]! - a2
  const e20 = tri[at + 6]! - a0
  const e21 = tri[at + 7]! - a1
  const e22 = tri[at + 8]! - a2
  // p = dir x e2
  const p0 = d1 * e22 - d2 * e21
  const p1 = d2 * e20 - d0 * e22
  const p2 = d0 * e21 - d1 * e20
  const det = e10 * p0 + e11 * p1 + e12 * p2
  if (Math.abs(det) < 1e-12) return -1
  const inv = 1 / det
  const s0 = f0 - a0
  const s1 = f1 - a1
  const s2 = f2 - a2
  const u = (s0 * p0 + s1 * p1 + s2 * p2) * inv
  if (u < -1e-9 || u > 1 + 1e-9) return -1
  // q = s x e1
  const q0 = s1 * e12 - s2 * e11
  const q1 = s2 * e10 - s0 * e12
  const q2 = s0 * e11 - s1 * e10
  const v = (d0 * q0 + d1 * q1 + d2 * q2) * inv
  if (v < -1e-9 || u + v > 1 + 1e-9) return -1
  return (e20 * q0 + e21 * q1 + e22 * q2) * inv
}
