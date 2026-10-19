// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The facts design.check compares with a plan, read from a design's current body: its bounds (as geom.info gives
// them), whether each part is closed (the engine's info, as geom.info asks it), its round holes (the inner loops of
// its flat faces, as geom.faces finds them, each measured with the engine's hole finder as geom.measure and geom.hole
// do), its feature steps, and its thinnest wall (a ray from each facet inward to the far side).
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
    for (const loop of holeLoops(w)) {
      let diameterMm = loop.diameterMm
      try {
        const mesh = { positions: Array.from(d.parts[part]!.positions), indices: Array.from(d.parts[part]!.indices) }
        // the request geom.hole makes for a hole picked by its axis: the part with the object's transform
        const found = (await host.call('hole.find', { mesh: { mesh, transform: d.transform }, at: loop.at, axis: loop.axis })) as { diameterMm?: unknown }
        if (typeof found.diameterMm === 'number' && Number.isFinite(found.diameterMm)) diameterMm = found.diameterMm
      } catch {
        // the engine finds no hole on that line (a pocket it does not take, say): the loop's own size stands
      }
      holes.push({ part, at: loop.at, axis: loop.axis, diameterMm })
    }
  }
  return {
    size: bounds(world),
    holes: sameHoles(holes).map((h) => ({ diameterMm: h.diameterMm })),
    features: d.history.steps.filter((s) => !s.suppressed && s.params.op !== 'paint').length,
    watertight,
    minWallMm: minWall(world),
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

/** Facets cast from, per part: more than this and every few facets cast, all of them still hit. */
const MAX_CASTS = 6000

/**
 * The thinnest wall: from the center of each facet a ray goes in, against its outward normal, to the first facet of
 * the same part it meets on the far side. The shortest such distance over every part; null when no ray hits.
 */
export function minWall(meshes: readonly Mesh[]): number | null {
  let best = Infinity
  for (const m of meshes) {
    const tris = m.indices.length / 3
    const all = Array.from({ length: tris }, (_, t) => corners(m, t))
    const boxes = all.map((c) => [Math.min(c[0][0], c[1][0], c[2][0]), Math.min(c[0][1], c[1][1], c[2][1]), Math.min(c[0][2], c[1][2], c[2][2]), Math.max(c[0][0], c[1][0], c[2][0]), Math.max(c[0][1], c[1][1], c[2][1]), Math.max(c[0][2], c[1][2], c[2][2])] as const)
    const step = Math.max(1, Math.ceil(tris / MAX_CASTS))
    for (let t = 0; t < tris; t += step) {
      const c = all[t]!
      const n = cross(sub(c[1], c[0]), sub(c[2], c[0]))
      const l = len(n)
      if (l < 1e-12) continue
      const dir = scale(n, -1 / l)
      const from: V3 = [(c[0][0] + c[1][0] + c[2][0]) / 3, (c[0][1] + c[1][1] + c[2][1]) / 3, (c[0][2] + c[1][2] + c[2][2]) / 3]
      for (let o = 0; o < tris; o++) {
        if (o === t) continue
        const b = boxes[o]!
        // the ray's reach so far, against the facet's bounds, before the exact test
        const reach = Math.min(best, 1e9)
        let skip = false
        for (let k = 0; k < 3 && !skip; k++) {
          const lo = Math.min(from[k]!, from[k]! + dir[k]! * reach)
          const hi = Math.max(from[k]!, from[k]! + dir[k]! * reach)
          if (hi < b[k]! - 1e-6 || lo > b[k + 3]! + 1e-6) skip = true
        }
        if (skip) continue
        const d = rayHit(from, dir, all[o]!)
        if (d !== null && d > 1e-6 && d < best) best = d
      }
    }
  }
  return Number.isFinite(best) ? Math.round(best * 1000) / 1000 : null
}

/** Where a ray meets a triangle, as its distance along the ray (Moller and Trumbore), or null. */
function rayHit(from: V3, dir: V3, [a, b, c]: [V3, V3, V3]): number | null {
  const e1 = sub(b, a)
  const e2 = sub(c, a)
  const p = cross(dir, e2)
  const det = dot(e1, p)
  if (Math.abs(det) < 1e-12) return null
  const inv = 1 / det
  const s = sub(from, a)
  const u = dot(s, p) * inv
  if (u < -1e-9 || u > 1 + 1e-9) return null
  const q = cross(s, e1)
  const v = dot(dir, q) * inv
  if (v < -1e-9 || u + v > 1 + 1e-9) return null
  return dot(e2, q) * inv
}
