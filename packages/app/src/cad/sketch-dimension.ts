// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The dimension tool (D), as in Fusion: pick one or two items and the tool says what they measure. A line gives its
// length, a circle its diameter, an arc its radius, two points their distance (across, or level or upright when the
// label goes off to that side), two lines their angle or, when parallel, their gap, and a point and a line the
// distance between them. Each comes with its value as the sketch has it now, for the field.
import { solveSketch } from '../geom/cad'
import { fromSolver, toSolver, type SketchConstraint, type SketchCurveRef, type SketchPointRef, type Solved } from './sketch-constraints'
import { arcThrough, dist, segStart, type Entity, type Sketch, type V2 } from './sketch-model'

/** A constraint with a value: what the dimension tool makes. */
export type DimConstraint = Extract<SketchConstraint, { value: number }>

/** A pick: a point of the sketch, or a line, arc or circle. */
export type DimPick = { point: SketchPointRef } | { curve: SketchCurveRef }

const EPS = 1e-6
const DEG = 180 / Math.PI

/** Where a point is, arc centers too. */
export function pointAt(sketch: Sketch, r: SketchPointRef): V2 | null {
  if (r.e === -1) return [0, 0]
  const e = sketch[r.e]
  if (!e) return null
  if (e.kind === 'circle') return r.at === 'center' ? e.center : null
  if (r.at === 'start') return e.start
  if (r.at === 'to') return e.segs[r.seg]?.to ?? null
  if (r.at === 'arcCenter') {
    const s = e.segs[r.seg]
    return s?.kind === 'arc' ? (arcThrough(segStart(e, r.seg), s.through, s.to)?.center ?? null) : null
  }
  return null
}

/** The sketch point within `tol` of `at`, nearest first: ends, corners, circle and arc centers, and the origin. */
export function pointHit(sketch: Sketch, at: V2, tol: number): SketchPointRef | null {
  let best: SketchPointRef | null = null
  let bestD = tol
  const take = (r: SketchPointRef) => {
    const p = pointAt(sketch, r)
    const d = p ? dist(p, at) : Infinity
    if (d <= bestD) {
      bestD = d
      best = r
    }
  }
  take({ e: -1, at: 'start' })
  sketch.forEach((e, i) => {
    if (e.kind === 'circle') return take({ e: i, at: 'center' })
    take({ e: i, at: 'start' })
    e.segs.forEach((s, k) => {
      // a closed chain's last end is its start
      if (!(e.closed && k === e.segs.length - 1)) take({ e: i, at: 'to', seg: k })
      if (s.kind === 'arc') take({ e: i, at: 'arcCenter', seg: k })
    })
  })
  return best
}

type Curve = { kind: 'line'; a: V2; b: V2 } | { kind: 'circle'; center: V2; r: number } | { kind: 'arc'; center: V2; r: number }

function curveAt(sketch: Sketch, r: SketchCurveRef): Curve | null {
  // the sketch's X axis
  if (r.e === -1) return { kind: 'line', a: [0, 0], b: [1, 0] }
  const e: Entity | undefined = sketch[r.e]
  if (!e) return null
  if (e.kind === 'circle') return { kind: 'circle', center: e.center, r: e.diameterMm / 2 }
  const s = e.segs[r.seg]
  if (!s) return null
  const a = segStart(e, r.seg)
  if (s.kind === 'line') return { kind: 'line', a, b: s.to }
  const arc = arcThrough(a, s.through, s.to)
  return arc ? { kind: 'arc', center: arc.center, r: arc.r } : null
}

const unit = (a: V2, b: V2): V2 => {
  const l = dist(a, b)
  return l < EPS ? [0, 0] : [(b[0] - a[0]) / l, (b[1] - a[1]) / l]
}

/** The signed distance of `p` from the line through a and b, positive to its left. */
export function sideOf(a: V2, b: V2, p: V2): number {
  const u = unit(a, b)
  return u[0] * (p[1] - a[1]) - u[1] * (p[0] - a[0])
}

function pointToLine(p: V2, a: V2, b: V2): number {
  return Math.abs(sideOf(a, b, p))
}

// the angle from line a to line b, counterclockwise, in [0, 360)
function angleBetween(a: { a: V2; b: V2 }, b: { a: V2; b: V2 }): number {
  const ta = Math.atan2(a.b[1] - a.a[1], a.b[0] - a.a[0])
  const tb = Math.atan2(b.b[1] - b.a[1], b.b[0] - b.a[0])
  return ((((tb - ta) * DEG) % 360) + 360) % 360
}

/**
 * The dimension the picks make, its value now and the label at `at` (plane mm), or null when they make none. `value`
 * is mm, or degrees for an angle.
 */
export function dimensionFor(sketch: Sketch, picks: readonly DimPick[], at: V2): DimConstraint | null {
  const curves = picks.flatMap((p) => ('curve' in p ? [p.curve] : []))
  const points = picks.flatMap((p) => ('point' in p ? [p.point] : []))
  if (picks.length === 1 && curves.length === 1) {
    const c = curveAt(sketch, curves[0]!)
    if (!c) return null
    if (c.kind === 'line') return { type: 'length', line: curves[0]!, value: round(dist(c.a, c.b)), offset: round(sideOf(c.a, c.b, at)) }
    return c.kind === 'circle' ? { type: 'diameter', circle: curves[0]!, value: round(2 * c.r) } : { type: 'radius', circle: curves[0]!, value: round(c.r) }
  }
  if (points.length === 2) {
    const a = pointAt(sketch, points[0]!)
    const b = pointAt(sketch, points[1]!)
    if (!a || !b || dist(a, b) < EPS) return null
    // a label past both points across one axis measures along the other, as Fusion does
    const inX = at[0] >= Math.min(a[0], b[0]) && at[0] <= Math.max(a[0], b[0])
    const inY = at[1] >= Math.min(a[1], b[1]) && at[1] <= Math.max(a[1], b[1])
    if (inX && !inY) return { type: 'horizontalDistance', a: points[0]!, b: points[1]!, value: round(Math.abs(b[0] - a[0])), offset: round(at[1] - (a[1] + b[1]) / 2) }
    if (inY && !inX) return { type: 'verticalDistance', a: points[0]!, b: points[1]!, value: round(Math.abs(b[1] - a[1])), offset: round(at[0] - (a[0] + b[0]) / 2) }
    return { type: 'distance', a: points[0]!, b: points[1]!, value: round(dist(a, b)), offset: round(sideOf(a, b, at)) }
  }
  if (curves.length === 2) {
    const ca = curveAt(sketch, curves[0]!)
    const cb = curveAt(sketch, curves[1]!)
    if (ca?.kind !== 'line' || cb?.kind !== 'line') return null
    const ang = angleBetween(ca, cb)
    if (Math.min(ang % 180, 180 - (ang % 180)) < 1e-6) {
      // parallel lines: the gap between them, from the first line's start
      const start: SketchPointRef = curves[0]!.seg === 0 ? { e: curves[0]!.e, at: 'start' } : { e: curves[0]!.e, at: 'to', seg: curves[0]!.seg - 1 }
      return { type: 'lineDistance', point: start, line: curves[1]!, value: round(pointToLine(ca.a, cb.a, cb.b)) }
    }
    return { type: 'angle', a: curves[0]!, b: curves[1]!, value: round(ang) }
  }
  if (points.length === 1 && curves.length === 1) {
    const p = pointAt(sketch, points[0]!)
    const c = curveAt(sketch, curves[0]!)
    if (!p || c?.kind !== 'line') return null
    return { type: 'lineDistance', point: points[0]!, line: curves[0]!, value: round(pointToLine(p, c.a, c.b)) }
  }
  return null
}

/** What a value constraint measures in the sketch as drawn now: mm, or degrees for an angle. Null for others. */
export function measured(sketch: Sketch, c: SketchConstraint): number | null {
  switch (c.type) {
    case 'length': {
      const l = curveAt(sketch, c.line)
      return l?.kind === 'line' ? dist(l.a, l.b) : null
    }
    case 'radius':
    case 'diameter': {
      const k = curveAt(sketch, c.circle)
      return k && k.kind !== 'line' ? (c.type === 'radius' ? k.r : 2 * k.r) : null
    }
    case 'distance':
    case 'horizontalDistance':
    case 'verticalDistance': {
      const a = pointAt(sketch, c.a)
      const b = pointAt(sketch, c.b)
      if (!a || !b) return null
      return c.type === 'distance' ? dist(a, b) : c.type === 'horizontalDistance' ? Math.abs(b[0] - a[0]) : Math.abs(b[1] - a[1])
    }
    case 'lineDistance': {
      const p = pointAt(sketch, c.point)
      const l = curveAt(sketch, c.line)
      return p && l?.kind === 'line' ? pointToLine(p, l.a, l.b) : null
    }
    case 'angle': {
      const a = curveAt(sketch, c.a)
      const b = curveAt(sketch, c.b)
      return a?.kind === 'line' && b?.kind === 'line' ? angleBetween(a, b) : null
    }
    default:
      return null
  }
}

/** Whether a constraint carries a value the dimension tool sets. */
export const isDimension = (c: SketchConstraint): c is DimConstraint => 'value' in c

const round = (v: number): number => Math.round(v * 1e6) / 1e6

/**
 * Solves a sketch with its constraints away from the editor (for an agent): the drawing moves to meet them, and a
 * dimension that would over-define it turns driven, the latest first, as the dimension tool keeps it.
 */
export async function settle(sketch: Sketch, constraints: readonly SketchConstraint[], signal?: AbortSignal): Promise<{ sketch: Entity[]; constraints: SketchConstraint[]; solved: Solved }> {
  const list = [...constraints]
  for (;;) {
    const { solver, map } = toSolver(sketch, list)
    const s = await solveSketch(solver, undefined, signal)
    const over = [...s.redundant, ...(s.status === 'conflict' ? s.conflicting : [])].map((j) => map.from[j] ?? -1).filter((k) => k >= 0 && isDimension(list[k]!) && !list[k]!.driven)
    if (!over.length) {
      const next = s.status === 'ok' || s.status === 'redundant' ? fromSolver(sketch, s, map) : [...sketch]
      // a driven dimension reads what the solved drawing measures
      const out = list.map((c) => (isDimension(c) && c.driven ? ({ ...c, value: round(measured(next, c) ?? c.value) } as SketchConstraint) : c))
      return { sketch: next, constraints: out, solved: s }
    }
    const k = Math.max(...over)
    list[k] = { ...list[k]!, driven: true } as SketchConstraint
  }
}
