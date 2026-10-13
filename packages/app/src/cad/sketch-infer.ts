// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The constraints a drawing tool leaves behind, as in Fusion: a level line is horizontal, a line square to the last is
// perpendicular, an arc off a line's end is tangent, and a point dropped on another curve's end point, midpoint,
// center or edge is held there. Ctrl or Cmd on the click leaves none.
import type { SketchConstraint, SketchCurveRef, SketchPointRef } from './sketch-constraints'
import { arcThrough, chainEnd, dist, reverseChain, segStart, type Chain, type Entity, type SnapKind, type Sketch, type V2 } from './sketch-model'

const EPS = 1e-6
// unit vectors this close count as square or in line
const ANG = 1e-6

/** A click of the shape just drawn and what it snapped to. */
export interface Landing {
  at: V2
  kind: SnapKind | null
}

const same = (a: V2, b: V2): boolean => dist(a, b) < EPS
const keyOf = (c: SketchConstraint): string => JSON.stringify(c)

/** A segment's unit direction at its start or end. */
function dirAt(c: Chain, i: number, end: boolean): V2 | null {
  const s = c.segs[i]
  if (!s) return null
  const from = segStart(c, i)
  if (s.kind === 'line') {
    const d = dist(from, s.to)
    return d < EPS ? null : [(s.to[0] - from[0]) / d, (s.to[1] - from[1]) / d]
  }
  const a = arcThrough(from, s.through, s.to)
  if (!a) return null
  const p = end ? s.to : from
  const r: V2 = [(p[0] - a.center[0]) / a.r, (p[1] - a.center[1]) / a.r]
  return a.sweep > 0 ? [-r[1], r[0]] : [r[1], -r[0]]
}

/** Every point of an entity with its reference. */
function pointsOf(sketch: Sketch, e: number): { ref: SketchPointRef; at: V2 }[] {
  const x = sketch[e]
  if (!x) return []
  if (x.kind === 'circle') return [{ ref: { e, at: 'center' }, at: x.center }]
  const out: { ref: SketchPointRef; at: V2 }[] = []
  // a closed chain's last end is its start
  if (!x.closed) out.push({ ref: { e, at: 'start' }, at: x.start })
  x.segs.forEach((s, seg) => out.push({ ref: { e, at: 'to', seg }, at: s.to }))
  return out
}

/** Centers of an entity: a circle's, or each arc's. */
function centersOf(sketch: Sketch, e: number): { ref: SketchPointRef; curve: SketchCurveRef; at: V2 }[] {
  const x = sketch[e]
  if (!x) return []
  if (x.kind === 'circle') return [{ ref: { e, at: 'center' }, curve: { e, seg: 0 }, at: x.center }]
  return x.segs.flatMap((s, seg) => {
    if (s.kind !== 'arc') return []
    const a = arcThrough(segStart(x, seg), s.through, s.to)
    return a ? [{ ref: { e, at: 'arcCenter' as const, seg }, curve: { e, seg }, at: a.center }] : []
  })
}

function onSegment(p: V2, a: V2, b: V2): boolean {
  const l = dist(a, b)
  if (l < EPS) return false
  const cross = ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / l
  const t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (l * l)
  return Math.abs(cross) < 1e-4 && t > EPS && t < 1 - EPS
}

/** What a point landed on, among every entity but `skip`. */
function landedOn(sketch: Sketch, skip: number, l: Landing, own: SketchPointRef, ownCurve?: SketchCurveRef): SketchConstraint | null {
  for (let e = 0; e < sketch.length; e++) {
    if (e === skip) continue
    const x = sketch[e]!
    if (l.kind === 'vertex') {
      const q = pointsOf(sketch, e).find((p) => same(p.at, l.at))
      if (q) return { type: 'coincident', a: own, b: q.ref }
    } else if (l.kind === 'center') {
      const q = centersOf(sketch, e).find((p) => same(p.at, l.at))
      if (q) return ownCurve ? { type: 'concentric', a: ownCurve, b: q.curve } : { type: 'coincident', a: own, b: q.ref }
    } else if (l.kind === 'midpoint' && x.kind === 'chain') {
      const seg = x.segs.findIndex((s, i) => s.kind === 'line' && same(l.at, [(segStart(x, i)[0] + s.to[0]) / 2, (segStart(x, i)[1] + s.to[1]) / 2]))
      if (seg >= 0) return { type: 'midpoint', point: own, line: { e, seg } }
    } else if (l.kind === 'edge') {
      if (x.kind === 'circle') {
        if (Math.abs(dist(l.at, x.center) - x.diameterMm / 2) < 1e-4) return { type: 'onCircle', point: own, circle: { e, seg: 0 } }
      } else {
        const seg = x.segs.findIndex((s, i) => s.kind === 'line' && onSegment(l.at, segStart(x, i), s.to))
        if (seg >= 0) return { type: 'onLine', point: own, line: { e, seg } }
      }
    }
  }
  return null
}

/** Constraints between two joined segments: tangent where an arc runs on smoothly, perpendicular at a square corner. */
function joint(c: Chain, e: number, i: number, k: number, square: boolean): SketchConstraint | null {
  const a = dirAt(c, i, true)
  const b = dirAt(c, k, false)
  if (!a || !b) return null
  const cross = a[0] * b[1] - a[1] * b[0]
  const dot = a[0] * b[0] + a[1] * b[1]
  const arcs = c.segs[i]!.kind === 'arc' || c.segs[k]!.kind === 'arc'
  if (arcs && Math.abs(cross) < ANG && dot > 0) return { type: 'tangent', a: { e, seg: i }, b: { e, seg: k } }
  if (!arcs && square && Math.abs(dot) < ANG) return { type: 'perpendicular', a: { e, seg: i }, b: { e, seg: k } }
  return null
}

/**
 * The constraints a click adds, going from `before` to `after` (the tool's click result), for the shape's clicks in
 * `landed`. Ones already in `have` are left out.
 */
export function inferred(before: Sketch, after: Sketch, landed: readonly Landing[], have: readonly SketchConstraint[]): SketchConstraint[] {
  let e = after.length > before.length ? after.length - 1 : after.findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(before[i]))
  if (e < 0) return []
  const x = after[e]!
  const old = e < before.length ? before[e] : undefined
  const out: SketchConstraint[] = []
  if (x.kind === 'chain' && !x.construction) {
    const from = old?.kind === 'chain' ? old.segs.length : 0
    // every level or upright line, so a corner between two of them needs no square constraint
    const hv = new Set<number>()
    for (let i = 0; i < x.segs.length; i++) {
      const d = dirAt(x, i, false)
      if (x.segs[i]!.kind !== 'line' || !d) continue
      const type = Math.abs(d[1]) < EPS ? 'horizontal' : Math.abs(d[0]) < EPS ? 'vertical' : null
      if (!type) continue
      hv.add(i)
      if (i >= from) out.push({ type, line: { e, seg: i } })
    }
    const n = x.segs.length
    // joints the click made: each new segment with the one before, and the close with the first
    const joints: [number, number][] = []
    for (let i = Math.max(1, from); i < n; i++) joints.push([i - 1, i])
    if (x.closed && !(old?.kind === 'chain' && old.closed) && n > 1) joints.push([n - 1, 0])
    let squares = 0
    for (const [i, k] of joints) {
      // a closed all-line loop is held square by one fewer corner than it has
      const square = !(hv.has(i) && hv.has(k)) && !(x.closed && squares >= n - 1)
      const j = joint(x, e, i, k, square)
      if (j) out.push(j)
      if (j?.type === 'perpendicular') squares++
    }
  }
  const ownCurve = x.kind === 'circle' ? { e, seg: 0 } : undefined
  for (const l of landed) {
    if (!l.kind || l.kind === 'grid' || l.kind === 'horizontal' || l.kind === 'vertical') continue
    const own = pointsOf(after, e).find((p) => same(p.at, l.at))
    if (!own) continue
    const c = landedOn(after, e, l, own.ref, ownCurve)
    if (c) out.push(c)
  }
  const seen = new Set(have.map(keyOf))
  return out.filter((c) => {
    const k = keyOf(c)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Which chain a click turned round to go on from its start (sketch-model's chainAt), or -1. */
export function reversedChain(before: Sketch, after: Sketch): number {
  return before.findIndex((b, i) => {
    const a = after[i]
    if (b.kind !== 'chain' || a?.kind !== 'chain' || b.closed || b.segs.length === 0) return false
    const end = chainEnd(b)
    return !!end && !same(end, b.start) && same(a.start, end) && JSON.stringify(reverseChain(b).segs) === JSON.stringify(a.segs.slice(0, b.segs.length))
  })
}
