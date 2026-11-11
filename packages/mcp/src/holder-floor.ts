// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Whether a part that holds something (a vase, cup, planter or bottle) has a floor, read from its mesh alone: just above
// its lowest face, horizontal rays cross the part, and where one crosses air between the part's own walls, walled in
// across the ray too, and a vertical line there meets no face from the bottom to the top, the cavity opens through the
// bottom. design.check (body-facts.ts) and the build eval scorer read it the same way. Imports nothing, so the scorer
// can use it as is.

type V3 = [number, number, number]

/** A mesh: positions three numbers per vertex, indices three per facet. */
export interface FloorMesh {
  positions: ArrayLike<number>
  indices: ArrayLike<number>
}

/** Where a part's cavity opens through its bottom, as one horizontal ray crosses the opening just above the lowest face. */
export interface FloorOpening {
  /** The part, by index into the meshes read. */
  part: number
  /** The height of the part's lowest face, mm. */
  faceZ: number
  /** The ray's way in and out of the opening, at the height read (just above the lowest face). */
  from: V3
  to: V3
  /** How wide the opening is along the ray, and across it, mm. */
  alongMm: number
  acrossMm: number
}

/** The floor of each part as read: the height of its lowest face, and the openings through its bottom (none: closed). */
export interface FloorReading {
  parts: { faceZ: number; openings: FloorOpening[] }[]
}

/** How far above the lowest face the rays run: the first layer at the finest layer height, mm. */
export const FLOOR_PROBE_MM = 0.2
/** Air narrower than this along a ray is a seam between faces, not an opening, mm. */
const AIR_MIN_MM = 0.05
/** A hole this much wider than the plan's widest is still the plan's: one drawn as facets reads a little off, mm. */
const HOLE_SLACK_MM = 0.2
/** Crossings this close along a ray, the same way, are one crossing met on a shared edge, mm. */
const SAME_HIT_MM = 1e-6
/** The ray ways: 0, 45, 90 and 135 degrees, turned a little so no ray runs along an edge of a regular polygon. */
const TURN = 0.0123
const WAYS = [0, 1, 2, 3].map((k) => (k * Math.PI) / 4 + TURN)
/** The rays of each way: through the middle of the part and a quarter of its width either side. */
const OFFSETS = [-0.25, 0, 0.25]

/**
 * The openings through the bottom of each mesh. `planned` holes no wider than this (mm) are the plan's own, such as a
 * planter's drain holes, and are not openings. An opening is reported once per place: the widest crossing of it.
 */
export function floorOpenings(meshes: readonly FloorMesh[], planned = 0): FloorReading {
  return { parts: meshes.map((m, part) => partFloor(m, part, planned)) }
}

/** The openings of every part together, widest first. */
export const allOpenings = (r: FloorReading): FloorOpening[] => r.parts.flatMap((p) => p.openings).sort((a, b) => b.alongMm - a.alongMm)

function partFloor(m: FloorMesh, part: number, planned: number): { faceZ: number; openings: FloorOpening[] } {
  const tris = Math.floor(m.indices.length / 3)
  const tri = new Float64Array(tris * 9)
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let t = 0; t < tris; t++)
    for (let j = 0; j < 3; j++) {
      const vi = Number(m.indices[t * 3 + j] ?? 0)
      for (let k = 0; k < 3; k++) {
        const v = Number(m.positions[vi * 3 + k] ?? 0)
        tri[t * 9 + j * 3 + k] = v
        if (v < lo[k]!) lo[k] = v
        if (v > hi[k]!) hi[k] = v
      }
    }
  if (!tris || !(hi[2]! > lo[2]!)) return { faceZ: tris ? lo[2]! : 0, openings: [] }
  const faceZ = lo[2]!
  // a hair over the probe height, so no vertex a layer above the bottom sits on it
  const z = faceZ + Math.min(FLOOR_PROBE_MM + 1e-4, (hi[2]! - faceZ) / 2)
  // the facets the probe height passes through: the only ones a horizontal ray there can meet
  const band: number[] = []
  for (let t = 0; t < tris; t++) {
    const b = t * 9
    if (Math.min(tri[b + 2]!, tri[b + 5]!, tri[b + 8]!) <= z && Math.max(tri[b + 2]!, tri[b + 5]!, tri[b + 8]!) >= z) band.push(t)
  }
  const cx = (lo[0]! + hi[0]!) / 2
  const cy = (lo[1]! + hi[1]!) / 2
  const reach = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!) + 1
  const openings: FloorOpening[] = []
  for (const a of WAYS) {
    const d: V3 = [Math.cos(a), Math.sin(a), 0]
    const n: V3 = [-d[1], d[0], 0]
    for (const off of OFFSETS) {
      // through the middle, shifted across by a share of the part's width that way (and a hair more, off any edge)
      const width = Math.abs(n[0]) * (hi[0]! - lo[0]!) + Math.abs(n[1]) * (hi[1]! - lo[1]!)
      const s = off * width + 1e-4 * width
      const o: V3 = [cx + n[0] * s - d[0] * reach, cy + n[1] * s - d[1] * reach, z]
      for (const [t0, t1] of airRuns(tri, band, o, d)) {
        const along = t1 - t0
        const mid: V3 = [o[0] + d[0] * (t0 + t1) / 2, o[1] + d[1] * (t0 + t1) / 2, z]
        // air with a face above or below it is a recess under a floor, or a pocket: the cavity does not open there
        if (!throughLine(tri, mid[0], mid[1])) continue
        const across = acrossRun(tri, band, mid, n, reach)
        // air with no wall on one side across the ray is outside the part, between separate bodies: no cavity there
        if (across === null) continue
        if (planned > 0 && along <= planned + HOLE_SLACK_MM && across <= planned + HOLE_SLACK_MM) continue
        const from: V3 = [o[0] + d[0] * t0, o[1] + d[1] * t0, z]
        const to: V3 = [o[0] + d[0] * t1, o[1] + d[1] * t1, z]
        // the same opening met by another ray: keep the widest crossing
        const same = openings.findIndex((q) => Math.hypot((q.from[0] + q.to[0]) / 2 - mid[0], (q.from[1] + q.to[1]) / 2 - mid[1]) < Math.max(q.alongMm, q.acrossMm, along, across) / 2)
        const found: FloorOpening = { part, faceZ, from, to, alongMm: along, acrossMm: across }
        if (same < 0) openings.push(found)
        else if (along > openings[same]!.alongMm) openings[same] = found
      }
    }
  }
  return { faceZ, openings: openings.sort((p, q) => q.alongMm - p.alongMm) }
}

/**
 * The stretches of a horizontal ray from `o` along `d` that cross air between the part's own walls: each crossing the
 * ray meets turns it into or out of the solid by its facet's normal, and a stretch outside the solid with solid on
 * both sides, at least AIR_MIN_MM long, is air inside the part's outline.
 */
function airRuns(tri: Float64Array, band: readonly number[], o: V3, d: V3): [number, number][] {
  const hits: { t: number; into: boolean }[] = []
  for (const f of band) {
    const t = rayHit(o, d, tri, f * 9)
    if (t <= 0) continue
    const c = facing(tri, f * 9, d)
    if (Math.abs(c) < 1e-9) continue
    hits.push({ t, into: c < 0 })
  }
  hits.sort((a, b) => a.t - b.t)
  // a ray through a shared edge meets both facets: one crossing
  const kept = hits.filter((h, i) => i === 0 || !(h.t - hits[i - 1]!.t < SAME_HIT_MM && h.into === hits[i - 1]!.into))
  const runs: [number, number][] = []
  let depth = 0
  let outAt = -1
  for (const h of kept) {
    if (h.into) {
      if (depth === 0 && outAt >= 0 && h.t - outAt >= AIR_MIN_MM) runs.push([outAt, h.t])
      depth++
    } else {
      depth = Math.max(0, depth - 1)
      if (depth === 0) outAt = h.t
    }
  }
  return runs
}

/**
 * How wide the air around `p` is across the ray (along `n`), mm: from the nearest face one way to the nearest the other.
 * Null when no face is met one way or the other: the air is not walled in across the ray.
 */
function acrossRun(tri: Float64Array, band: readonly number[], p: V3, n: V3, reach: number): number | null {
  let ahead = reach
  let behind = reach
  const back: V3 = [-n[0], -n[1], 0]
  for (const f of band) {
    const a = rayHit(p, n, tri, f * 9)
    if (a > 0 && a < ahead) ahead = a
    const b = rayHit(p, back, tri, f * 9)
    if (b > 0 && b < behind) behind = b
  }
  return ahead < reach && behind < reach ? ahead + behind : null
}

/** Whether the vertical line through (x, y) meets no facet anywhere: the part is open there from its bottom to its top. */
function throughLine(tri: Float64Array, x: number, y: number): boolean {
  const o: V3 = [x, y, 0]
  for (let t = 0; t < tri.length / 9; t++) {
    const b = t * 9
    if (x < Math.min(tri[b]!, tri[b + 3]!, tri[b + 6]!) || x > Math.max(tri[b]!, tri[b + 3]!, tri[b + 6]!)) continue
    if (y < Math.min(tri[b + 1]!, tri[b + 4]!, tri[b + 7]!) || y > Math.max(tri[b + 1]!, tri[b + 4]!, tri[b + 7]!)) continue
    // a line, not a ray: either way along z
    if (rayHit(o, [0, 0, 1], tri, b) !== NONE || rayHit(o, [0, 0, -1], tri, b) !== NONE) return false
  }
  return true
}

/** The cosine between the facet's normal at `tri[at]` and the unit direction `d`: below zero when `d` goes into the solid. */
function facing(tri: Float64Array, at: number, d: V3): number {
  const e10 = tri[at + 3]! - tri[at]!
  const e11 = tri[at + 4]! - tri[at + 1]!
  const e12 = tri[at + 5]! - tri[at + 2]!
  const e20 = tri[at + 6]! - tri[at]!
  const e21 = tri[at + 7]! - tri[at + 1]!
  const e22 = tri[at + 8]! - tri[at + 2]!
  const nx = e11 * e22 - e12 * e21
  const ny = e12 * e20 - e10 * e22
  const nz = e10 * e21 - e11 * e20
  const l = Math.hypot(nx, ny, nz)
  return l > 1e-12 ? (nx * d[0] + ny * d[1] + nz * d[2]) / l : 0
}

const NONE = -1

/** Where a ray from `o` along `d` meets the triangle at `tri[at]`, as its distance along the ray, or NONE (also behind it). */
function rayHit(o: V3, d: V3, tri: Float64Array, at: number): number {
  const a0 = tri[at]!
  const a1 = tri[at + 1]!
  const a2 = tri[at + 2]!
  const e10 = tri[at + 3]! - a0
  const e11 = tri[at + 4]! - a1
  const e12 = tri[at + 5]! - a2
  const e20 = tri[at + 6]! - a0
  const e21 = tri[at + 7]! - a1
  const e22 = tri[at + 8]! - a2
  const p0 = d[1] * e22 - d[2] * e21
  const p1 = d[2] * e20 - d[0] * e22
  const p2 = d[0] * e21 - d[1] * e20
  const det = e10 * p0 + e11 * p1 + e12 * p2
  if (Math.abs(det) < 1e-12) return NONE
  const inv = 1 / det
  const s0 = o[0] - a0
  const s1 = o[1] - a1
  const s2 = o[2] - a2
  const u = (s0 * p0 + s1 * p1 + s2 * p2) * inv
  if (u < -1e-9 || u > 1 + 1e-9) return NONE
  const q0 = s1 * e12 - s2 * e11
  const q1 = s2 * e10 - s0 * e12
  const q2 = s0 * e11 - s1 * e10
  const v = (d[0] * q0 + d[1] * q1 + d[2] * q2) * inv
  if (v < -1e-9 || u + v > 1 + 1e-9) return NONE
  const t = (e20 * q0 + e21 * q1 + e22 * q2) * inv
  return t >= 0 ? t : NONE
}
