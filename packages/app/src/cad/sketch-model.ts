// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch as data, with no React and no engine: chains of lines and three point arcs, and circles,
// on a plane (millimeters, plane coordinates). The drawing tools, snaps, typed values and edits are
// plain functions over it, so the panel only wires them to the view. There is no constraint solver
// and no history: what is drawn is what the engine gets, and sketch.check says what is wrong with it.
import type { SketchLoop, Vec2 } from '../geom/cad'
import { arcCenter, arcTangent, circle2, offsetFrom, polygon, rect3, rectCenter, slot, slotCenters, type SlotMode } from './sketch-shapes'

export type V2 = Vec2
export type Seg = { kind: 'line'; to: V2 } | { kind: 'arc'; to: V2; through: V2 }
/** Segments run on from `start`; a closed chain's last segment ends exactly on `start`. */
export interface Chain { kind: 'chain'; start: V2; segs: Seg[]; closed: boolean; construction?: boolean }
export interface Circle { kind: 'circle'; center: V2; diameterMm: number; construction?: boolean }
export type Entity = Chain | Circle
export type Sketch = readonly Entity[]

const EPS = 1e-6
const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]]
const len = (a: V2): number => Math.hypot(a[0], a[1])
export const dist = (a: V2, b: V2): number => Math.hypot(a[0] - b[0], a[1] - b[1])
const same = (a: V2, b: V2): boolean => dist(a, b) < EPS
const round = (v: number): number => Math.round(v * 1e6) / 1e6
const pt = (x: number, y: number): V2 => [round(x), round(y)]

/** Where segment `i` of a chain starts. */
export function segStart(c: Chain, i: number): V2 {
  return i === 0 ? c.start : c.segs[i - 1]!.to
}

/** The open end of a chain (where drawing goes on), or null for a closed chain. */
export function chainEnd(c: Chain): V2 | null {
  return c.closed ? null : (c.segs[c.segs.length - 1]?.to ?? c.start)
}

/** The engine's loops, one per entity and in the same order, so an issue's loop index is the entity's. */
export function toLoops(sketch: Sketch): SketchLoop[] {
  return sketch.map((e): SketchLoop => {
    const c = e.construction ? { construction: true as const } : {}
    if (e.kind === 'circle') return { type: 'circle', center: e.center, diameterMm: e.diameterMm, ...c }
    return { start: e.start, segments: e.segs.map((s) => (s.kind === 'line' ? { type: 'line' as const, to: s.to } : { type: 'arc' as const, to: s.to, through: s.through })), ...c }
  })
}

/** The circle through three points: center, radius, and the signed sweep from `a` through `m` to `b` (radians). */
export function arcThrough(a: V2, m: V2, b: V2): { center: V2; r: number; start: number; sweep: number } | null {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]))
  if (Math.abs(d) < 1e-9) return null
  const a2 = a[0] * a[0] + a[1] * a[1]
  const m2 = m[0] * m[0] + m[1] * m[1]
  const b2 = b[0] * b[0] + b[1] * b[1]
  const center: V2 = [(a2 * (m[1] - b[1]) + m2 * (b[1] - a[1]) + b2 * (a[1] - m[1])) / d, (a2 * (b[0] - m[0]) + m2 * (a[0] - b[0]) + b2 * (m[0] - a[0])) / d]
  const ang = (p: V2) => Math.atan2(p[1] - center[1], p[0] - center[0])
  const start = ang(a)
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const toB = norm(ang(b) - start)
  const toM = norm(ang(m) - start)
  // Counterclockwise when the middle point comes first going that way.
  const sweep = toM < toB ? toB : toB - 2 * Math.PI
  return { center, r: dist(a, center), start, sweep }
}

function arcPoints(a: V2, m: V2, b: V2): V2[] {
  const c = arcThrough(a, m, b)
  if (!c) return [a, b]
  const n = Math.max(4, Math.ceil((Math.abs(c.sweep) / (2 * Math.PI)) * 64))
  const out: V2[] = []
  for (let i = 0; i <= n; i++) {
    const t = c.start + (c.sweep * i) / n
    out.push([c.center[0] + c.r * Math.cos(t), c.center[1] + c.r * Math.sin(t)])
  }
  return out
}

function circlePoints(center: V2, r: number): V2[] {
  const out: V2[] = []
  for (let i = 0; i < 64; i++) out.push([center[0] + r * Math.cos((i / 64) * 2 * Math.PI), center[1] + r * Math.sin((i / 64) * 2 * Math.PI)])
  return out
}

/** One segment as a polyline, both ends included. */
export function segPath(c: Chain, i: number): V2[] {
  const s = c.segs[i]!
  const from = segStart(c, i)
  return s.kind === 'line' ? [from, s.to] : arcPoints(from, s.through, s.to)
}

/** An entity as polylines to draw: one per segment for a chain, one closed ring for a circle. */
export function entityPaths(e: Entity): { points: V2[]; closed?: boolean; seg: number }[] {
  if (e.kind === 'circle') return [{ points: circlePoints(e.center, e.diameterMm / 2), closed: true, seg: 0 }]
  return e.segs.map((_, i) => ({ points: segPath(e, i), seg: i }))
}

export type HandleRef = { e: number; at: 'start' } | { e: number; at: 'to' | 'through'; seg: number } | { e: number; at: 'center' | 'rim' }

/** Every point a drag can move: chain ends and corners, arc middles, circle centers and a rim point. */
export function handles(sketch: Sketch): { refs: HandleRef[]; points: V2[] } {
  const refs: HandleRef[] = []
  const points: V2[] = []
  sketch.forEach((e, i) => {
    if (e.kind === 'circle') {
      refs.push({ e: i, at: 'center' }, { e: i, at: 'rim' })
      points.push(e.center, [e.center[0] + e.diameterMm / 2, e.center[1]])
      return
    }
    refs.push({ e: i, at: 'start' })
    points.push(e.start)
    e.segs.forEach((s, k) => {
      if (s.kind === 'arc') {
        refs.push({ e: i, at: 'through', seg: k })
        points.push(s.through)
      }
      // A closed chain's last corner is its start.
      if (!(e.closed && k === e.segs.length - 1)) {
        refs.push({ e: i, at: 'to', seg: k })
        points.push(s.to)
      }
    })
  })
  return { refs, points }
}

/** The sketch with one handle moved to `p`. */
export function moveHandle(sketch: Sketch, ref: HandleRef, p: V2): Entity[] {
  return sketch.map((e, i): Entity => {
    if (i !== ref.e) return e
    if (e.kind === 'circle') return ref.at === 'center' ? { ...e, center: p } : ref.at === 'rim' ? { ...e, diameterMm: Math.max(0.01, round(2 * dist(e.center, p))) } : e
    if (ref.at === 'start') {
      const segs = e.closed && e.segs.length ? e.segs.map((s, k) => (k === e.segs.length - 1 ? { ...s, to: p } : s)) : e.segs
      return { ...e, start: p, segs }
    }
    if (ref.at === 'to' || ref.at === 'through') {
      const k = ref.seg
      return { ...e, segs: e.segs.map((s, j) => (j !== k ? s : ref.at === 'to' ? { ...s, to: p } : s.kind === 'arc' ? { ...s, through: p } : s)) }
    }
    return e
  })
}

/** The sketch without one segment. A closed chain opens there; an open chain splits in two. A circle goes whole. */
export function deleteSegment(sketch: Sketch, e: number, seg: number): Entity[] {
  const out: Entity[] = []
  sketch.forEach((x, i) => {
    if (i !== e) return void out.push(x)
    if (x.kind === 'circle') return
    const c = x.construction ? { construction: true } : {}
    if (x.closed) {
      if (x.segs.length <= 1) return
      // Starts where the removed segment ended and runs round to where it began.
      const segs = [...x.segs.slice(seg + 1), ...x.segs.slice(0, seg)]
      out.push({ kind: 'chain', start: x.segs[seg]!.to, segs, closed: false, ...c })
      return
    }
    const before = x.segs.slice(0, seg)
    const after = x.segs.slice(seg + 1)
    if (before.length) out.push({ kind: 'chain', start: x.start, segs: before, closed: false, ...c })
    if (after.length) out.push({ kind: 'chain', start: x.segs[seg]!.to, segs: after, closed: false, ...c })
  })
  return out
}

/** The same chain drawn the other way round, so it can be extended from what was its start. */
export function reverseChain(c: Chain): Chain {
  const ends = [c.start, ...c.segs.map((s) => s.to)]
  const segs: Seg[] = []
  for (let k = c.segs.length - 1; k >= 0; k--) {
    const s = c.segs[k]!
    const to = ends[k]!
    segs.push(s.kind === 'line' ? { kind: 'line', to } : { kind: 'arc', to, through: s.through })
  }
  return { ...c, start: ends[ends.length - 1]!, segs }
}

function nearestOnSegment(p: V2, a: V2, b: V2): { at: V2; d: number } {
  const ab = sub(b, a)
  const l2 = ab[0] * ab[0] + ab[1] * ab[1]
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2))
  const at: V2 = [a[0] + ab[0] * t, a[1] + ab[1] * t]
  return { at, d: dist(p, at) }
}

/** The segment (or circle) within `tolMm` of a point, nearest first. */
export function hitTest(sketch: Sketch, p: V2, tolMm: number): { e: number; seg: number } | null {
  let best: { e: number; seg: number } | null = null
  let bestD = tolMm
  sketch.forEach((e, i) => {
    for (const path of entityPaths(e)) {
      const pts = path.closed ? [...path.points, path.points[0]!] : path.points
      for (let k = 0; k + 1 < pts.length; k++) {
        const d = nearestOnSegment(p, pts[k]!, pts[k + 1]!).d
        if (d <= bestD) {
          bestD = d
          best = { e: i, seg: path.seg }
        }
      }
    }
  })
  return best
}

// Snaps

export type SnapKind = 'vertex' | 'midpoint' | 'center' | 'horizontal' | 'vertical' | 'edge' | 'grid'

export const SNAP_NAMES: Record<SnapKind, string> = { vertex: 'End point', midpoint: 'Midpoint', center: 'Center', horizontal: 'Horizontal', vertical: 'Vertical', edge: 'On an edge', grid: 'Grid' }

export interface SnapTargets {
  points: readonly { at: V2; kind: 'vertex' | 'midpoint' | 'center' }[]
  edges: readonly { a: V2; b: V2 }[]
}

/** The sketch's own snap targets: ends and corners, line midpoints, circle and arc centers, and its lines. */
export function sketchTargets(sketch: Sketch, skip?: HandleRef): SnapTargets {
  const points: { at: V2; kind: 'vertex' | 'midpoint' | 'center' }[] = []
  const edges: { a: V2; b: V2 }[] = []
  sketch.forEach((e, i) => {
    if (e.kind === 'circle') {
      if (!(skip?.e === i && skip.at === 'center')) points.push({ at: e.center, kind: 'center' })
      return
    }
    // A point being dragged does not snap to itself.
    if (!(skip?.e === i && skip.at === 'start')) points.push({ at: e.start, kind: 'vertex' })
    e.segs.forEach((s, k) => {
      const from = segStart(e, k)
      const moving = skip?.e === i && 'seg' in skip && (skip.seg === k || skip.seg === k - 1)
      if (!(skip?.e === i && skip.at === 'to' && 'seg' in skip && skip.seg === k)) points.push({ at: s.to, kind: 'vertex' })
      if (moving) return
      if (s.kind === 'line') {
        points.push({ at: [(from[0] + s.to[0]) / 2, (from[1] + s.to[1]) / 2], kind: 'midpoint' })
        edges.push({ a: from, b: s.to })
      } else {
        const c = arcThrough(from, s.through, s.to)
        if (c) points.push({ at: c.center, kind: 'center' })
      }
    })
  })
  return { points, edges }
}

export interface SnapOptions {
  /** The point the line being drawn starts from, for horizontal and vertical. */
  anchor?: V2 | null
  /** 0 turns the grid off. */
  gridMm: number
  /** How close counts, in mm on the plane (a few pixels' worth). */
  tolMm: number
}

/** Where a cursor point lands: points first, then horizontal or vertical from the anchor, then edges, then the grid. */
export function snap(p: V2, targets: readonly SnapTargets[], o: SnapOptions): { at: V2; kind: SnapKind | null; guide?: [V2, V2] } {
  let best: { at: V2; kind: SnapKind } | null = null
  let bestD = o.tolMm
  for (const t of targets) for (const q of t.points) {
    const d = dist(p, q.at)
    // A vertex beats a midpoint or center that sits as close.
    if (d < bestD || (d === bestD && q.kind === 'vertex')) {
      bestD = d
      best = { at: q.at, kind: q.kind }
    }
  }
  if (best) return { at: [...best.at] as V2, kind: best.kind }
  const g = (v: number) => (o.gridMm > 0 ? round(Math.round(v / o.gridMm) * o.gridMm) : v)
  const a = o.anchor
  if (a) {
    const dy = Math.abs(p[1] - a[1])
    const dx = Math.abs(p[0] - a[0])
    if (dy <= o.tolMm && dy <= dx) {
      const at = pt(g(p[0]), a[1])
      return { at, kind: 'horizontal', guide: [a, at] }
    }
    if (dx <= o.tolMm) {
      const at = pt(a[0], g(p[1]))
      return { at, kind: 'vertical', guide: [a, at] }
    }
  }
  let edge: V2 | null = null
  let edgeD = o.tolMm
  for (const t of targets) for (const e of t.edges) {
    const n = nearestOnSegment(p, e.a, e.b)
    if (n.d <= edgeD) {
      edgeD = n.d
      edge = n.at
    }
  }
  if (edge) return { at: pt(edge[0], edge[1]), kind: 'edge' }
  if (o.gridMm > 0) return { at: pt(g(p[0]), g(p[1])), kind: 'grid' }
  return { at: p, kind: null }
}

// Drawing tools

export type DrawTool =
  | 'select'
  | 'line'
  | 'rect'
  | 'rect3'
  | 'rectCenter'
  | 'circle'
  | 'circle2'
  | 'arc'
  | 'arcCenter'
  | 'arcTangent'
  | 'polygon'
  | 'polygonOut'
  | 'polygonEdge'
  | 'slot'
  | 'slotOverall'
  | 'slotCenter'
  | 'dimension'

/** Options a tool reads as it draws. */
export interface DrawOptions {
  /** a polygon's side count */
  sides?: number
}

const SLOT: Partial<Record<DrawTool, SlotMode>> = { slot: 'centers', slotOverall: 'overall', slotCenter: 'center' }

/** The direction a chain leaves its open end, for a tangent arc from it. */
export function tangentAtEnd(c: Chain): V2 | null {
  const i = c.segs.length - 1
  const s = c.segs[i]
  if (!s || c.closed) return null
  const from = segStart(c, i)
  if (s.kind === 'line') return len(sub(s.to, from)) < EPS ? null : [(s.to[0] - from[0]) / dist(s.to, from), (s.to[1] - from[1]) / dist(s.to, from)]
  const a = arcThrough(from, s.through, s.to)
  if (!a) return null
  const r: V2 = [(s.to[0] - a.center[0]) / a.r, (s.to[1] - a.center[1]) / a.r]
  return a.sweep > 0 ? [-r[1], r[0]] : [r[1], -r[0]]
}

/** The shape the tool makes from the draft's points and the cursor, for the click that ends it and the preview. */
function shapeOf(draft: Draft, p: V2, o: DrawOptions): Entity | null {
  const [a, b] = draft.points
  if (!a) return null
  const sides = o.sides ?? 6
  switch (draft.tool) {
    case 'rect3':
      return b ? rect3(a, b, p) : null
    case 'rectCenter':
      return rectCenter(a, p)
    case 'circle2': {
      const c = circle2(a, p)
      return c ? { kind: 'circle', ...c } : null
    }
    case 'polygon':
    case 'polygonOut':
      return polygon(draft.tool === 'polygon' ? 'inscribed' : 'circumscribed', a, p, sides)
    case 'polygonEdge':
      return b ? polygon('edge', a, b, sides, p) : null
    case 'slot':
    case 'slotOverall':
    case 'slotCenter': {
      if (!b) return null
      const w = 2 * Math.abs(offsetFrom(a, b, p))
      const c = slotCenters(SLOT[draft.tool]!, a, b, w)
      return c ? slot(c[0], c[1], w) : null
    }
    default:
      return null
  }
}

/** How many clicks a closed shape tool takes; the last one makes the shape. */
const CLICKS: Partial<Record<DrawTool, number>> = { rect3: 3, rectCenter: 2, circle2: 2, polygon: 2, polygonOut: 2, polygonEdge: 3, slot: 3, slotOverall: 3, slotCenter: 3 }

/** A shape being drawn: the points clicked so far, and the chain a line or arc adds to. */
export interface Draft {
  tool: DrawTool
  points: V2[]
  chain?: number
}

export const emptyDraft = (tool: DrawTool): Draft => ({ tool, points: [] })

/** A chain whose open end (or start) sits on `p`, made to end there. Returns the sketch and the chain's index. */
function chainAt(sketch: Sketch, p: V2): { sketch: Entity[]; e: number } | null {
  const i = sketch.findIndex((e) => e.kind === 'chain' && !e.closed && (same(chainEnd(e) ?? [NaN, NaN], p) || same(e.start, p)))
  if (i < 0) return null
  const c = sketch[i] as Chain
  if (same(chainEnd(c)!, p)) return { sketch: [...sketch], e: i }
  return { sketch: sketch.map((x, k) => (k === i ? reverseChain(c) : x)), e: i }
}

/** Adds a segment to the draft's chain (or a new one from `from`), closing it when it ends on its start. */
function addSeg(sketch: Entity[], draft: Draft, from: V2, seg: Seg): { sketch: Entity[]; chain: number; closed: boolean } {
  if (draft.chain === undefined) {
    const c: Chain = { kind: 'chain', start: from, segs: [seg], closed: false }
    return { sketch: [...sketch, c], chain: sketch.length, closed: false }
  }
  const c = sketch[draft.chain] as Chain
  const closed = same(seg.to, c.start)
  const next: Chain = { ...c, segs: [...c.segs, closed ? { ...seg, to: c.start } : seg], closed }
  return { sketch: sketch.map((x, k) => (k === draft.chain ? next : x)), chain: draft.chain, closed }
}

/** A click with a drawing tool (`p` already snapped). Returns the new sketch and draft. */
export function click(sketch: Sketch, draft: Draft, p: V2, o: DrawOptions = {}): { sketch: Entity[]; draft: Draft } {
  const s = [...sketch]
  const pts = draft.points
  const clicks = CLICKS[draft.tool]
  if (clicks) {
    if (pts.some((q) => same(q, p))) return { sketch: s, draft }
    if (pts.length < clicks - 1) return { sketch: s, draft: { tool: draft.tool, points: [...pts, p] } }
    const shape = shapeOf(draft, p, o)
    return shape ? { sketch: [...s, shape], draft: emptyDraft(draft.tool) } : { sketch: s, draft }
  }
  switch (draft.tool) {
    case 'arcCenter': {
      if (pts.length === 0) return { sketch: s, draft: { tool: draft.tool, points: [p] } }
      if (pts.length === 1) {
        if (same(p, pts[0]!)) return { sketch: s, draft }
        // starting on an open end goes on with that chain
        const on = chainAt(s, p)
        return { sketch: on ? on.sketch : s, draft: { tool: draft.tool, points: [pts[0]!, p], ...(on ? { chain: on.e } : {}) } }
      }
      const arc = arcCenter(pts[0]!, pts[1]!, p)
      if (!arc) return { sketch: s, draft }
      const r = addSeg(s, draft, pts[1]!, { kind: 'arc', to: arc.to, through: arc.through })
      return { sketch: r.sketch, draft: emptyDraft(draft.tool) }
    }
    case 'arcTangent': {
      if (pts.length === 0) {
        // only from the open end of a line or arc
        const on = chainAt(s, p)
        return on && tangentAtEnd(on.sketch[on.e] as Chain) ? { sketch: on.sketch, draft: { tool: draft.tool, points: [p], chain: on.e } } : { sketch: s, draft }
      }
      const t = draft.chain !== undefined ? tangentAtEnd(s[draft.chain] as Chain) : null
      const arc = t ? arcTangent(pts[0]!, t, p) : null
      if (!arc) return { sketch: s, draft }
      const r = addSeg(s, draft, pts[0]!, { kind: 'arc', to: arc.to, through: arc.through })
      // tangent arcs go on from the new end until the chain closes
      return { sketch: r.sketch, draft: r.closed ? emptyDraft(draft.tool) : { tool: draft.tool, points: [arc.to], chain: r.chain } }
    }
    case 'select':
      return { sketch: s, draft }
    case 'line':
    case 'arc': {
      if (pts.length === 0) {
        // Starting on an open end goes on with that chain.
        const on = chainAt(s, p)
        return on ? { sketch: on.sketch, draft: { tool: draft.tool, points: [p], chain: on.e } } : { sketch: s, draft: { tool: draft.tool, points: [p] } }
      }
      const from = pts[0]!
      if (draft.tool === 'line') {
        if (same(p, from)) return { sketch: s, draft }
        const r = addSeg(s, draft, from, { kind: 'line', to: p })
        return { sketch: r.sketch, draft: r.closed ? emptyDraft('line') : { tool: 'line', points: [p], chain: r.chain } }
      }
      if (pts.length === 1) return same(p, from) ? { sketch: s, draft } : { sketch: s, draft: { ...draft, points: [from, p] } }
      const end = pts[1]!
      if (!arcThrough(from, p, end)) return { sketch: s, draft }
      const r = addSeg(s, draft, from, { kind: 'arc', to: end, through: p })
      return { sketch: r.sketch, draft: emptyDraft('arc') }
    }
    case 'rect': {
      if (pts.length === 0) return { sketch: s, draft: { tool: 'rect', points: [p] } }
      const a = pts[0]!
      if (Math.abs(p[0] - a[0]) < EPS || Math.abs(p[1] - a[1]) < EPS) return { sketch: s, draft }
      return { sketch: [...s, rectangle(a, p)], draft: emptyDraft('rect') }
    }
    case 'circle': {
      if (pts.length === 0) return { sketch: s, draft: { tool: 'circle', points: [p] } }
      const d = 2 * dist(pts[0]!, p)
      if (d < EPS) return { sketch: s, draft }
      return { sketch: [...s, { kind: 'circle', center: pts[0]!, diameterMm: round(d) }], draft: emptyDraft('circle') }
    }
    default:
      return { sketch: s, draft }
  }
}

/** A closed rectangle from one corner to the opposite one, counterclockwise. */
export function rectangle(a: V2, b: V2): Chain {
  const x0 = Math.min(a[0], b[0])
  const x1 = Math.max(a[0], b[0])
  const y0 = Math.min(a[1], b[1])
  const y1 = Math.max(a[1], b[1])
  const start: V2 = [x0, y0]
  return { kind: 'chain', start, segs: [{ kind: 'line', to: [x1, y0] }, { kind: 'line', to: [x1, y1] }, { kind: 'line', to: [x0, y1] }, { kind: 'line', to: start }], closed: true }
}

/** What the tool would draw with the cursor at `p`: the rubber band. */
export function preview(draft: Draft, p: V2, o: DrawOptions = {}, sketch: Sketch = []): V2[] {
  const pts = draft.points
  const a = pts[0]
  if (!a) return []
  const clicks = CLICKS[draft.tool]
  if (clicks) {
    const shape = pts.length === clicks - 1 ? shapeOf(draft, p, o) : null
    if (shape) return entityPaths(shape).flatMap((q, i) => (i ? q.points.slice(1) : q.points))
    return draft.tool === 'circle2' || draft.tool === 'rectCenter' || draft.tool === 'polygon' || draft.tool === 'polygonOut' ? [a, p] : [...pts, p]
  }
  switch (draft.tool) {
    case 'arcCenter': {
      if (pts.length === 1) return [a, p]
      const arc = arcCenter(a, pts[1]!, p)
      return arc ? arcPoints(pts[1]!, arc.through, arc.to) : [a, pts[1]!]
    }
    case 'arcTangent': {
      const c = draft.chain !== undefined ? sketch[draft.chain] : undefined
      const t = c?.kind === 'chain' ? tangentAtEnd(c) : null
      const arc = t ? arcTangent(a, t, p) : null
      return arc ? arcPoints(a, arc.through, arc.to) : [a, p]
    }
    case 'line':
      return [a, p]
    case 'rect':
      return [a, [p[0], a[1]], p, [a[0], p[1]], a]
    case 'circle': {
      const ring = circlePoints(a, dist(a, p))
      return [...ring, ring[0]!]
    }
    case 'arc':
      return pts.length === 1 ? [a, p] : arcPoints(a, p, pts[1]!)
    default:
      return []
  }
}

export interface TypedField {
  label: string
  unit: 'mm' | '°'
}

/** The values the field at the cursor takes for the tool's next step. */
export function fieldsFor(draft: Draft): TypedField[] {
  const n = draft.points.length
  if (draft.tool === 'select') return []
  if (n === 0) return draft.tool === 'arcTangent' ? [] : [{ label: 'X', unit: 'mm' }, { label: 'Y', unit: 'mm' }]
  switch (draft.tool) {
    case 'rectCenter':
      return [{ label: 'Width', unit: 'mm' }, { label: 'Height', unit: 'mm' }]
    case 'circle2':
      return [{ label: 'Diameter', unit: 'mm' }]
    case 'polygon':
      return [{ label: 'Radius', unit: 'mm' }]
    case 'polygonOut':
      return [{ label: 'To an edge', unit: 'mm' }]
    case 'arcCenter':
      return n === 1 ? [{ label: 'Radius', unit: 'mm' }, { label: 'Angle', unit: '°' }] : [{ label: 'Sweep', unit: '°' }]
    case 'arcTangent':
      return []
    case 'rect3':
    case 'slot':
    case 'slotOverall':
    case 'slotCenter':
      if (n === 2) return [{ label: 'Width', unit: 'mm' }]
      break
    case 'polygonEdge':
      if (n === 2) return []
      break
  }
  if (draft.tool === 'rect') return [{ label: 'Width', unit: 'mm' }, { label: 'Height', unit: 'mm' }]
  if (draft.tool === 'circle') return [{ label: 'Diameter', unit: 'mm' }]
  if (draft.tool === 'arc' && n === 2) return [{ label: 'Radius', unit: 'mm' }]
  return [{ label: 'Length', unit: 'mm' }, { label: 'Angle', unit: '°' }]
}

const DEG = Math.PI / 180

/**
 * The point that typed values stand for, with the cursor `p` filling in what was left empty (the
 * direction of a line, the side of a rectangle or an arc). A sentence when the values cannot work.
 */
export function typedPoint(draft: Draft, values: readonly (number | null)[], p: V2): V2 | string {
  const n = draft.points.length
  const [v0, v1] = values
  const a = draft.points[0]
  if (n === 0 || !a) {
    if (v0 === null || v0 === undefined) return 'Type a position.'
    return pt(v0, v1 ?? p[1])
  }
  const b = draft.points[1]
  const toward = (len: number): V2 => {
    const dir = dist(p, a) > EPS ? sub(p, a) : ([1, 0] as V2)
    const k = len / Math.hypot(dir[0], dir[1])
    return pt(a[0] + dir[0] * k, a[1] + dir[1] * k)
  }
  switch (draft.tool) {
    case 'rectCenter': {
      const w = v0 ?? 2 * Math.abs(p[0] - a[0])
      const h = v1 ?? 2 * Math.abs(p[1] - a[1])
      if (!(w > 0) || !(h > 0)) return 'Width and height must be more than 0 mm.'
      return pt(a[0] + (p[0] < a[0] ? -w : w) / 2, a[1] + (p[1] < a[1] ? -h : h) / 2)
    }
    case 'circle2':
      if (v0 === null || v0 === undefined || !(v0 > 0)) return 'The diameter must be more than 0 mm.'
      return toward(v0)
    case 'polygon':
    case 'polygonOut':
      if (v0 === null || v0 === undefined || !(v0 > 0)) return 'The size must be more than 0 mm.'
      return toward(v0)
    case 'arcCenter':
      if (n === 2 && b) {
        if (v0 === null || v0 === undefined || !v0) return 'Type a sweep in degrees.'
        const r = dist(a, b)
        const t = Math.atan2(b[1] - a[1], b[0] - a[0]) + v0 * DEG
        return pt(a[0] + r * Math.cos(t), a[1] + r * Math.sin(t))
      }
      break
    case 'rect3':
    case 'slot':
    case 'slotOverall':
    case 'slotCenter':
      if (n === 2 && b) {
        if (v0 === null || v0 === undefined || !(v0 > 0)) return 'The width must be more than 0 mm.'
        // the width goes out on the cursor's side; a slot's is around its center line
        const d = dist(a, b)
        const side = offsetFrom(a, b, p) < 0 ? -1 : 1
        const w = draft.tool === 'rect3' ? v0 : v0 / 2
        const nx = (-(b[1] - a[1]) / d) * side * w
        const ny = ((b[0] - a[0]) / d) * side * w
        return pt(b[0] + nx, b[1] + ny)
      }
      break
  }
  if (draft.tool === 'rect') {
    const w = v0 ?? Math.abs(p[0] - a[0])
    const h = v1 ?? Math.abs(p[1] - a[1])
    if (!(w > 0) || !(h > 0)) return 'Width and height must be more than 0 mm.'
    return pt(a[0] + (p[0] < a[0] ? -w : w), a[1] + (p[1] < a[1] ? -h : h))
  }
  if (draft.tool === 'circle') {
    if (v0 === null || v0 === undefined || !(v0 > 0)) return 'The diameter must be more than 0 mm.'
    const dir = len(sub(p, a)) > EPS ? sub(p, a) : ([1, 0] as V2)
    const k = v0 / 2 / len(dir)
    return pt(a[0] + dir[0] * k, a[1] + dir[1] * k)
  }
  if (draft.tool === 'arc' && n === 2) {
    const b = draft.points[1]!
    if (v0 === null || v0 === undefined) return 'Type a radius.'
    return arcMiddle(a, b, v0, p)
  }
  // A line, or an arc's chord: length and angle, the angle from the cursor when left empty.
  const length = v0 ?? dist(a, p)
  if (!(length > 0)) return 'The length must be more than 0 mm.'
  const angle = v1 !== null && v1 !== undefined ? v1 * DEG : Math.atan2(p[1] - a[1], p[0] - a[0])
  return pt(a[0] + length * Math.cos(angle), a[1] + length * Math.sin(angle))
}

/** The middle point of the shorter arc of radius `r` from `a` to `b`, bulging to the cursor's side. */
export function arcMiddle(a: V2, b: V2, r: number, p: V2): V2 | string {
  const h = dist(a, b) / 2
  if (!(r >= h - 1e-9)) return `The radius must be at least ${round(h)} mm, half the distance between the ends.`
  const m: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const ab = sub(b, a)
  let nrm: V2 = [-ab[1] / (2 * h), ab[0] / (2 * h)]
  if ((p[0] - m[0]) * nrm[0] + (p[1] - m[1]) * nrm[1] < 0) nrm = [-nrm[0], -nrm[1]]
  const s = r - Math.sqrt(Math.max(0, r * r - h * h))
  return pt(m[0] + nrm[0] * s, m[1] + nrm[1] * s)
}

/** The live readout for the cursor: the length and angle of a line, a rectangle's size, a diameter. `f` shows a length
 * in the display unit `u`. */
export function readout(draft: Draft, p: V2, f: (mm: number) => string = (v) => v.toFixed(2), u = 'mm'): string {
  const a = draft.points[0]
  if (!a) return `X ${f(p[0])} ${u}, Y ${f(p[1])} ${u}`
  const b = draft.points[1]
  const lineText = (): string => `Length ${f(dist(a, p))} ${u}, angle ${((Math.atan2(p[1] - a[1], p[0] - a[0]) / DEG + 360) % 360).toFixed(1)}°`
  switch (draft.tool) {
    case 'rect':
      return `${f(Math.abs(p[0] - a[0]))} by ${f(Math.abs(p[1] - a[1]))} ${u}`
    case 'rectCenter':
      return `${f(2 * Math.abs(p[0] - a[0]))} by ${f(2 * Math.abs(p[1] - a[1]))} ${u}`
    case 'circle2':
      return `Diameter ${f(dist(a, p))} ${u}`
    case 'polygon':
    case 'polygonOut':
      return `${draft.tool === 'polygon' ? 'Radius' : 'To an edge'} ${f(dist(a, p))} ${u}`
    case 'arcTangent':
      return `Chord ${f(dist(a, p))} ${u}`
    case 'arcCenter':
      if (b) {
        const arc = arcCenter(a, b, p)
        const sweep = arc ? arcThrough(b, arc.through, arc.to) : null
        return `Radius ${f(dist(a, b))} ${u}${sweep ? `, sweep ${Math.abs(sweep.sweep / DEG).toFixed(1)}°` : ''}`
      }
      return `Radius ${f(dist(a, p))} ${u}`
    case 'rect3':
    case 'slot':
    case 'slotOverall':
    case 'slotCenter':
      return b ? `Width ${f((draft.tool === 'rect3' ? 1 : 2) * Math.abs(offsetFrom(a, b, p)))} ${u}` : lineText()
    case 'polygonEdge':
      return b ? `Edge ${f(dist(a, b))} ${u}` : lineText()
    case 'circle':
      return `Diameter ${f(2 * dist(a, p))} ${u}`
    case 'arc':
      if (draft.points.length === 2) {
        const c = arcThrough(a, p, draft.points[1]!)
        return c ? `Radius ${f(c.r)} ${u}` : 'Straight'
      }
    // falls through: the chord reads like a line
    default: {
      const ang = (Math.atan2(p[1] - a[1], p[0] - a[0]) / DEG + 360) % 360
      return `Length ${f(dist(a, p))} ${u}, angle ${ang.toFixed(1)}°`
    }
  }
}

/** A closed ring of points (an offset outline) as a chain of lines. Null for fewer than three points. */
export function polylineToChain(points: readonly V2[]): Chain | null {
  if (points.length < 3) return null
  const ring = same(points[0]!, points[points.length - 1]!) ? points.slice(0, -1) : points
  return { kind: 'chain', start: pt(ring[0]![0], ring[0]![1]), segs: [...ring.slice(1).map((q): Seg => ({ kind: 'line', to: pt(q[0], q[1]) })), { kind: 'line', to: pt(ring[0]![0], ring[0]![1]) }], closed: true }
}

/** Revolve axis from a line segment: a point on it and its direction. Null for an arc or a circle. */
export function axisOf(sketch: Sketch, sel: { e: number; seg: number } | null): { point: V2; direction: V2 } | null {
  const e = sel ? sketch[sel.e] : undefined
  if (!sel || !e || e.kind !== 'chain') return null
  const s = e.segs[sel.seg]
  if (!s || s.kind !== 'line') return null
  const from = segStart(e, sel.seg)
  return { point: from, direction: sub(s.to, from) }
}

/** The middle of what is drawn, and how far it reaches, for framing the camera. */
export function extent(sketch: Sketch): { center: V2; radius: number } | null {
  const pts = sketch.flatMap((e) => entityPaths(e).flatMap((p) => p.points))
  if (!pts.length) return null
  const xs = pts.map((q) => q[0])
  const ys = pts.map((q) => q[1])
  const c: V2 = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
  return { center: c, radius: Math.max(...pts.map((q) => dist(q, c))) }
}

/**
 * Engine loops back into drawn entities, for reopening a saved sketch: lines, three point arcs, arcs
 * by center and sweep (what corner rounding returns), circles and point rings. Null when a loop uses
 * a form the editor does not draw (lengths and angles), so the caller can say so.
 */
export function fromLoops(loops: readonly SketchLoop[]): Entity[] | null {
  const out: Entity[] = []
  for (const l of loops) {
    const k = l.construction ? { construction: true } : {}
    if ('type' in l && l.type === 'circle') {
      out.push({ kind: 'circle', center: pt(l.center[0], l.center[1]), diameterMm: l.diameterMm, ...k })
      continue
    }
    if ('points' in l) {
      const c = polylineToChain(l.points)
      if (!c) return null
      out.push({ ...c, ...k })
      continue
    }
    if (!('start' in l)) return null
    const segs: Seg[] = []
    let at: V2 = l.start
    for (const g of l.segments) {
      if (g.type === 'line' && 'to' in g && g.to) segs.push({ kind: 'line', to: pt(g.to[0], g.to[1]) })
      else if (g.type === 'arc' && 'through' in g && g.through && 'to' in g && g.to) segs.push({ kind: 'arc', to: pt(g.to[0], g.to[1]), through: pt(g.through[0], g.through[1]) })
      else if (g.type === 'arc' && 'center' in g && g.center && 'sweepDeg' in g && typeof g.sweepDeg === 'number') {
        const c = g.center
        const turn = (deg: number): V2 => {
          const a = (deg * Math.PI) / 180
          const dx = at[0] - c[0]
          const dy = at[1] - c[1]
          return pt(c[0] + dx * Math.cos(a) - dy * Math.sin(a), c[1] + dx * Math.sin(a) + dy * Math.cos(a))
        }
        segs.push({ kind: 'arc', through: turn(g.sweepDeg / 2), to: turn(g.sweepDeg) })
      } else return null
      at = segs[segs.length - 1]!.to
    }
    const closed = segs.length > 0 && dist(at, l.start) < 1e-3
    if (closed) segs[segs.length - 1] = { ...segs[segs.length - 1]!, to: pt(l.start[0], l.start[1]) }
    out.push({ kind: 'chain', start: pt(l.start[0], l.start[1]), segs, closed, ...k })
  }
  return out
}

/** The line of the sketch that lies on a revolve axis, for picking it again when the sketch reopens. */
export function axisSegment(sketch: Sketch, axis: { point: V2; direction: V2 }): { e: number; seg: number } | null {
  const d = axis.direction
  const l = Math.hypot(d[0], d[1])
  if (l === 0) return null
  const off = (q: V2) => Math.abs((q[0] - axis.point[0]) * d[1] - (q[1] - axis.point[1]) * d[0]) / l
  for (let e = 0; e < sketch.length; e++) {
    const c = sketch[e]!
    if (c.kind !== 'chain') continue
    for (let i = 0; i < c.segs.length; i++) {
      const g = c.segs[i]!
      if (g.kind === 'line' && off(segStart(c, i)) < 1e-4 && off(g.to) < 1e-4) return { e, seg: i }
    }
  }
  return null
}

/**
 * Corners of a chain that can be rounded or beveled: vertices between two straight segments (vertex
 * i is where segment i starts). With `seg`, only that segment's two ends.
 */
export function straightCorners(c: Chain, seg?: number): number[] {
  const n = c.segs.length
  const isLine = (i: number) => c.segs[i]?.kind === 'line'
  const ok = (v: number) => {
    if (v === 0) return c.closed && isLine(n - 1) && isLine(0)
    return v < n && isLine(v - 1) && isLine(v)
  }
  const want = seg === undefined ? [...Array(n).keys()] : [seg, c.closed && seg === n - 1 ? 0 : seg + 1]
  return [...new Set(want)].filter(ok)
}

/** Closed loops of the sketch as rings, for the profile shading. */
export function profileRings(sketch: Sketch): V2[][] {
  return sketch.flatMap((e) => {
    if (e.construction) return []
    if (e.kind === 'circle') return [entityPaths(e)[0]!.points]
    const pts = entityPaths(e).flatMap((p, i) => (i ? p.points.slice(1) : p.points))
    const a = pts[0]
    const b = pts[pts.length - 1]
    return a && b && pts.length > 3 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-3 ? [pts.slice(0, -1)] : []
  })
}

/** What the picked curve is, for Select's readout: a line's length, an arc's radius, a circle's diameter, in the display unit as readout() has it. Empty with nothing picked. */
export function pickedText(sketch: Sketch, picked: { e: number; seg: number } | null, f: (mm: number) => string = (v) => v.toFixed(2), u = 'mm'): string {
  const e = picked ? sketch[picked.e] : undefined
  if (!e || !picked) return ''
  if (e.kind === 'circle') return `Circle, diameter ${f(e.diameterMm)} ${u}`
  const s = e.segs[picked.seg]
  if (!s) return ''
  const from = segStart(e, picked.seg)
  if (s.kind === 'line') return `Line, ${f(dist(from, s.to))} ${u}`
  const a = arcThrough(from, s.through, s.to)
  return a ? `Arc, radius ${f(a.r)} ${u}` : 'Arc'
}

/** The sketch with entity `e` turned into construction geometry, or back into a curve that makes profiles. */
export function toggleConstruction(sketch: Sketch, e: number): Entity[] {
  return sketch.map((x, i) => {
    if (i !== e) return x
    if (x.construction) {
      const { construction: _c, ...rest } = x
      return rest
    }
    return { ...x, construction: true }
  })
}

/** Where the line being drawn can drag a tangent arc from: its open end, once it has a segment to be tangent to. */
export function lineArcFrom(sketch: Sketch, draft: Draft): V2 | null {
  if (draft.tool !== 'line' || draft.chain === undefined || !draft.points[0]) return null
  const c = sketch[draft.chain]
  return c?.kind === 'chain' && tangentAtEnd(c) ? draft.points[0] : null
}

/** A drag off the line's open end draws a tangent arc to `p`, as in Fusion; the line goes on from the arc's end. */
export function dragArc(sketch: Sketch, draft: Draft, p: V2): { sketch: Entity[]; draft: Draft } {
  const r = click(sketch, { ...draft, tool: 'arcTangent' }, p)
  return { sketch: r.sketch, draft: r.draft.points.length ? { ...r.draft, tool: 'line' } : emptyDraft('line') }
}

/** The tangent arc a drag off the line's open end would draw to `p`. */
export const dragArcPreview = (sketch: Sketch, draft: Draft, p: V2): V2[] => preview({ ...draft, tool: 'arcTangent' }, p, {}, sketch)
