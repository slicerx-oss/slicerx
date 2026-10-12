// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The dimension sheet's drawing: the part a sheet describes, drawn front, top, right and iso, with each size as a
// dimension line and a numbered callout that matches its row. Pure geometry, in screen pixels, so the drawing
// component only paints it.
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

const LIGHT = nrm([0.35, -0.55, 0.75])

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

export interface DrawnFace {
  points: string
  /** Its outline and holes as one path, holes cut out with even-odd. */
  path: string
  /** How much of the part's light color it takes, 38 to 100. */
  light: number
}

export interface DrawnDim {
  key: string
  n: number
  guess: boolean
  lines: [P2, P2][]
  /** Where each arrow points, and the point it comes from. */
  arrows: [P2, P2][]
  arc: P2[] | null
  badge: P2
}

export interface DrawnView {
  faces: DrawnFace[]
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
function bounds(faces: readonly Face[], raws: readonly RawDim[], view: ViewName): { x0: number; y0: number; x1: number; y1: number } {
  const P = project(view)
  const pts: P2[] = faces.flatMap((f) => f.pts.map(P))
  for (const r of raws) {
    if (r.dimLine) pts.push(...r.dimLine)
    if (r.arc) pts.push(...r.arc)
  }
  if (!pts.length) return { x0: -1, y0: -1, x1: 1, y1: 1 }
  return {
    x0: Math.min(...pts.map((p) => p[0])),
    y0: Math.min(...pts.map((p) => p[1])),
    x1: Math.max(...pts.map((p) => p[0])),
    y1: Math.max(...pts.map((p) => p[1])),
  }
}

/** Pixels per mm that fit a view's drawing in a w x h cell with `pad` around it. */
export function fitScale(part: readonly PilotSheetSolid[], dims: readonly PilotDim[], view: ViewName, w: number, h: number, pad: number, order: readonly ViewName[] = []): number {
  const b = bounds(part.flatMap(solidFaces), rawDims(dims, view, viewsFor(dims, order)), view)
  return Math.max(0.01, Math.min((w - 2 * pad) / Math.max(1e-6, b.x1 - b.x0), (h - 2 * pad) / Math.max(1e-6, b.y1 - b.y0)))
}

const BADGE_R = 10

/**
 * One view of the sheet, fitted in a w x h cell at `scale` pixels per mm (or its own fit when absent): the visible
 * faces back to front, shaded, and the sizes that read in it with their callouts. Callouts that would overlap are moved
 * apart along their own way out, and none leaves the cell.
 */
export function drawView(part: readonly PilotSheetSolid[], dims: readonly PilotDim[], view: ViewName, w: number, h: number, opts: { scale?: number; pad?: number; order?: readonly ViewName[] } = {}): DrawnView {
  const pad = opts.pad ?? 30
  const d = VIEWS[view].d
  const all = part.flatMap(solidFaces)
  const raws = rawDims(dims, view, viewsFor(dims, opts.order ?? []))
  const b = bounds(all, raws, view)
  const k = opts.scale ?? fitScale(part, dims, view, w, h, pad, opts.order)
  const ox = (w - (b.x1 - b.x0) * k) / 2 - b.x0 * k
  const oy = (h - (b.y1 - b.y0) * k) / 2 - b.y0 * k
  const P = project(view)
  const S = (p: P2): P2 => [r1(p[0] * k + ox), r1(p[1] * k + oy)]
  const SP = (p: V3): P2 => S(P(p))
  const seen = all.filter((f) => dot(f.n, d) > 1e-6).map((f) => ({ f, z: f.pts.reduce((s, p) => s + dot(p, d), 0) / f.pts.length }))
  seen.sort((x, y) => x.z - y.z)
  const ring = (pts: readonly V3[]): string => `M${pts.map((p) => SP(p).join(' ')).join('L')}Z`
  const faces = seen.map(({ f }) => ({
    points: f.pts.map((p) => SP(p).join(',')).join(' '),
    path: ring(f.pts) + (f.holes ?? []).map(ring).join(''),
    light: Math.round(38 + 62 * Math.max(0, dot(f.n, LIGHT))),
  }))
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
    const ux = r.push[0] / pl
    const uy = r.push[1] / pl
    const m = S(r.mid)
    let badge: P2 = [m[0] + ux * (BADGE_R + 3), m[1] + uy * (BADGE_R + 3)]
    // apart from the callouts already placed, then inside the cell
    for (let tries = 0; tries < 12 && placed.some((p) => Math.hypot(p[0] - badge[0], p[1] - badge[1]) < 2 * BADGE_R + 3); tries++) badge = [badge[0] + ux * 8 + (ux === 0 && uy === 0 ? 8 : 0), badge[1] + uy * 8]
    badge = [r1(Math.min(w - BADGE_R - 2, Math.max(BADGE_R + 2, badge[0]))), r1(Math.min(h - BADGE_R - 2, Math.max(BADGE_R + 2, badge[1])))]
    placed.push(badge)
    return { key: r.key, n: r.n, guess: r.guess, lines: [...lines, ...dimLines], arrows, arc, badge }
  })
  return { faces, dims: drawn }
}

/** An arrowhead at `tip`, pointing away from `from`. */
export function arrowHead(tip: P2, from: P2, size = 6, half = 2.6): string {
  const l = Math.hypot(tip[0] - from[0], tip[1] - from[1]) || 1
  const ux = (tip[0] - from[0]) / l
  const uy = (tip[1] - from[1]) / l
  return [tip, [tip[0] - ux * size - uy * half, tip[1] - uy * size + ux * half], [tip[0] - ux * size + uy * half, tip[1] - uy * size - ux * half]].map((p) => `${r1(p[0]!)},${r1(p[1]!)}`).join(' ')
}
