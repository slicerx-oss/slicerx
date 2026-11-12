// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Mesh checks for the creative prompt set, in plain TypeScript over the parts a design tool added, so they run
// without the geometry engine: closed shells, body count, thinnest wall, bed fit and the gap between moving bodies.
import type { MeshPart } from '@slicerx/contracts'
import { WALL_BUDGET, minWall as wallFromEvery, type WallBudget } from '../../src/body-facts'

type V3 = [number, number, number]

/**
 * A part's triangles with welded vertex ids, so seams in the vertex list do not read as open edges. Only vertices with
 * the same single-precision bits are welded, as the slicer welds a part when it loads it (packages/core/src/mesh.rs,
 * keyed on f32::to_bits): a tolerance would fold the sub-micron edges a boolean leaves where two surfaces meet into
 * edges with four triangles that the slicer never sees, and -0 and 0 stay two vertices there as they do here.
 */
interface Welded {
  /** xyz per welded vertex. */
  pos: number[]
  /** Three welded vertex ids per triangle, degenerate triangles dropped. */
  tri: number[]
}

/** A vertex's key: the bits of its three single-precision coordinates, so -0 and 0 differ as they do in the slicer. */
const f32 = new Float32Array(3)
const bits = new Uint32Array(f32.buffer)
const vertexKey = (x: number, y: number, z: number): string => {
  f32[0] = x
  f32[1] = y
  f32[2] = z
  return `${bits[0]},${bits[1]},${bits[2]}`
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
    const key = vertexKey(x, y, z)
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

/**
 * Each separate solid body across all parts: its bounding box and its outline seen from above, as the convex hull of
 * its corners in xy (counterclockwise), mm.
 */
export function bodyBoxes(parts: MeshPart[]): { min: V3; max: V3; hull: [number, number][] }[] {
  const { welded, bodies } = split(parts)
  return bodies.map((b) => {
    const w = welded[b.part]!
    const pts: [number, number][] = []
    for (const t of b.tris) for (const p of corners(w, t)) pts.push([p[0], p[1]])
    return { min: b.min, max: b.max, hull: hull2(pts) }
  })
}

/**
 * Each separate solid body across all parts as its own triangles (nine numbers each: three corners), with its volume
 * and bounding box, mm.
 */
export function bodyTriangles(parts: MeshPart[]): { volumeMm3: number; min: V3; max: V3; tri: Float64Array }[] {
  const { welded, bodies } = split(parts)
  return bodies.map((b) => {
    const w = welded[b.part]!
    const tri = new Float64Array(b.tris.length * 9)
    b.tris.forEach((t, i) => corners(w, t).forEach((p, j) => tri.set(p, i * 9 + j * 3)))
    return { volumeMm3: b.volumeMm3, min: b.min, max: b.max, tri }
  })
}

/** The convex hull of points in a plane, counterclockwise (monotone chain). */
function hull2(pts: [number, number][]): [number, number][] {
  const s = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const turn = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (list: [number, number][]) => {
    const h: [number, number][] = []
    for (const p of list) {
      while (h.length >= 2 && turn(h[h.length - 2]!, h[h.length - 1]!, p) <= 0) h.pop()
      h.push(p)
    }
    h.pop()
    return h
  }
  return s.length < 3 ? s : [...half(s), ...half([...s].reverse())]
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
  /**
   * The thinnest wall found, mm: from every facet with design.check's wall read (wallFromEvery), so a
   * pinch over a small area counts; for a part too dense for that, the low percentile of the area-weighted samples.
   */
  minWallMm: number
  samples: number
  /** every facet, or sampled for a part too dense to read every facet of */
  how?: 'every facet' | 'sampled'
}

/**
 * Which parts have every facet read: the ones design.check reads (WALL_BUDGET's facet cap, over every part together as
 * before), with far more work, about the minute this allowed when it was timed, counted so a slow machine reads the
 * same wall. A finer mesh than that has sub-millimeter ledges and sharp rims whose rays read almost nothing though the
 * wall is whole, and design.check does not read it either: it is sampled.
 */
const EVERY_FACET: WallBudget = { maxFacets: WALL_BUDGET.maxFacets, maxWork: 1_500_000_000 }

/** Low percentile of the thickness samples that counts as the wall: thin regions win, one stray corner ray does not. */
const WALL_PERCENTILE = 0.02

/**
 * Wall thickness the way a slicer meets it: from points spread over the surface (area weighted, the same points every
 * run), a ray goes straight in and the distance to where it leaves the material is the local thickness.
 */
export function minWall(parts: MeshPart[], maxSamples = 600): WallReport {
  // every facet first, the way design.check reads the wall, so a pinch that no sample lands on is still found
  const facets = parts.reduce((n, p) => n + Math.floor(p.indices.length / 3), 0)
  const every = facets && facets <= EVERY_FACET.maxFacets ? wallFromEvery(parts, EVERY_FACET) : { mm: null }
  if (every.mm !== null) return { minWallMm: every.mm, samples: facets, how: 'every facet' }
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
  return { minWallMm: Math.round((thick[at] ?? 0) * 1000) / 1000, samples: thick.length, how: 'sampled' }
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

/** A gap between two separate bodies, as the engine's fit check measures it. */
export interface GapPair {
  /** The two bodies, numbered as the fit check numbers them. */
  parts: [number, number]
  /** The gap, mm; 0 when they touch or overlap. */
  gapMm: number
  /** side by side (horizontal) or one over the other (vertical); fused when they touch or overlap */
  kind: 'horizontal' | 'vertical' | 'fused'
}

export interface GapReport {
  /** Pairs of bodies that come within `reachMm` of each other: the joints and meshes that must move. */
  pairs: number
  /** Smallest gap between any such pair, mm; 0 when bodies touch or overlap. null when no bodies come that close. */
  minGapMm: number | null
  /** Each such pair's gap, smallest first. */
  gaps: GapPair[]
}

/** The geometry engine, as a design host calls it. */
export type GeomCall = (op: string, request: unknown) => Promise<unknown>

/**
 * The gaps between separate bodies that come close enough to be meant to move against each other (hinge knuckles,
 * meshing teeth, links), measured by the engine's own fit check (fit.check, the check the app runs on the plate):
 * every pair of bodies within `reachMm`, with its gap and whether it is side by side, one over the other, or touching.
 * Bodies that touch or overlap print as one piece; the fit check does not tell how deep an overlap goes.
 */
export async function movingGaps(parts: MeshPart[], engine: GeomCall, reachMm = 2): Promise<GapReport> {
  const meshes = parts.filter((p) => p.indices.length).map((p) => ({ positions: Array.from(p.positions), indices: Array.from(p.indices) }))
  if (!meshes.length) return { pairs: 0, minGapMm: null, gaps: [] }
  // every pair within reach counts as below the limit, so the check reports each with its gap
  const r = (await engine('fit.check', { meshes, minGapMm: reachMm })) as { gaps?: { parts: [number, number]; gapMm: number; kind: string }[] }
  const gaps: GapPair[] = (r.gaps ?? [])
    .filter((g) => g.kind === 'horizontal' || g.kind === 'vertical' || g.kind === 'fused')
    .map((g) => ({ parts: g.parts, gapMm: g.kind === 'fused' ? 0 : Math.round(g.gapMm * 1000) / 1000, kind: g.kind as GapPair['kind'] }))
    .sort((a, b) => a.gapMm - b.gapMm)
  return { pairs: gaps.length, minGapMm: gaps.length ? (gaps[0]?.gapMm ?? null) : null, gaps }
}
