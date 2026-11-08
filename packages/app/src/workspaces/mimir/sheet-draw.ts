// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The dimension sheet's drawing: the part a sheet describes, drawn front, top, right and iso, with each size as a
// dimension line and a numbered callout that matches its row. The part is the design as built when the sheet changes
// one, else the sheet's own solids, drawn the same way: its silhouette and its visible edges, as a technical drawing
// shows a part. Pure geometry, in screen pixels, so the drawing component only paints it.
import type { PilotDim, PilotDimAt, PilotSheetSolid } from '@slicerx/contracts'

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

const to3 = (plane: PilotSheetSolid['plane'], u: number, v: number, t: number): V3 => (plane === 'xy' ? [u, v, t] : plane === 'xz' ? [u, t, v] : [t, u, v])

const area = (pts: readonly P2[]): number => pts.reduce((s, p, i) => {
  const q = pts[(i + 1) % pts.length]!
  return s + p[0] * q[1] - q[0] * p[1]
}, 0)

/** Counterclockwise for the outline, clockwise for a hole, so every side's normal points out of the material. */
const orient = (pts: readonly P2[], ccw: boolean): P2[] => (area(pts) > 0 === ccw ? [...pts] : [...pts].reverse())

/** A solid's faces: a side for each edge of its outline and holes, and its two caps (holes cut through them). */
export function solidFaces(s: PilotSheetSolid): Face[] {
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
 * What a view draws: planar polygons in the part's mm with Z up, each an outline and the holes in it. A sheet's own
 * solids become their faces, and a built design's mesh its triangles, so both draw the same way.
 */
export interface Shape {
  polys: V3[][][]
  /** Every corner once per polygon ring, for the bounds. */
  pts: V3[]
}

/** The shape of a sheet's solids: each solid's sides and caps. */
export function shapeOfSolids(part: readonly PilotSheetSolid[]): Shape {
  const polys = part.flatMap(solidFaces).map((f) => [f.pts, ...(f.holes ?? [])])
  return { polys, pts: polys.flatMap((p) => p[0]!) }
}

/** A mesh as world triangles, `positions` and `indices` as the engine gives them, already in the design's frame. */
export interface SheetMesh {
  positions: ArrayLike<number>
  indices: ArrayLike<number>
}

/** The shape of a built design: every triangle of its parts. */
export function shapeOfMesh(meshes: readonly SheetMesh[]): Shape {
  const polys: V3[][][] = []
  const pts: V3[] = []
  for (const m of meshes) {
    const at = (i: number): V3 => [m.positions[3 * i]!, m.positions[3 * i + 1]!, m.positions[3 * i + 2]!]
    for (let t = 0; t + 2 < m.indices.length; t += 3) {
      const tri = [at(m.indices[t]!), at(m.indices[t + 1]!), at(m.indices[t + 2]!)]
      polys.push([tri])
    }
    for (let i = 0; 3 * i + 2 < m.positions.length; i++) pts.push(at(i))
  }
  return { polys, pts }
}

/** The shape's bounds in mm: least and most corner. */
export function shapeBounds(shape: Shape): { lo: V3; hi: V3 } | null {
  if (!shape.pts.length) return null
  const lo: V3 = [Infinity, Infinity, Infinity]
  const hi: V3 = [-Infinity, -Infinity, -Infinity]
  for (const p of shape.pts) for (let k = 0; k < 3; k++) ((lo[k] = Math.min(lo[k]!, p[k]!)), (hi[k] = Math.max(hi[k]!, p[k]!)))
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
}

/** Faces meeting at more than this read as an edge; a round's facets meet at less. */
const EDGE_DEG = 28
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

/**
 * Draws a shape into a W x H raster: `toScreen` maps a point to device pixels (x right, y down) and its depth (larger
 * nearer the viewer), the same for every point, so a polygon's depth is a plane over its pixels.
 */
export function rasterize(shape: Shape, view: ViewName, W: number, H: number, k: number, ox: number, oy: number, px: number): Raster {
  const { r, u, d } = VIEWS[view]
  const n = W * H
  const depth = new Float32Array(n).fill(-Infinity)
  const owner = new Int32Array(n).fill(-1)
  // per polygon: its normal and how its depth changes per device pixel across and down
  const normals: V3[] = []
  const grad: [number, number][] = []
  const S = k * px
  shape.polys.forEach((rings, pi) => {
    const nn = newell(rings[0]!)
    normals.push(nn)
    const nd = dot(nn, d)
    // seen edge on: it covers no pixel of its own, its neighbors draw the line
    if (Math.abs(nd) < 1e-4) {
      grad.push([0, 0])
      return
    }
    // on the plane, depth moves by -(n.r)/(n.d) per mm right and +(n.u)/(n.d) per mm down the screen
    const gx = -dot(nn, r) / nd / S
    const gy = dot(nn, u) / nd / S
    grad.push([gx, gy])
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
  const cover = new Uint8Array(n)
  const edge = new Uint8Array(n)
  for (let i = 0; i < n; i++) cover[i] = owner[i]! >= 0 ? 1 : 0
  // how far depth may stray from the nearer pixel's plane before it is another surface: a pixel and a half, or 0.05 mm
  const tol = Math.max(0.05, 1.5 / S)
  const differs = (i: number, j: number, dx: number, dy: number): boolean => {
    const a = owner[i]!
    const b = owner[j]!
    if (a < 0 && b < 0) return false
    if (a < 0 || b < 0 || a === b) return a !== b
    if (Math.abs(dot(normals[a]!, normals[b]!)) < EDGE_COS) return true
    const [gx, gy] = grad[a]!
    return Math.abs(depth[j]! - (depth[i]! + gx * dx + gy * dy)) > tol
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
  return { W, H, px, cover, edge }
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
      out.push({ ...base, lines: [[P(at.c), P(pt(0, at.r * 1.15))], [P(at.c), P(pt(turn, at.r * 1.15))]], dimLine: null, arc, push: midDir, mid: P(pt(turn / 2, at.r)) })
      return
    }
    const a1 = add(at.a, at.off)
    const b1 = add(at.b, at.off)
    const lines: [P2, P2][] = len(at.off) > 0 ? [[P(at.a), P(a1)], [P(at.b), P(b1)]] : []
    const pa = P(a1)
    const pb = P(b1)
    // the projection is linear, so the offset projects to the way out on screen
    const push: P2 = len(at.off) > 0 ? P(at.off) : [-(pb[1] - pa[1]), pb[0] - pa[0]]
    out.push({ ...base, lines, dimLine: [pa, pb], arc: null, push, mid: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2] })
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
  for (const p of shape.pts) take(P(p))
  for (const r of raws) {
    if (r.dimLine) r.dimLine.forEach(take)
    if (r.arc) r.arc.forEach(take)
  }
  return x0 === Infinity ? { x0: -1, y0: -1, x1: 1, y1: 1 } : { x0, y0, x1, y1 }
}

/** Pixels per mm that fit a view's drawing in a w x h cell with `pad` around it. */
export function fitScale(shape: Shape, dims: readonly PilotDim[], view: ViewName, w: number, h: number, pad: number, order: readonly ViewName[] = []): number {
  const b = bounds(shape, rawDims(dims, view, viewsFor(dims, order)), view)
  return Math.max(0.01, Math.min((w - 2 * pad) / Math.max(1e-6, b.x1 - b.x0), (h - 2 * pad) / Math.max(1e-6, b.y1 - b.y0)))
}

const BADGE_R = 10
/** Points around a callout's rim, for keeping it off the part. */
const RIM: readonly P2[] = Array.from({ length: 8 }, (_, i) => [Math.cos((i * Math.PI) / 4), Math.sin((i * Math.PI) / 4)] as P2)

/**
 * One view of the sheet, fitted in a w x h cell at `scale` pixels per mm (or its own fit when absent): the part as its
 * silhouette and visible edges (`px` device pixels per screen pixel, 1 by default), and the sizes that read in it with
 * their callouts. Callouts that would overlap are moved apart along their own way out, and none leaves the cell.
 */
export function drawView(shape: Shape, dims: readonly PilotDim[], view: ViewName, w: number, h: number, opts: { scale?: number; pad?: number; order?: readonly ViewName[]; px?: number } = {}): DrawnView {
  const pad = opts.pad ?? 30
  const px = opts.px ?? 1
  const raws = rawDims(dims, view, viewsFor(dims, opts.order ?? []))
  const b = bounds(shape, raws, view)
  const k = opts.scale ?? fitScale(shape, dims, view, w, h, pad, opts.order)
  const ox = (w - (b.x1 - b.x0) * k) / 2 - b.x0 * k
  const oy = (h - (b.y1 - b.y0) * k) / 2 - b.y0 * k
  const S = (p: P2): P2 => [r1(p[0] * k + ox), r1(p[1] * k + oy)]
  const part = rasterize(shape, view, Math.max(1, Math.round(w * px)), Math.max(1, Math.round(h * px)), k, ox, oy, px)
  // the part on screen: a size measured over it gets its callout off it, on a leader
  const inside = (p: P2): boolean => {
    const x = Math.floor(p[0] * px)
    const y = Math.floor(p[1] * px)
    return x >= 0 && y >= 0 && x < part.W && y < part.H && part.cover[y * part.W + x] === 1
  }
  const placed: P2[] = []
  const drawn = raws.map((r): DrawnDim => {
    const lines = r.lines.map(([p, q]) => [S(p), S(q)] as [P2, P2])
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
    const pl = Math.hypot(r.push[0], r.push[1]) || 1
    let ux = r.push[0] / pl
    let uy = r.push[1] / pl
    const m = S(r.mid)
    const clash = (b: P2): boolean => placed.some((p) => Math.hypot(p[0] - b[0], p[1] - b[1]) < 2 * BADGE_R + 3)
    // a callout never sits on the part: its center and its rim stay off it, and it stays in the cell
    const onPart = (b: P2): boolean => inside(b) || RIM.some(([cx, cy]) => inside([b[0] + cx * (BADGE_R + 2), b[1] + cy * (BADGE_R + 2)]))
    const inCell = (b: P2): boolean => b[0] >= BADGE_R + 2 && b[0] <= w - BADGE_R - 2 && b[1] >= BADGE_R + 2 && b[1] <= h - BADGE_R - 2
    const free = (b: P2): boolean => !clash(b) && !onPart(b) && inCell(b)
    const leads = inside(m) && (ux !== 0 || uy !== 0)
    let badge: P2
    if (leads) {
      // out past the part's edge on the nearer side along its way out, then a callout's width further
      const exit = (vx: number, vy: number): number => {
        let t = 0
        while (t < w + h && inside([m[0] + vx * t, m[1] + vy * t])) t += 2
        return t
      }
      if (exit(-ux, -uy) < exit(ux, uy) - 1) [ux, uy] = [-ux, -uy]
      const reach = exit(ux, uy) + BADGE_R + 6
      const at = (k: number, out: number): P2 => [m[0] + ux * (reach + out) - uy * k, m[1] + uy * (reach + out) + ux * k]
      // a callout already there: beside it along the outline, then the other side, then further out
      const steps = [0, 1, -1, 2, -2, 3, -3].map((i) => i * (2 * BADGE_R + 5))
      const tries = [0, 8, 16, 24, 32].flatMap((out) => steps.map((k) => at(k, out)))
      badge = tries.find(free) ?? tries.find((b) => !clash(b)) ?? at(0, 0)
    } else {
      badge = [m[0] + ux * (BADGE_R + 3), m[1] + uy * (BADGE_R + 3)]
      // apart from the callouts already placed and off the part, then inside the cell
      for (let tries = 0; tries < 12 && (clash(badge) || onPart(badge)); tries++) badge = [badge[0] + ux * 8 + (ux === 0 && uy === 0 ? 8 : 0), badge[1] + uy * 8]
    }
    badge = [r1(Math.min(w - BADGE_R - 2, Math.max(BADGE_R + 2, badge[0]))), r1(Math.min(h - BADGE_R - 2, Math.max(BADGE_R + 2, badge[1])))]
    // kept in the cell it landed on another callout or on the part: the nearest free spot around it, off the part when
    // there is one, so a callout never covers the part it labels
    if (clash(badge) || onPart(badge)) {
      const spots: P2[] = []
      for (let rr = 8; rr < w + h; rr += 6) for (let a = 0; a < 16; a++) spots.push([r1(badge[0] + rr * Math.cos((a * Math.PI) / 8)), r1(badge[1] + rr * Math.sin((a * Math.PI) / 8))])
      badge = spots.find(free) ?? spots.find((b) => !clash(b) && inCell(b)) ?? badge
    }
    placed.push(badge)
    const gap = Math.hypot(badge[0] - m[0], badge[1] - m[1])
    // every callout that does not sit on its own line gets a leader to it, so its target is never a guess
    const leader: [P2, P2] | null = gap > BADGE_R + 5 ? [m, [r1(badge[0] - ((badge[0] - m[0]) / gap) * BADGE_R), r1(badge[1] - ((badge[1] - m[1]) / gap) * BADGE_R)]] : null
    return { key: r.key, n: r.n, guess: r.guess, lines: [...lines, ...dimLines], leader, inside: leads, arrows, arc, badge }
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
