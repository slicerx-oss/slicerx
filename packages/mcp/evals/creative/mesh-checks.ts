// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Mesh checks for the creative prompt set, in plain TypeScript over the parts a design tool added, so they run
// without the geometry engine: closed shells, body count, thinnest wall, bed fit and the gap between moving bodies.
import type { MeshPart } from '@slicerx/contracts'

type V3 = [number, number, number]

/** Vertices closer than this are the same vertex, mm. */
const WELD_MM = 1e-4

/** A part's triangles with welded vertex ids, so seams in the vertex list do not read as open edges. */
interface Welded {
  /** xyz per welded vertex. */
  pos: number[]
  /** Three welded vertex ids per triangle, degenerate triangles dropped. */
  tri: number[]
}

function weld(part: MeshPart): Welded {
  const ids = new Map<string, number>()
  const pos: number[] = []
  const P = part.positions
  const map: number[] = []
  for (let v = 0; v * 3 + 2 < P.length; v++) {
    const x = P[v * 3] ?? 0
    const y = P[v * 3 + 1] ?? 0
    const z = P[v * 3 + 2] ?? 0
    const key = `${Math.round(x / WELD_MM)},${Math.round(y / WELD_MM)},${Math.round(z / WELD_MM)}`
    let id = ids.get(key)
    if (id === undefined) {
      id = pos.length / 3
      ids.set(key, id)
      pos.push(x, y, z)
    }
    map.push(id)
  }
  const tri: number[] = []
  for (let t = 0; t + 2 < part.indices.length; t += 3) {
    const a = map[part.indices[t] ?? 0] ?? 0
    const b = map[part.indices[t + 1] ?? 0] ?? 0
    const c = map[part.indices[t + 2] ?? 0] ?? 0
    if (a !== b && b !== c && a !== c) tri.push(a, b, c)
  }
  return { pos, tri }
}

const vtx = (w: Welded, i: number): V3 => [w.pos[i * 3] ?? 0, w.pos[i * 3 + 1] ?? 0, w.pos[i * 3 + 2] ?? 0]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2])

function corners(w: Welded, t: number): [V3, V3, V3] {
  return [vtx(w, w.tri[t * 3] ?? 0), vtx(w, w.tri[t * 3 + 1] ?? 0), vtx(w, w.tri[t * 3 + 2] ?? 0)]
}

// ---------------------------------------------------------------------------
// Closed shells

export interface Closure {
  watertight: boolean
  /** Edges with one triangle. */
  openEdges: number
  /** Edges with more than two triangles. */
  nonManifoldEdges: number
  /** Edges whose two triangles run the same way, so one of them faces the wrong side. */
  flippedEdges: number
}

/** Every edge shared by exactly two triangles that run it in opposite directions, as the engine's own check. */
export function closure(parts: MeshPart[]): Closure {
  let open = 0
  let nonManifold = 0
  let flipped = 0
  let triangles = 0
  for (const part of parts) {
    const w = weld(part)
    triangles += w.tri.length / 3
    // Per undirected edge: how many times each direction is used.
    const edges = new Map<string, [number, number]>()
    for (let t = 0; t < w.tri.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = w.tri[t + k] ?? 0
        const b = w.tri[t + ((k + 1) % 3)] ?? 0
        const key = a < b ? `${a},${b}` : `${b},${a}`
        const e = edges.get(key) ?? [0, 0]
        e[a < b ? 0 : 1]++
        edges.set(key, e)
      }
    }
    for (const [fwd, back] of edges.values()) {
      const n = fwd + back
      if (n === 1) open++
      else if (n > 2) nonManifold++
      else if (fwd !== 1) flipped++
    }
  }
  return { watertight: triangles > 0 && open === 0 && nonManifold === 0 && flipped === 0, openEdges: open, nonManifoldEdges: nonManifold, flippedEdges: flipped }
}

// ---------------------------------------------------------------------------
// Bodies

/** One connected shell of a part that encloses material (a void's inner shell is not a body). */
export interface Body {
  part: number
  /** Triangle indices into the part's welded triangles. */
  tris: number[]
  volumeMm3: number
  min: V3
  max: V3
}

interface Split {
  welded: Welded[]
  bodies: Body[]
}

/** The connected shells of every part. Shells with negative volume are voids inside another shell and are dropped. */
function split(parts: MeshPart[]): Split {
  const welded = parts.map(weld)
  const bodies: Body[] = []
  for (const [pi, w] of welded.entries()) {
    const n = w.pos.length / 3
    const parent = Array.from({ length: n }, (_, i) => i)
    const find = (i: number): number => {
      let r = i
      while ((parent[r] ?? r) !== r) r = parent[r] ?? r
      let c = i
      while ((parent[c] ?? c) !== r) {
        const next = parent[c] ?? c
        parent[c] = r
        c = next
      }
      return r
    }
    for (let t = 0; t < w.tri.length; t += 3) {
      const a = find(w.tri[t] ?? 0)
      parent[find(w.tri[t + 1] ?? 0)] = a
      parent[find(w.tri[t + 2] ?? 0)] = a
    }
    const shells = new Map<number, number[]>()
    for (let t = 0; t < w.tri.length / 3; t++) {
      const root = find(w.tri[t * 3] ?? 0)
      const list = shells.get(root) ?? []
      list.push(t)
      shells.set(root, list)
    }
    for (const tris of shells.values()) {
      let v = 0
      const min: V3 = [Infinity, Infinity, Infinity]
      const max: V3 = [-Infinity, -Infinity, -Infinity]
      for (const t of tris) {
        const [a, b, c] = corners(w, t)
        v += dot(a, cross(b, c)) / 6
        for (const p of [a, b, c]) for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k] ?? 0, p[k] ?? 0)
          max[k] = Math.max(max[k] ?? 0, p[k] ?? 0)
        }
      }
      if (v > 0) bodies.push({ part: pi, tris, volumeMm3: v, min, max })
    }
  }
  return { welded, bodies }
}

/** Separate solid bodies across all parts: what a person counts as pieces on the plate. */
export function bodyCount(parts: MeshPart[]): number {
  return split(parts).bodies.length
}

// ---------------------------------------------------------------------------
// Walls

/** Distance along the ray to a triangle, or Infinity (Moller and Trumbore). */
function rayHit(o: V3, d: V3, a: V3, b: V3, c: V3): number {
  const e1 = sub(b, a)
  const e2 = sub(c, a)
  const p = cross(d, e2)
  const det = dot(e1, p)
  if (Math.abs(det) < 1e-12) return Infinity
  const inv = 1 / det
  const s = sub(o, a)
  const u = dot(s, p) * inv
  if (u < 0 || u > 1) return Infinity
  const q = cross(s, e1)
  const v = dot(d, q) * inv
  if (v < 0 || u + v > 1) return Infinity
  const t = dot(e2, q) * inv
  return t > 1e-6 ? t : Infinity
}

export interface WallReport {
  /** The thinnest wall found, as the low percentile of the samples (single corner rays do not decide it), mm. */
  minWallMm: number
  samples: number
}

/** Low percentile of the thickness samples that counts as the wall: thin regions win, one stray corner ray does not. */
const WALL_PERCENTILE = 0.02

/**
 * Wall thickness the way a slicer meets it: from points spread over the surface (area weighted, the same points every
 * run), a ray goes straight in and the distance to where it leaves the material is the local thickness.
 */
export function minWall(parts: MeshPart[], maxSamples = 600): WallReport {
  const thick: number[] = []
  for (const part of parts) {
    const w = weld(part)
    const n = w.tri.length / 3
    if (!n) continue
    const area: number[] = []
    let total = 0
    for (let t = 0; t < n; t++) {
      const [a, b, c] = corners(w, t)
      const ar = len(cross(sub(b, a), sub(c, a))) / 2
      area.push(ar)
      total += ar
    }
    if (total <= 0) continue
    // Evenly spaced picks along the cumulative area: deterministic and area weighted.
    const want = Math.min(maxSamples, n)
    const step = total / want
    let next = step / 2
    let acc = 0
    for (let t = 0; t < n; t++) {
      acc += area[t] ?? 0
      while (next <= acc) {
        next += step
        const [a, b, c] = corners(w, t)
        const nrm = cross(sub(b, a), sub(c, a))
        const l = len(nrm)
        if (l === 0) continue
        const d: V3 = [-nrm[0] / l, -nrm[1] / l, -nrm[2] / l]
        const o: V3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]
        let best = Infinity
        for (let u = 0; u < n; u++) {
          if (u === t) continue
          const [p, q, r] = corners(w, u)
          const h = rayHit(o, d, p, q, r)
          if (h < best) best = h
        }
        if (Number.isFinite(best)) thick.push(best)
      }
    }
  }
  if (!thick.length) return { minWallMm: 0, samples: 0 }
  thick.sort((x, y) => x - y)
  const at = Math.min(thick.length - 1, Math.floor(thick.length * WALL_PERCENTILE))
  return { minWallMm: Math.round((thick[at] ?? 0) * 1000) / 1000, samples: thick.length }
}

// ---------------------------------------------------------------------------
// Bed

export type BuildVolume = { shape: 'rectangular'; x: number; y: number; z: number } | { shape: 'circular'; diameter: number; z: number }

export interface BedFit {
  fits: boolean
  sizeMm: V3
}

/** Whether the parts' bounding box fits the build volume, turned a quarter turn on the bed if that helps. */
export function bedFit(parts: MeshPart[], bed: BuildVolume): BedFit {
  const min: V3 = [Infinity, Infinity, Infinity]
  const max: V3 = [-Infinity, -Infinity, -Infinity]
  for (const p of parts) for (let i = 0; i + 2 < p.positions.length; i += 3) for (let k = 0; k < 3; k++) {
    const v = p.positions[i + k] ?? 0
    min[k] = Math.min(min[k] ?? 0, v)
    max[k] = Math.max(max[k] ?? 0, v)
  }
  if (!Number.isFinite(min[0])) return { fits: false, sizeMm: [0, 0, 0] }
  const size: V3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  const r = (v: number): number => Math.round(v * 100) / 100
  const sizeMm: V3 = [r(size[0]), r(size[1]), r(size[2])]
  const eps = 1e-6
  if (size[2] > bed.z + eps) return { fits: false, sizeMm }
  if (bed.shape === 'circular') return { fits: Math.hypot(size[0], size[1]) <= bed.diameter + eps, sizeMm }
  const fits = (size[0] <= bed.x + eps && size[1] <= bed.y + eps) || (size[1] <= bed.x + eps && size[0] <= bed.y + eps)
  return { fits, sizeMm }
}

// ---------------------------------------------------------------------------
// Moving gaps

/** Closest point on a triangle to p (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(p: V3, a: V3, b: V3, c: V3): V3 {
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
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    return [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]]
  }
  const cp = sub(p, c)
  const d5 = dot(ab, cp)
  const d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return c
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    return [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]]
  }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
    return [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])]
  }
  const denom = 1 / (va + vb + vc)
  const v = vb * denom
  const w = vc * denom
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]
}

/** A body's triangles bucketed on a coarse grid, for distance queries within a few millimeters. */
class TriGrid {
  private cells = new Map<string, number[]>()
  constructor(
    readonly w: Welded,
    readonly body: Body,
    readonly cell: number,
  ) {
    for (const t of body.tris) {
      const [a, b, c] = corners(w, t)
      const lo = [0, 1, 2].map((k) => Math.floor(Math.min(a[k] ?? 0, b[k] ?? 0, c[k] ?? 0) / cell))
      const hi = [0, 1, 2].map((k) => Math.floor(Math.max(a[k] ?? 0, b[k] ?? 0, c[k] ?? 0) / cell))
      for (let i = lo[0] ?? 0; i <= (hi[0] ?? 0); i++) for (let j = lo[1] ?? 0; j <= (hi[1] ?? 0); j++) for (let k = lo[2] ?? 0; k <= (hi[2] ?? 0); k++) {
        const key = `${i},${j},${k}`
        const list = this.cells.get(key) ?? []
        list.push(t)
        this.cells.set(key, list)
      }
    }
  }

  /** Signed distance from p to the body's surface within `reach`: negative when p is inside it. Infinity when farther. */
  signedDistance(p: V3, reach: number): number {
    const lo = p.map((v) => Math.floor((v - reach) / this.cell))
    const hi = p.map((v) => Math.floor((v + reach) / this.cell))
    let best = Infinity
    let sign = 1
    const seen = new Set<number>()
    for (let i = lo[0] ?? 0; i <= (hi[0] ?? 0); i++) for (let j = lo[1] ?? 0; j <= (hi[1] ?? 0); j++) for (let k = lo[2] ?? 0; k <= (hi[2] ?? 0); k++) {
      for (const t of this.cells.get(`${i},${j},${k}`) ?? []) {
        if (seen.has(t)) continue
        seen.add(t)
        const [a, b, c] = corners(this.w, t)
        const q = closestOnTriangle(p, a, b, c)
        const d = len(sub(p, q))
        if (d < best) {
          best = d
          sign = dot(sub(p, q), cross(sub(b, a), sub(c, a))) < 0 ? -1 : 1
        }
      }
    }
    return best <= reach ? sign * best : Infinity
  }
}

export interface GapReport {
  /** Pairs of bodies that come within `reachMm` of each other: the joints and meshes that must move. */
  pairs: number
  /** Smallest gap between any such pair, mm; negative when bodies overlap. null when no bodies come that close. */
  minGapMm: number | null
}

/**
 * The smallest gap between separate bodies that come close enough to be meant to move against each other (hinge
 * knuckles, meshing teeth, links). Samples every vertex and triangle center of one body against the other's surface,
 * both ways.
 */
export function movingGaps(parts: MeshPart[], reachMm = 2): GapReport {
  const { welded, bodies } = split(parts)
  const cell = Math.max(1, reachMm * 2)
  const grids = new Map<Body, TriGrid>()
  const grid = (b: Body): TriGrid => {
    let g = grids.get(b)
    if (!g) {
      g = new TriGrid(welded[b.part] ?? { pos: [], tri: [] }, b, cell)
      grids.set(b, g)
    }
    return g
  }
  const near = (a: Body, b: Body): boolean => [0, 1, 2].every((k) => (a.min[k] ?? 0) - reachMm <= (b.max[k] ?? 0) && (b.min[k] ?? 0) - reachMm <= (a.max[k] ?? 0))
  const samples = (b: Body): V3[] => {
    const w = welded[b.part]
    if (!w) return []
    const out: V3[] = []
    const verts = new Set<number>()
    for (const t of b.tris) {
      for (let k = 0; k < 3; k++) verts.add(w.tri[t * 3 + k] ?? 0)
      const [p, q, r] = corners(w, t)
      out.push([(p[0] + q[0] + r[0]) / 3, (p[1] + q[1] + r[1]) / 3, (p[2] + q[2] + r[2]) / 3])
    }
    for (const v of verts) out.push(vtx(w, v))
    return out
  }
  let pairs = 0
  let min: number | null = null
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i]
      const b = bodies[j]
      if (!a || !b || !near(a, b)) continue
      let gap = Infinity
      for (const [from, to] of [[a, b], [b, a]] as const) {
        const g = grid(to)
        for (const p of samples(from)) gap = Math.min(gap, g.signedDistance(p, reachMm))
      }
      if (!Number.isFinite(gap)) continue
      pairs++
      min = min === null ? gap : Math.min(min, gap)
    }
  }
  return { pairs, minGapMm: min === null ? null : Math.round(min * 1000) / 1000 }
}
