// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The dimension sheet's drawing: the part a sheet describes, drawn front, top, right and iso, with each size as a
// dimension line and a numbered callout that matches its row. The part is the design as built when the sheet changes
// one, else the sheet's own solids, drawn the same way: its silhouette and its visible edges, as a technical drawing
// shows a part. Pure geometry, in screen pixels, so the drawing component only paints it.
import type { PilotDim, PilotDimAt, PilotSheetExtrude, PilotSheetLoft, PilotSheetRevolve, PilotSheetSolid, PilotSheetSweep } from '@slicerx/contracts'

export type V3 = [number, number, number]
export type ViewName = 'front' | 'top' | 'side' | 'iso'
type P2 = [number, number]

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2])
const nrm = (a: V3): V3 => {
  const l = len(a)
  return l === 0 ? [0, 0, 0] : mul(a, 1 / l)
}

/** A view: `d` points at the viewer, `r` is screen right and `u` screen up. */
export const VIEWS: Record<ViewName, { d: V3; r: V3; u: V3; label: string }> = {
  front: { d: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1], label: 'Front, XZ' },
  top: { d: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0], label: 'Top, XY' },
  side: { d: [1, 0, 0], r: [0, 1, 0], u: [0, 0, 1], label: 'Right, YZ' },
  iso: { d: nrm([1, -1, 1]), r: nrm([1, 1, 0]), u: nrm([-1, 1, 2]), label: 'Isometric' },
}

/** The four views of the sheet, in their places: front and top on the left, right and iso beside them. */
export const SHEET_VIEWS: readonly ViewName[] = ['front', 'side', 'top', 'iso']

export interface Face {
  pts: V3[]
  n: V3
  holes?: V3[][]
}

const to3 = (plane: PilotSheetExtrude['plane'], u: number, v: number, t: number): V3 => (plane === 'xy' ? [u, v, t] : plane === 'xz' ? [u, t, v] : [t, u, v])

const area = (pts: readonly P2[]): number => pts.reduce((s, p, i) => {
  const q = pts[(i + 1) % pts.length]!
  return s + p[0] * q[1] - q[0] * p[1]
}, 0)

/** Counterclockwise for the outline, clockwise for a hole, so every side's normal points out of the material. */
const orient = (pts: readonly P2[], ccw: boolean): P2[] => (area(pts) > 0 === ccw ? [...pts] : [...pts].reverse())

/** A solid's faces: a side for each edge of its outline and holes, and its two caps (holes cut through them). */
export function solidFaces(s: PilotSheetExtrude): Face[] {
  const lo = Math.min(s.from, s.to)
  const hi = Math.max(s.from, s.to)
  const outer = orient(s.points, true)
  const holes = (s.holes ?? []).map((h) => orient(h, false))
  const faces: Face[] = []
  for (const loop of [outer, ...holes]) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!
      const b = loop[(i + 1) % loop.length]!
      const eu = b[0] - a[0]
      const ev = b[1] - a[1]
      const l = Math.hypot(eu, ev)
      if (l === 0) continue
      faces.push({ pts: [to3(s.plane, a[0], a[1], lo), to3(s.plane, b[0], b[1], lo), to3(s.plane, b[0], b[1], hi), to3(s.plane, a[0], a[1], hi)], n: to3(s.plane, ev / l, -eu / l, 0) })
    }
  }
  const cap = (t: number, sign: number): Face => ({ pts: outer.map((p) => to3(s.plane, p[0], p[1], t)), n: to3(s.plane, 0, 0, sign), ...(holes.length ? { holes: holes.map((h) => h.map((p) => to3(s.plane, p[0], p[1], t))) } : {}) })
  faces.push(cap(lo, -1), cap(hi, 1))
  return faces
}

const flat = (a: V3, d: V3): boolean => Math.abs(dot(nrm(a), d)) < 1e-3

/** True when a size reads at its true length in a view: its line, and the way it is moved out, lie in the view's plane. */
export function readsIn(at: PilotDimAt, view: ViewName): boolean {
  const d = VIEWS[view].d
  if (view === 'iso') return true
  if ('c' in at) return Math.abs(dot(nrm(cross(at.from, at.to)), d)) > 0.999
  return len(sub(at.b, at.a)) > 0 && flat(sub(at.b, at.a), d) && (len(at.off) === 0 || flat(at.off, d))
}

/**
 * The view each row's callout is drawn in: the first flat view it reads in (the sheet's own order first), and the iso
 * view as well, so every callout also sits on the part as a whole.
 */
export function viewsFor(dims: readonly PilotDim[], order: readonly ViewName[]): Map<string, ViewName[]> {
  const flatOrder = [...order, 'front', 'top', 'side'].filter((v, i, all): v is Exclude<ViewName, 'iso'> => v !== 'iso' && all.indexOf(v) === i)
  const out = new Map<string, ViewName[]>()
  for (const d of dims) {
    if (!d.at) continue
    const first = flatOrder.find((v) => readsIn(d.at!, v))
    out.set(d.key, first ? [first, 'iso'] : ['iso'])
  }
  return out
}

/**
 * What a view draws, in the part's mm with Z up: planar polygons, each an outline and the holes in it (a sheet's
 * extruded solids), and triangles, nine numbers each (a built design's mesh, and a sheet's revolves, sweeps and lofts).
 * Flat typed arrays, so a mesh of hundreds of thousands of triangles costs no object per triangle.
 */
export interface Shape {
  polys: V3[][][]
  tris: Float32Array
  /** Every corner, three numbers each, for the bounds. */
  pts: Float32Array
  /** The mesh had more triangles than the drawing takes, so it is drawn simplified (TRI_BUDGET). */
  simplified: boolean
}

/** The most triangles a drawing rasterizes: a denser mesh is simplified to about this many first. */
export const TRI_BUDGET = 80_000

const pushTri = (out: number[], a: V3, b: V3, c: V3): void => {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
}
const pushQuad = (out: number[], a: V3, b: V3, c: V3, d: V3): void => {
  pushTri(out, a, b, c)
  pushTri(out, a, c, d)
}

/** A circle of radius `r` as a 32 sided outline, counterclockwise. */
const circle = (r: number, c: P2 = [0, 0], n = 32): P2[] => Array.from({ length: n }, (_, i) => [c[0] + r * Math.cos((2 * Math.PI * i) / n), c[1] + r * Math.sin((2 * Math.PI * i) / n)] as P2)

/** A profile turned about an axis in its own plane; the open ends of a partial turn are capped. */
function revolveInto(s: PilotSheetRevolve, polys: V3[][][], out: number[]): void {
  const angle = Math.min(360, Math.max(1, Math.abs(s.angle ?? 360)))
  const full = angle >= 359.99
  const n = Math.max(4, Math.ceil(angle / 7.5))
  const o = to3(s.plane, s.axis.point[0], s.axis.point[1], 0)
  const ax = nrm(to3(s.plane, s.axis.direction[0], s.axis.direction[1], 0))
  if (len(ax) === 0) return
  const turn = (p: V3, th: number): V3 => {
    const v = sub(p, o)
    const c = Math.cos(th)
    return add(o, add(add(mul(v, c), mul(cross(ax, v), Math.sin(th))), mul(ax, dot(ax, v) * (1 - c))))
  }
  // one outline, as the sheet's schema takes it: holes sent anyway are not drawn, so the drawing shows what was checked
  const rings = [orient(s.points, true)].map((r) => r.map(([u, v]) => to3(s.plane, u, v, 0)))
  const th = (k: number): number => (((s.angle ?? 360) < 0 ? -1 : 1) * angle * Math.PI * k) / (180 * n)
  for (const ring of rings) {
    let prev = ring.map((p) => turn(p, 0))
    for (let k = 1; k <= n; k++) {
      const next = full && k === n ? ring.map((p) => turn(p, 0)) : ring.map((p) => turn(p, th(k)))
      for (let i = 0; i < ring.length; i++) {
        const j = (i + 1) % ring.length
        pushQuad(out, prev[i]!, prev[j]!, next[j]!, next[i]!)
      }
      prev = next
    }
  }
  if (!full) for (const k of [0, n]) polys.push(rings.map((r) => r.map((p) => turn(p, th(k)))))
}

/** A path with each inner corner bent on radius `round` (kept to the room its two sides leave). */
export function roundPath(path: readonly V3[], round: number): V3[] {
  const pts = path.filter((p, i) => i === 0 || len(sub(p, path[i - 1]!)) > 1e-9)
  if (round <= 0 || pts.length < 3) return pts
  const out: V3[] = [pts[0]!]
  let room = len(sub(pts[1]!, pts[0]!))
  for (let i = 1; i + 1 < pts.length; i++) {
    const p = pts[i]!
    const din = nrm(sub(p, pts[i - 1]!))
    const dout = nrm(sub(pts[i + 1]!, p))
    const turn = Math.acos(Math.max(-1, Math.min(1, dot(din, dout))))
    const lenOut = len(sub(pts[i + 1]!, p))
    if (turn < 1e-3 || turn > Math.PI - 1e-3) {
      out.push(p)
      room = lenOut
      continue
    }
    // the bend starts and ends this far from the corner, at most half of each side when the next corner bends too
    const t = Math.min(round * Math.tan(turn / 2), room, i + 2 < pts.length ? lenOut / 2 : lenOut)
    const r = t / Math.tan(turn / 2)
    const a = sub(p, mul(din, t))
    const c = add(p, mul(nrm(sub(dout, din)), r / Math.cos(turn / 2)))
    const va = sub(a, c)
    const vb = sub(add(p, mul(dout, t)), c)
    const steps = Math.max(4, Math.ceil(turn / (Math.PI / 24)))
    for (let k = 0; k <= steps; k++) {
      // the arc from a to b about c, by spherical interpolation of the two radii
      const f = k / steps
      const w1 = Math.sin((1 - f) * turn) / Math.sin(turn)
      const w2 = Math.sin(f * turn) / Math.sin(turn)
      out.push(add(c, add(mul(va, w1), mul(vb, w2))))
    }
    room = lenOut - t
  }
  out.push(pts.at(-1)!)
  return out
}

/** A profile carried along a path, its frame turned along with the path; its two ends are capped. */
function sweepInto(s: PilotSheetSweep, polys: V3[][][], out: number[]): void {
  const path = roundPath(s.path, s.round ?? 0)
  if (path.length < 2) return
  const prof = 'd' in s.profile && s.profile.d !== undefined ? [circle(s.profile.d / 2), ...(s.profile.hole ? [circle(s.profile.hole / 2).reverse()] : [])] : 'points' in s.profile ? [orient(s.profile.points, true)] : []
  if (!prof.length) return
  const last = path.length - 1
  const tangent = (i: number): V3 => nrm(add(i > 0 ? nrm(sub(path[i]!, path[i - 1]!)) : [0, 0, 0], i < last ? nrm(sub(path[i + 1]!, path[i]!)) : [0, 0, 0]))
  let t = tangent(0)
  const ref: V3 = Math.abs(t[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  let nx = nrm(sub(ref, mul(t, dot(ref, t))))
  const frames: V3[][][] = []
  for (let i = 0; i <= last; i++) {
    if (i > 0) {
      t = tangent(i)
      // carried along: the last normal with its part along the new tangent taken out
      const m = sub(nx, mul(t, dot(nx, t)))
      if (len(m) > 1e-9) nx = nrm(m)
    }
    const by = cross(t, nx)
    frames.push(prof.map((ring) => ring.map(([u, v]) => add(path[i]!, add(mul(nx, u), mul(by, v))))))
  }
  for (let i = 0; i < last; i++) {
    frames[i]!.forEach((ring, r) => {
      const next = frames[i + 1]![r]!
      for (let a = 0; a < ring.length; a++) {
        const b = (a + 1) % ring.length
        pushQuad(out, ring[a]!, ring[b]!, next[b]!, next[a]!)
      }
    })
  }
  polys.push(frames[0]!, frames[last]!)
}

/** An outline resampled to `n` points evenly along its length. */
function resample(pts: readonly P2[], n: number): P2[] {
  if (pts.length === n) return [...pts]
  const seg = pts.map((p, i) => Math.hypot(pts[(i + 1) % pts.length]![0] - p[0], pts[(i + 1) % pts.length]![1] - p[1]))
  const total = seg.reduce((s, l) => s + l, 0) || 1
  const out: P2[] = []
  let i = 0
  let acc = 0
  for (let k = 0; k < n; k++) {
    const want = (total * k) / n
    while (i < pts.length - 1 && acc + seg[i]! < want) acc += seg[i++]!
    const f = seg[i]! > 0 ? (want - acc) / seg[i]! : 0
    const a = pts[i]!
    const b = pts[(i + 1) % pts.length]!
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f])
  }
  return out
}

/** Outlines at offsets along the plane's third axis, joined in order, each turned to start nearest the last; both ends are capped. */
function loftInto(s: PilotSheetLoft, polys: V3[][][], out: number[]): void {
  const secs = [...s.sections].sort((a, b) => a.at - b.at)
  if (secs.length < 2) return
  const outlines = secs.map((sec) => orient('d' in sec && sec.d !== undefined ? circle(sec.d / 2, [0, 0], 48) : (sec as { points: [number, number][] }).points, true))
  const same = outlines.every((o) => o.length === outlines[0]!.length)
  const n = same ? outlines[0]!.length : Math.min(96, Math.max(...outlines.map((o) => o.length), 48))
  const rings: P2[][] = []
  for (const o of outlines) {
    const r = resample(o, n)
    const prev = rings.at(-1)
    if (!prev) {
      rings.push(r)
      continue
    }
    // the start that puts each point nearest the last outline's, so the sides do not twist
    let best = 0
    let bestD = Infinity
    for (let k = 0; k < n; k++) {
      let d = 0
      for (let i = 0; i < n; i++) d += Math.hypot(r[(i + k) % n]![0] - prev[i]![0], r[(i + k) % n]![1] - prev[i]![1])
      if (d < bestD) ((bestD = d), (best = k))
    }
    rings.push(r.map((_, i) => r[(i + best) % n]!))
  }
  const rings3 = rings.map((r, k) => r.map(([u, v]) => to3(s.plane, u, v, secs[k]!.at)))
  for (let k = 0; k + 1 < rings3.length; k++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      pushQuad(out, rings3[k]![i]!, rings3[k]![j]!, rings3[k + 1]![j]!, rings3[k + 1]![i]!)
    }
  }
  polys.push([rings3[0]!], [rings3.at(-1)!])
}

/** The shape of a sheet's solids: an extrude's sides and caps, and a revolve's, sweep's or loft's surface. */
export function shapeOfSolids(part: readonly PilotSheetSolid[]): Shape {
  const polys: V3[][][] = []
  const tri: number[] = []
  for (const s of part) {
    if (s.kind === 'revolve') revolveInto(s, polys, tri)
    else if (s.kind === 'sweep') sweepInto(s, polys, tri)
    else if (s.kind === 'loft') loftInto(s, polys, tri)
    else for (const f of solidFaces(s)) polys.push([f.pts, ...(f.holes ?? [])])
  }
  const corners: number[] = []
  for (const p of polys) for (const q of p[0]!) corners.push(q[0], q[1], q[2])
  for (const v of tri) corners.push(v)
  return { polys, tris: new Float32Array(tri), pts: new Float32Array(corners), simplified: false }
}

/** A mesh as the engine gives it: `positions` and `indices`, in the part's own frame. */
export interface SheetMesh {
  positions: ArrayLike<number>
  indices: ArrayLike<number>
}

/**
 * The shape of a built design: every triangle of its parts, moved by `t` (a column-major 4 x 4, the plate entry's
 * transform) when given. Above `budget` triangles the mesh is simplified (simplifyTris), so a dense part draws in time.
 */
export function shapeOfMesh(meshes: readonly SheetMesh[], t?: ArrayLike<number>, budget = TRI_BUDGET): Shape {
  let nt = 0
  let nv = 0
  for (const m of meshes) {
    nt += Math.floor(m.indices.length / 3)
    nv += Math.floor(m.positions.length / 3)
  }
  const pts = new Float32Array(3 * nv)
  let tris: Float32Array = new Float32Array(9 * nt)
  let pv = 0
  let pt = 0
  for (const m of meshes) {
    const p = m.positions
    const base = pv
    for (let i = 0; 3 * i + 2 < p.length; i++) {
      const x = p[3 * i]!
      const y = p[3 * i + 1]!
      const z = p[3 * i + 2]!
      if (t) {
        pts[3 * pv] = t[0]! * x + t[4]! * y + t[8]! * z + t[12]!
        pts[3 * pv + 1] = t[1]! * x + t[5]! * y + t[9]! * z + t[13]!
        pts[3 * pv + 2] = t[2]! * x + t[6]! * y + t[10]! * z + t[14]!
      } else {
        pts[3 * pv] = x
        pts[3 * pv + 1] = y
        pts[3 * pv + 2] = z
      }
      pv++
    }
    const ix = m.indices
    const end = 3 * Math.floor(ix.length / 3)
    for (let k = 0; k < end; k++) {
      const v = base + ix[k]!
      tris[pt++] = pts[3 * v]!
      tris[pt++] = pts[3 * v + 1]!
      tris[pt++] = pts[3 * v + 2]!
    }
  }
  let simplified = false
  if (nt > budget) {
    tris = simplifyTris(tris, budget)
    simplified = true
  }
  return { polys: [], tris, pts, simplified }
}

/**
 * About `budget` triangles drawn in place of a denser mesh: corners that fall in one cell of a grid merge at their
 * mean, and triangles left with no area drop out. The cell is sized from the surface's area so one pass usually lands
 * under the budget; each further pass takes a coarser grid.
 */
export function simplifyTris(tris: Float32Array, budget: number): Float32Array {
  const n = tris.length / 9
  let area = 0
  const lo: V3 = [Infinity, Infinity, Infinity]
  const hi: V3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) ((lo[k] = Math.min(lo[k]!, tris[i + k]!)), (hi[k] = Math.max(hi[k]!, tris[i + k]!)))
  for (let t = 0; t < n; t++) {
    const o = 9 * t
    const ux = tris[o + 3]! - tris[o]!
    const uy = tris[o + 4]! - tris[o + 1]!
    const uz = tris[o + 5]! - tris[o + 2]!
    const vx = tris[o + 6]! - tris[o]!
    const vy = tris[o + 7]! - tris[o + 1]!
    const vz = tris[o + 8]! - tris[o + 2]!
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
  }
  // a closed surface on a grid of cell c keeps about two triangles per cell it passes through
  let cell = Math.max(1e-6, Math.sqrt((2 * area) / budget) * 1.15)
  for (let pass = 0; pass < 8; pass++) {
    const nx = Math.floor((hi[0] - lo[0]) / cell) + 1
    const ny = Math.floor((hi[1] - lo[1]) / cell) + 1
    const ids = new Map<number, number>()
    const sum: number[] = []
    const of = new Int32Array(3 * n)
    for (let i = 0; i < 3 * n; i++) {
      const x = tris[3 * i]!
      const y = tris[3 * i + 1]!
      const z = tris[3 * i + 2]!
      const key = Math.floor((x - lo[0]) / cell) + nx * (Math.floor((y - lo[1]) / cell) + ny * Math.floor((z - lo[2]) / cell))
      let id = ids.get(key)
      if (id === undefined) {
        id = sum.length / 4
        ids.set(key, id)
        sum.push(0, 0, 0, 0)
      }
      sum[4 * id] = sum[4 * id]! + x
      sum[4 * id + 1] = sum[4 * id + 1]! + y
      sum[4 * id + 2] = sum[4 * id + 2]! + z
      sum[4 * id + 3] = sum[4 * id + 3]! + 1
      of[i] = id
    }
    let kept = 0
    for (let t = 0; t < n; t++) if (of[3 * t] !== of[3 * t + 1] && of[3 * t + 1] !== of[3 * t + 2] && of[3 * t] !== of[3 * t + 2]) kept++
    if (kept > budget && pass < 7) {
      cell *= 1.3
      continue
    }
    const out = new Float32Array(9 * kept)
    let o = 0
    for (let t = 0; t < n; t++) {
      const a = of[3 * t]!
      const b = of[3 * t + 1]!
      const c = of[3 * t + 2]!
      if (a === b || b === c || a === c) continue
      for (const id of [a, b, c]) {
        const w = sum[4 * id + 3]!
        out[o++] = sum[4 * id]! / w
        out[o++] = sum[4 * id + 1]! / w
        out[o++] = sum[4 * id + 2]! / w
      }
    }
    return out
  }
  return tris
}

/** The shape's bounds in mm: least and most corner. */
export function shapeBounds(shape: Shape): { lo: V3; hi: V3 } | null {
  const p = shape.pts
  if (!p.length) return null
  const lo: V3 = [Infinity, Infinity, Infinity]
  const hi: V3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 2 < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k]!
      if (v < lo[k]!) lo[k] = v
      if (v > hi[k]!) hi[k] = v
    }
  }
  return { lo, hi }
}

/**
 * The view drawn as a technical drawing: which pixels the part covers (its silhouette) and which are its visible edges,
 * at `px` device pixels per screen pixel. An edge is where the surface folds (faces more than EDGE_DEG apart), where one
 * surface passes in front of another, and the outline. Each pixel keeps the nearest surface, so hidden edges never show.
 */
export interface Raster {
  W: number
  H: number
  px: number
  cover: Uint8Array
  edge: Uint8Array
  /** The nearest surface's depth at each pixel, along the view toward the eye in mm (-Infinity where none). */
  depth: Float32Array
}

/** Faces meeting at more than this read as an edge; a round's facets meet at less. */
export const EDGE_DEG = 28
const EDGE_COS = Math.cos((EDGE_DEG * Math.PI) / 180)

/** A polygon's normal by Newell's method, unit length; zero for one with no area. */
function newell(ring: readonly V3[]): V3 {
  const n: V3 = [0, 0, 0]
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!
    const b = ring[(i + 1) % ring.length]!
    n[0] += (a[1] - b[1]) * (a[2] + b[2])
    n[1] += (a[2] - b[2]) * (a[0] + b[0])
    n[2] += (a[0] - b[0]) * (a[1] + b[1])
  }
  return nrm(n)
}

/** The most device pixels one view's raster takes; a bigger cell draws coarser and its canvas is scaled up. */
export const VIEW_PX_MAX = 1_200_000

/** Device pixels per screen pixel for a w x h view: the screen's ratio up to 2, less when that passes VIEW_PX_MAX. */
export function drawPx(w: number, h: number, ratio = 1): number {
  const want = Math.min(2, Math.max(1, ratio))
  return Math.max(0.25, Math.min(want, Math.sqrt(VIEW_PX_MAX / Math.max(1, w * h))))
}

/**
 * Draws a shape into a W x H raster: a point maps to device pixels (x right, y down) as (p.r k + ox, -p.u k + oy) times
 * `px`, and to its depth p.d (larger nearer the viewer), the same for every point, so a face's depth is a plane over
 * its pixels. Polygons own the first indices and triangles the rest.
 */
export function rasterize(shape: Shape, view: ViewName, W: number, H: number, k: number, ox: number, oy: number, px: number): Raster {
  const { r, u, d } = VIEWS[view]
  const n = W * H
  const P = shape.polys.length
  const T = shape.tris.length / 9
  const depth = new Float32Array(n).fill(-Infinity)
  const owner = new Int32Array(n).fill(-1)
  // per face: its normal and how its depth changes per device pixel across and down
  const normals = new Float32Array(3 * (P + T))
  const grad = new Float32Array(2 * (P + T))
  const S = k * px
  // on a face's plane, depth moves by -(n.r)/(n.d) per mm right and +(n.u)/(n.d) per mm down the screen
  const slope = (f: number, nx: number, ny: number, nz: number): boolean => {
    normals[3 * f] = nx
    normals[3 * f + 1] = ny
    normals[3 * f + 2] = nz
    const nd = nx * d[0] + ny * d[1] + nz * d[2]
    // seen edge on: it covers no pixel of its own, its neighbors draw the line
    if (Math.abs(nd) < 1e-4) return false
    grad[2 * f] = -(nx * r[0] + ny * r[1] + nz * r[2]) / nd / S
    grad[2 * f + 1] = (nx * u[0] + ny * u[1] + nz * u[2]) / nd / S
    return true
  }
  shape.polys.forEach((rings, pi) => {
    const nn = newell(rings[0]!)
    if (!slope(pi, nn[0], nn[1], nn[2])) return
    const gx = grad[2 * pi]!
    const gy = grad[2 * pi + 1]!
    const scr = rings.map((ring) => ring.map((p): [number, number] => [(dot(p, r) * k + ox) * px, (-dot(p, u) * k + oy) * px]))
    const p0 = rings[0]![0]!
    const s0 = scr[0]![0]!
    const z0 = dot(p0, d)
    let y0 = Infinity
    let y1 = -Infinity
    for (const ring of scr) for (const q of ring) ((y0 = Math.min(y0, q[1])), (y1 = Math.max(y1, q[1])))
    const ya = Math.max(0, Math.ceil(y0 - 0.5))
    const yb = Math.min(H - 1, Math.floor(y1 - 0.5))
    const xs: number[] = []
    for (let y = ya; y <= yb; y++) {
      const cy = y + 0.5
      xs.length = 0
      for (const ring of scr) {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i]!
          const b = ring[(i + 1) % ring.length]!
          if (a[1] > cy !== b[1] > cy) xs.push(a[0] + ((cy - a[1]) * (b[0] - a[0])) / (b[1] - a[1]))
        }
      }
      xs.sort((p, q) => p - q)
      for (let j = 0; j + 1 < xs.length; j += 2) {
        const xa = Math.max(0, Math.ceil(xs[j]! - 0.5))
        const xb = Math.min(W - 1, Math.floor(xs[j + 1]! - 0.5))
        for (let x = xa; x <= xb; x++) {
          const z = z0 + (x + 0.5 - s0[0]) * gx + (cy - s0[1]) * gy
          const i = y * W + x
          if (z > depth[i]!) {
            depth[i] = z
            owner[i] = pi
          }
        }
      }
    }
  })
  const tr = shape.tris
  const [rx, ry, rz] = r
  const [ux, uy, uz] = u
  const [dx, dy, dz] = d
  for (let t = 0; t < T; t++) {
    const o = 9 * t
    const ax = tr[o]!
    const ay = tr[o + 1]!
    const az = tr[o + 2]!
    const e1x = tr[o + 3]! - ax
    const e1y = tr[o + 4]! - ay
    const e1z = tr[o + 5]! - az
    const e2x = tr[o + 6]! - ax
    const e2y = tr[o + 7]! - ay
    const e2z = tr[o + 8]! - az
    let nx = e1y * e2z - e1z * e2y
    let ny = e1z * e2x - e1x * e2z
    let nz = e1x * e2y - e1y * e2x
    const nl = Math.hypot(nx, ny, nz)
    if (nl === 0) continue
    nx /= nl
    ny /= nl
    nz /= nl
    const f = P + t
    if (!slope(f, nx, ny, nz)) continue
    const gx = grad[2 * f]!
    const gy = grad[2 * f + 1]!
    // the corners on screen, in device pixels
    const sx0 = ((ax * rx + ay * ry + az * rz) * k + ox) * px
    const sy0 = (-(ax * ux + ay * uy + az * uz) * k + oy) * px
    const sx1 = sx0 + (e1x * rx + e1y * ry + e1z * rz) * S
    const sy1 = sy0 - (e1x * ux + e1y * uy + e1z * uz) * S
    const sx2 = sx0 + (e2x * rx + e2y * ry + e2z * rz) * S
    const sy2 = sy0 - (e2x * ux + e2y * uy + e2z * uz) * S
    const twice = (sx1 - sx0) * (sy2 - sy0) - (sx2 - sx0) * (sy1 - sy0)
    if (twice === 0) continue
    const sg = twice > 0 ? 1 : -1
    const xa = Math.max(0, Math.ceil(Math.min(sx0, sx1, sx2) - 0.5))
    const xb = Math.min(W - 1, Math.floor(Math.max(sx0, sx1, sx2) - 0.5))
    const ya = Math.max(0, Math.ceil(Math.min(sy0, sy1, sy2) - 0.5))
    const yb = Math.min(H - 1, Math.floor(Math.max(sy0, sy1, sy2) - 0.5))
    if (xa > xb || ya > yb) continue
    const z0 = ax * dx + ay * dy + az * dz
    // edge functions, signed so the inside is positive, stepped across each row
    const A0 = (sy1 - sy2) * sg
    const A1 = (sy2 - sy0) * sg
    const A2 = (sy0 - sy1) * sg
    for (let y = ya; y <= yb; y++) {
      const cy = y + 0.5
      const cx = xa + 0.5
      let w0 = ((sx2 - sx1) * (cy - sy1) - (sy2 - sy1) * (cx - sx1)) * sg
      let w1 = ((sx0 - sx2) * (cy - sy2) - (sy0 - sy2) * (cx - sx2)) * sg
      let w2 = ((sx1 - sx0) * (cy - sy0) - (sy1 - sy0) * (cx - sx0)) * sg
      let z = z0 + (cx - sx0) * gx + (cy - sy0) * gy
      let i = y * W + xa
      for (let x = xa; x <= xb; x++, i++) {
        if (w0 >= 0 && w1 >= 0 && w2 >= 0 && z > depth[i]!) {
          depth[i] = z
          owner[i] = f
        }
        w0 += A0
        w1 += A1
        w2 += A2
        z += gx
      }
    }
  }
  const cover = new Uint8Array(n)
  const edge = new Uint8Array(n)
  for (let i = 0; i < n; i++) cover[i] = owner[i]! >= 0 ? 1 : 0
  // how far depth may stray from what the two faces explain before it is another surface: a pixel and a half, or 0.05 mm
  const tol = Math.max(0.05, 1.5 / S)
  const differs = (i: number, j: number, ddx: number, ddy: number): boolean => {
    const a = owner[i]!
    const b = owner[j]!
    if (a < 0 && b < 0) return false
    if (a < 0 || b < 0 || a === b) return a !== b
    if (Math.abs(normals[3 * a]! * normals[3 * b]! + normals[3 * a + 1]! * normals[3 * b + 1]! + normals[3 * a + 2]! * normals[3 * b + 2]!) < EDGE_COS) return true
    // Two faces that meet between the pixels change depth by no less than the one's slope and no more than the other's
    // over the step, so only a step past both is a surface passing in front of another. A face that grazes the view
    // slopes steeply, and a round's facets near its outline did: judged by one face's slope alone, the next facet of
    // the same surface read as one behind it, drawing clusters and a second line beside the outline. The margin of two
    // pixels of the steeper slope leaves out where a round folds behind itself by less than that, as at a bend's inside.
    const ga = grad[2 * a]! * ddx + grad[2 * a + 1]! * ddy
    const gb = grad[2 * b]! * ddx + grad[2 * b + 1]! * ddy
    const step = depth[j]! - depth[i]!
    const room = Math.max(tol, 2 * Math.max(Math.abs(ga), Math.abs(gb)))
    return step < Math.min(ga, gb) - room || step > Math.max(ga, gb) + room
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (x + 1 < W && differs(i, i + 1, 1, 0)) {
        // the line goes on the nearer side, so an edge in front of a far face draws on the near face
        if (owner[i]! >= 0 && (owner[i + 1]! < 0 || depth[i]! >= depth[i + 1]!)) edge[i] = 1
        else edge[i + 1] = 1
      }
      if (y + 1 < H && differs(i, i + W, 0, 1)) {
        if (owner[i]! >= 0 && (owner[i + W]! < 0 || depth[i]! >= depth[i + W]!)) edge[i] = 1
        else edge[i + W] = 1
      }
    }
  }
  return { W, H, px, cover, edge, depth }
}

/** A group of touching edge pixels less than this many screen px across and down is a speck, not a line. */
export const SPECK_PX = 3

/**
 * The edge pixels that belong to a line: each group of touching edge pixels (by side or corner) that spans at least
 * SPECK_PX screen px across or down. A smaller group (a speck or a short dash where a round's facets graze the view)
 * is left out, so curves stay clean.
 */
export function lineEdges(r: Raster): Uint8Array {
  const out = new Uint8Array(r.edge.length)
  const seen = new Uint8Array(r.edge.length)
  const span = SPECK_PX * r.px
  const group: number[] = []
  for (let s = 0; s < r.edge.length; s++) {
    if (!r.edge[s] || seen[s]) continue
    group.length = 0
    group.push(s)
    seen[s] = 1
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
    for (let g = 0; g < group.length; g++) {
      const i = group[g]!
      const x = i % r.W
      const y = (i - x) / r.W
      ;[x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)]
      for (let j = -1; j <= 1; j++) {
        for (let k = -1; k <= 1; k++) {
          const n = i + j * r.W + k
          if (x + k >= 0 && y + j >= 0 && x + k < r.W && y + j < r.H && r.edge[n] && !seen[n]) {
            seen[n] = 1
            group.push(n)
          }
        }
      }
    }
    if (Math.max(x1 - x0, y1 - y0) + 1 >= span) for (const i of group) out[i] = 1
  }
  return out
}

/**
 * The edges as they are painted: about 1.5 screen px wide (2 device px at the least, so a 1x screen gets more than a
 * hairline), grown right and down into the part only, so the silhouette keeps its size over the card. Specks are left
 * out (lineEdges).
 */
export function paintedEdges(r: Raster): Uint8Array {
  const grow = Math.max(2, Math.round(1.5 * r.px)) - 1
  const out = new Uint8Array(r.edge.length)
  const line = lineEdges(r)
  for (let y = 0; y < r.H; y++) {
    for (let x = 0; x < r.W; x++) {
      if (!line[y * r.W + x]) continue
      for (let j = 0; j <= grow && y + j < r.H; j++) {
        for (let i = 0; i <= grow && x + i < r.W; i++) {
          const k = (y + j) * r.W + x + i
          if (i + j === 0 || r.cover[k]) out[k] = 1
        }
      }
    }
  }
  return out
}

export interface DrawnDim {
  key: string
  n: number
  guess: boolean
  lines: [P2, P2][]
  /** From the size's midpoint to its callout, when the callout had to move off its line. */
  leader: [P2, P2] | null
  /** The size is measured over the part, so its leader starts on a dot. */
  inside: boolean
  /** Where each arrow points, and the point it comes from. */
  arrows: [P2, P2][]
  arc: P2[] | null
  badge: P2
}

export interface DrawnView {
  /** The part, as a raster of its silhouette and visible edges over the w x h cell. */
  part: Raster
  dims: DrawnDim[]
}

const r1 = (v: number): number => Math.round(v * 10) / 10

/** The projection of a view, in mm on screen axes (y down), before it is fitted. */
const project = (view: ViewName) => {
  const { r, u } = VIEWS[view]
  return (p: V3): P2 => [dot(p, r), -dot(p, u)]
}

interface RawDim {
  key: string
  n: number
  guess: boolean
  lines: [P2, P2][]
  /** The same lines in the part's mm, for telling where one runs behind the part. */
  lines3: [V3, V3][]
  dimLine: [P2, P2] | null
  arc: P2[] | null
  /** The way the callout moves off its line, on screen. */
  push: P2
  mid: P2
}

function rawDims(dims: readonly PilotDim[], view: ViewName, shown: Map<string, ViewName[]>): RawDim[] {
  const P = project(view)
  const out: RawDim[] = []
  dims.forEach((d, i) => {
    const at = d.at
    if (!at || !shown.get(d.key)?.includes(view)) return
    const base = { key: d.key, n: i + 1, guess: d.source === 'guess' }
    if ('c' in at) {
      const from = nrm(at.from)
      const turn = Math.acos(Math.max(-1, Math.min(1, dot(from, nrm(at.to)))))
      const w = nrm(sub(nrm(at.to), mul(from, dot(from, nrm(at.to)))))
      const pt = (t: number, rr: number): V3 => add(at.c, add(mul(from, rr * Math.cos(t)), mul(w, rr * Math.sin(t))))
      const arc = Array.from({ length: 25 }, (_, k) => P(pt((turn * k) / 24, at.r)))
      const [mx, my] = P(pt(turn / 2, at.r * 2))
      const [cx, cy] = P(at.c)
      const midDir: P2 = [mx - cx, my - cy]
      const lines3: [V3, V3][] = [[at.c, pt(0, at.r * 1.15)], [at.c, pt(turn, at.r * 1.15)]]
      out.push({ ...base, lines: lines3.map(([p, q]) => [P(p), P(q)]), lines3, dimLine: null, arc, push: midDir, mid: P(pt(turn / 2, at.r)) })
      return
    }
    const a1 = add(at.a, at.off)
    const b1 = add(at.b, at.off)
    const lines3: [V3, V3][] = len(at.off) > 0 ? [[at.a, a1], [at.b, b1]] : []
    const lines = lines3.map(([p, q]): [P2, P2] => [P(p), P(q)])
    const pa = P(a1)
    const pb = P(b1)
    // the projection is linear, so the offset projects to the way out on screen
    const push: P2 = len(at.off) > 0 ? P(at.off) : [-(pb[1] - pa[1]), pb[0] - pa[0]]
    out.push({ ...base, lines, lines3, dimLine: [pa, pb], arc: null, push, mid: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2] })
  })
  return out
}

/** The bounds of a view's part and dimension lines, in mm on screen axes. */
function bounds(shape: Shape, raws: readonly RawDim[], view: ViewName): { x0: number; y0: number; x1: number; y1: number } {
  const P = project(view)
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  const take = (p: P2) => {
    x0 = Math.min(x0, p[0])
    y0 = Math.min(y0, p[1])
    x1 = Math.max(x1, p[0])
    y1 = Math.max(y1, p[1])
  }
  const { r: vr, u: vu } = VIEWS[view]
  const q = shape.pts
  for (let i = 0; i + 2 < q.length; i += 3) take([q[i]! * vr[0] + q[i + 1]! * vr[1] + q[i + 2]! * vr[2], -(q[i]! * vu[0] + q[i + 1]! * vu[1] + q[i + 2]! * vu[2])])
  for (const r of raws) {
    if (r.dimLine) r.dimLine.forEach(take)
    if (r.arc) r.arc.forEach(take)
  }
  return x0 === Infinity ? { x0: -1, y0: -1, x1: 1, y1: 1 } : { x0, y0, x1, y1 }
}

/** How far out a size may move to clear the part in Iso, as a share of how far out it was set. */
const CLEAR_MAX = 3
/** The steps it moves out by, as a share of how far out it was set. */
const CLEAR_STEP = 0.25
/**
 * The least room between a size's line and the part in Iso, in px: room for an extension line that comes out from
 * behind the part to show (it starts 3 px clear of the part and needs 4 px to be drawn shortened, unhide), and a little.
 */
export const CLEAR_ROOM_PX = 10

/**
 * The rows as Iso draws them. A size set out from the part (a diameter under a tube's foot) can still run across the
 * part in Iso, or close under it, since the plane it sits in passes behind the part's near side there. Each size whose
 * line comes within CLEAR_ROOM_PX of the part, at `k` px per mm, moves further out along its own way out, in steps of
 * a quarter of how far out it was set, until it is that far clear (at most three times further out). Every size set
 * out the same way moves out by the most any of them needed, so a stack of sizes keeps its order and spacing. Sizes
 * measured over the part (with no way out) stay where they are.
 */
export function clearInIso(shape: Shape, dims: readonly PilotDim[], k: number): PilotDim[] {
  const P = project('iso')
  const outs = dims.filter((d) => d.at && 'a' in d.at && len(d.at.off) > 0)
  if (!outs.length || !shape.pts.length) return [...dims]
  // the part drawn small, about 240 px across, which is enough to tell how near a line runs to it
  const b = bounds(shape, [], 'iso')
  const s = 240 / Math.max(1e-6, b.x1 - b.x0, b.y1 - b.y0)
  const room = Math.max(1.5, (CLEAR_ROOM_PX / Math.max(1e-6, k)) * s)
  const edge = Math.ceil(room) + 2
  const [W, H] = [Math.ceil((b.x1 - b.x0) * s) + 2 * edge, Math.ceil((b.y1 - b.y0) * s) + 2 * edge]
  const [ox, oy] = [edge - b.x0 * s, edge - b.y0 * s]
  const ras = rasterize(shape, 'iso', W, H, s, ox, oy, 1)
  // each pixel's distance to the part, in px (two passes of a 3-4 chamfer, a third of a px off at worst)
  const far = new Float32Array(W * H)
  for (let i = 0; i < far.length; i++) far[i] = ras.cover[i] ? 0 : Infinity
  const pass = (from: number, to: number, step: number, look: [number, number, number][]) => {
    for (let y = from; y !== to; y += step) {
      for (let x = step > 0 ? 0 : W - 1; step > 0 ? x < W : x >= 0; x += step) {
        let v = far[y * W + x]!
        for (const [dx, dy, c] of look) {
          const [nx, ny] = [x + dx * step, y + dy * step]
          if (nx >= 0 && ny >= 0 && nx < W && ny < H) v = Math.min(v, far[ny * W + nx]! + c)
        }
        far[y * W + x] = v
      }
    }
  }
  const look: [number, number, number][] = [[-1, 0, 1], [0, -1, 1], [-1, -1, Math.SQRT2], [1, -1, Math.SQRT2]]
  pass(0, H, 1, look)
  pass(H - 1, -1, -1, look)
  const near = (x: number, y: number): boolean => {
    const [cx, cy] = [Math.floor(x * s + ox), Math.floor(y * s + oy)]
    return cx >= 0 && cy >= 0 && cx < W && cy < H && far[cy * W + cx]! < room
  }
  const tooNear = (a: V3, c: V3): boolean => {
    const [p, q] = [P(a), P(c)]
    const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) * s * 2))
    for (let i = 0; i <= n; i++) if (near(p[0] + ((q[0] - p[0]) * i) / n, p[1] + ((q[1] - p[1]) * i) / n)) return true
    return false
  }
  const way = (off: V3): string => nrm(off).map((v) => v.toFixed(3)).join(',')
  // the most each way out needs, in mm
  const need = new Map<string, number>()
  for (const d of outs) {
    const at = d.at as Extract<PilotDimAt, { a: V3 }>
    for (let m = 0; m <= CLEAR_MAX + 1e-9; m += CLEAR_STEP) {
      const off = mul(at.off, 1 + m)
      if (tooNear(add(at.a, off), add(at.b, off))) continue
      if (m > 0) need.set(way(at.off), Math.max(need.get(way(at.off)) ?? 0, m * len(at.off)))
      break
    }
  }
  if (!need.size) return [...dims]
  return dims.map((d) => {
    if (!d.at || !('a' in d.at) || len(d.at.off) === 0) return d
    const more = need.get(way(d.at.off))
    return more ? { ...d, at: { ...d.at, off: add(d.at.off, mul(nrm(d.at.off), more)) } } : d
  })
}

const fit = (b: { x0: number; y0: number; x1: number; y1: number }, w: number, h: number, pad: number): number =>
  Math.max(0.01, Math.min((w - 2 * pad) / Math.max(1e-6, b.x1 - b.x0), (h - 2 * pad) / Math.max(1e-6, b.y1 - b.y0)))

/**
 * The rows as a view draws them: Iso moves the ones that would run across the part (clearInIso), giving their lines
 * their room at `scale`, or at the most the part alone could be drawn at in a w x h cell.
 */
const placedIn = (shape: Shape, dims: readonly PilotDim[], view: ViewName, w: number, h: number, pad: number, scale?: number): readonly PilotDim[] =>
  view === 'iso' ? clearInIso(shape, dims, scale ?? fit(bounds(shape, [], view), w, h, pad)) : dims

/** Pixels per mm that fit a view's drawing in a w x h cell with `pad` around it. */
export function fitScale(shape: Shape, dims: readonly PilotDim[], view: ViewName, w: number, h: number, pad: number, order: readonly ViewName[] = []): number {
  return fit(bounds(shape, rawDims(placedIn(shape, dims, view, w, h, pad), view, viewsFor(dims, order)), view), w, h, pad)
}

export const BADGE_R = 10
/** The least room between two callouts' edges, in px. */
export const BADGE_GAP = 6

/** Offsets over a callout's disk and just past its rim, every 2 px, for keeping the whole callout off the part. */
const DISK: readonly P2[] = (() => {
  const out: P2[] = []
  const R = BADGE_R + 2
  for (let y = -R; y <= R; y += 2) for (let x = -R; x <= R; x += 2) if (x * x + y * y <= R * R) out.push([x, y])
  for (let i = 0; i < 24; i++) out.push([R * Math.cos((i * Math.PI) / 12), R * Math.sin((i * Math.PI) / 12)])
  return out
})()

/** The distance from point p to the segment a b. */
function toSegment(p: P2, a: P2, b: P2): number {
  const vx = b[0] - a[0]
  const vy = b[1] - a[1]
  const l2 = vx * vx + vy * vy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2))
  return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy)
}

/** True when the segments a b and c d cross away from their ends. */
function crosses(a: P2, b: P2, c: P2, d: P2): boolean {
  const side = (p: P2, q: P2, r: P2): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const d1 = side(c, d, a)
  const d2 = side(c, d, b)
  const d3 = side(a, b, c)
  const d4 = side(a, b, d)
  return d1 * d2 < 0 && d3 * d4 < 0
}

/**
 * A line on screen whose start the part hides (`hiddenAt(t)` along it, t 0 at its start, 1 at its end, sampled twice a
 * px) starts where it comes out from behind the part, 3 px clear of the outline. A line hidden all the way, or out from
 * behind so near its end that less than 4 px of it would be left, is drawn whole, so the size still reads.
 */
export function unhide(l: [P2, P2], hiddenAt: (t: number) => boolean): [P2, P2] {
  const [p, q] = l
  const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) * 2)
  if (n < 2 || !hiddenAt(0)) return l
  for (let i = 1; i <= n; i++) {
    const t = i / n
    if (hiddenAt(t)) continue
    const s = t + 3 / (n / 2)
    if (s > 1 - 4 / (n / 2)) return l
    return [[r1(p[0] + (q[0] - p[0]) * s), r1(p[1] + (q[1] - p[1]) * s)], q]
  }
  return l
}

/**
 * One view of the sheet, fitted in a w x h cell at `scale` pixels per mm (or its own fit when absent): the part as its
 * silhouette and visible edges (`px` device pixels per screen pixel, 1 by default; `part` reuses a raster already drawn
 * at the same fit), and the sizes that read in it with their callouts. A callout sits off the part (its whole disk),
 * clear of the other callouts and of every dimension line, and inside the cell; one that moved from its line gets a
 * leader, and leaders do not cross.
 */
export function drawView(shape: Shape, dims: readonly PilotDim[], view: ViewName, w: number, h: number, opts: { scale?: number; pad?: number; order?: readonly ViewName[]; px?: number; part?: Raster } = {}): DrawnView {
  const pad = opts.pad ?? 30
  const px = opts.px ?? 1
  const raws = rawDims(placedIn(shape, dims, view, w, h, pad, opts.scale), view, viewsFor(dims, opts.order ?? []))
  const b = bounds(shape, raws, view)
  const k = opts.scale ?? fit(b, w, h, pad)
  const ox = (w - (b.x1 - b.x0) * k) / 2 - b.x0 * k
  const oy = (h - (b.y1 - b.y0) * k) / 2 - b.y0 * k
  const S = (p: P2): P2 => [r1(p[0] * k + ox), r1(p[1] * k + oy)]
  const W = Math.max(1, Math.round(w * px))
  const H = Math.max(1, Math.round(h * px))
  const part = opts.part && opts.part.W === W && opts.part.H === H ? opts.part : rasterize(shape, view, W, H, k, ox, oy, px)
  // the part on screen: a size measured over it gets its callout off it, on a leader
  const inside = (p: P2): boolean => {
    const x = Math.floor(p[0] * px)
    const y = Math.floor(p[1] * px)
    return x >= 0 && y >= 0 && x < part.W && y < part.H && part.cover[y * part.W + x] === 1
  }
  // A line from a place the part hides (the middle of a tube, seen in Iso) starts where it comes out from behind the
  // part, a little clear of it, rather than being drawn over the part's near side.
  const dv = VIEWS[view].d
  const hideTol = Math.max(1, 3 / k)
  const hidden = (p: P2, q3: V3): boolean => {
    const x = Math.floor(p[0] * px)
    const y = Math.floor(p[1] * px)
    if (x < 0 || y < 0 || x >= part.W || y >= part.H || !part.cover[y * part.W + x]) return false
    return part.depth[y * part.W + x]! > dot(q3, dv) + hideTol
  }
  const unhidden = (l: [P2, P2], l3: [V3, V3]): [P2, P2] => {
    const [p, q] = l
    return unhide(l, (t) => hidden([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t], add(l3[0], mul(sub(l3[1], l3[0]), t))))
  }
  // every size's own lines first, so no callout lands on a line drawn after it
  const shaped = raws.map((r) => {
    const lines = r.lines.map(([p, q], i) => unhidden([S(p), S(q)], r.lines3[i]!))
    const arrows: [P2, P2][] = []
    let dimLines: [P2, P2][] = []
    if (r.dimLine) {
      const [a, bb] = [S(r.dimLine[0]), S(r.dimLine[1])]
      const l = Math.hypot(bb[0] - a[0], bb[1] - a[1]) || 1
      const ux = (bb[0] - a[0]) / l
      const uy = (bb[1] - a[1]) / l
      if (l > 26) {
        dimLines = [[a, bb]]
        arrows.push([a, bb], [bb, a])
      } else {
        // too short for arrows inside: they point in from outside
        const ao: P2 = [r1(a[0] - ux * 14), r1(a[1] - uy * 14)]
        const bo: P2 = [r1(bb[0] + ux * 14), r1(bb[1] + uy * 14)]
        dimLines = [[ao, bo]]
        arrows.push([a, ao], [bb, bo])
      }
    }
    const arc = r.arc ? r.arc.map(S) : null
    if (arc && arc.length > 1) arrows.push([arc[0]!, arc[1]!], [arc.at(-1)!, arc.at(-2)!])
    const segs: [P2, P2][] = [...lines, ...dimLines, ...(arc ? arc.slice(1).map((p, i) => [arc[i]!, p] as [P2, P2]) : [])]
    return { r, lines: [...lines, ...dimLines], arrows, arc, segs }
  })
  const allSegs = shaped.flatMap((s) => s.segs)
  const placed: P2[] = []
  const leaders: [P2, P2][] = []
  const drawn = shaped.map(({ r, lines, arrows, arc }): DrawnDim => {
    const pl = Math.hypot(r.push[0], r.push[1]) || 1
    let ux = r.push[0] / pl
    let uy = r.push[1] / pl
    const m = S(r.mid)
    const leaderOf = (bd: P2): [P2, P2] | null => {
      const gap = Math.hypot(bd[0] - m[0], bd[1] - m[1])
      return gap > BADGE_R + 5 ? [m, [r1(bd[0] - ((bd[0] - m[0]) / gap) * BADGE_R), r1(bd[1] - ((bd[1] - m[1]) / gap) * BADGE_R)]] : null
    }
    const clash = (bd: P2): boolean => placed.some((p) => Math.hypot(p[0] - bd[0], p[1] - bd[1]) < 2 * BADGE_R + BADGE_GAP)
    // the whole disk off the part, not only its center and a few rim points: a thin arm fits between those
    const onPart = (bd: P2): boolean => DISK.some(([dx, dy]) => inside([bd[0] + dx, bd[1] + dy]))
    const inCell = (bd: P2): boolean => bd[0] >= BADGE_R + 2 && bd[0] <= w - BADGE_R - 2 && bd[1] >= BADGE_R + 2 && bd[1] <= h - BADGE_R - 2
    // clear of every size's lines and every leader drawn so far, and its own leader crossing none of them or another callout
    const onLines = (bd: P2): boolean => allSegs.some(([p, q]) => toSegment(bd, p, q) < BADGE_R + 1) || leaders.some(([p, q]) => toSegment(bd, p, q) < BADGE_R + 2)
    const tangled = (bd: P2): boolean => {
      const l = leaderOf(bd)
      return !!l && (leaders.some(([p, q]) => crosses(l[0], l[1], p, q)) || placed.some((p) => toSegment(p, l[0], l[1]) < BADGE_R + 2))
    }
    // a leader that leaves the part (or starts off it) and then runs over it again, to a callout on its far side
    const overPart = (bd: P2): boolean => {
      const l = leaderOf(bd)
      if (!l) return false
      const [p, q] = l
      const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) * px * 2)
      let off = false
      for (let i = 0; i <= n; i++) {
        const t = i / Math.max(1, n)
        if (!inside([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t])) off = true
        else if (off) return true
      }
      return false
    }
    const free = (bd: P2): boolean => inCell(bd) && !clash(bd) && !onPart(bd) && !onLines(bd) && !tangled(bd) && !overPart(bd)
    const loose = (bd: P2): boolean => inCell(bd) && !clash(bd) && !onPart(bd)
    const leads = inside(m) && (ux !== 0 || uy !== 0)
    let tries: P2[]
    if (leads) {
      // out past the part's edge on the nearer side along its way out, then a callout's width further
      const exit = (vx: number, vy: number): number => {
        let t = 0
        while (t < w + h && inside([m[0] + vx * t, m[1] + vy * t])) t += 2
        return t
      }
      if (exit(-ux, -uy) < exit(ux, uy) - 1) [ux, uy] = [-ux, -uy]
      const reach = exit(ux, uy) + BADGE_R + 6
      const at = (s: number, out: number): P2 => [r1(m[0] + ux * (reach + out) - uy * s), r1(m[1] + uy * (reach + out) + ux * s)]
      // a callout already there: beside it along the outline, then the other side, then further out
      const steps = [0, 1, -1, 2, -2, 3, -3].map((i) => i * (2 * BADGE_R + BADGE_GAP))
      tries = [0, 10, 20, 30, 40].flatMap((out) => steps.map((s) => at(s, out)))
    } else {
      // beside its own line, then further out along its way out
      const out = ux === 0 && uy === 0 ? ([0, -1] as P2) : ([ux, uy] as P2)
      tries = Array.from({ length: 14 }, (_, i): P2 => [r1(m[0] + out[0] * (BADGE_R + 3 + 8 * i)), r1(m[1] + out[1] * (BADGE_R + 3 + 8 * i))])
    }
    // then the nearest spot around the size itself, never around a spot pushed into a corner of the cell
    const around = (ok: (p: P2) => boolean): P2 | null => {
      for (let rr = 2 * BADGE_R; rr < w + h; rr += 6) {
        const n = Math.max(16, Math.ceil((2 * Math.PI * rr) / 10))
        for (let a = 0; a < n; a++) {
          const p: P2 = [r1(m[0] + rr * Math.cos((a * 2 * Math.PI) / n)), r1(m[1] + rr * Math.sin((a * 2 * Math.PI) / n))]
          if (ok(p)) return p
        }
      }
      return null
    }
    let badge = tries.find(free) ?? around(free) ?? tries.find(loose) ?? around(loose) ?? tries[0]!
    badge = [r1(Math.min(w - BADGE_R - 2, Math.max(BADGE_R + 2, badge[0]))), r1(Math.min(h - BADGE_R - 2, Math.max(BADGE_R + 2, badge[1])))]
    placed.push(badge)
    // every callout that does not sit on its own line gets a leader to it, so its target is never a guess
    const leader = leaderOf(badge)
    if (leader) leaders.push(leader)
    return { key: r.key, n: r.n, guess: r.guess, lines, leader, inside: leads, arrows, arc, badge }
  })
  return { part, dims: drawn }
}

/** An arrowhead at `tip`, pointing away from `from`. */
export function arrowHead(tip: P2, from: P2, size = 6, half = 2.6): string {
  const l = Math.hypot(tip[0] - from[0], tip[1] - from[1]) || 1
  const ux = (tip[0] - from[0]) / l
  const uy = (tip[1] - from[1]) / l
  return [tip, [tip[0] - ux * size - uy * half, tip[1] - uy * size + ux * half], [tip[0] - ux * size + uy * half, tip[1] - uy * size - ux * half]].map((p) => `${r1(p[0]!)},${r1(p[1]!)}`).join(' ')
}
