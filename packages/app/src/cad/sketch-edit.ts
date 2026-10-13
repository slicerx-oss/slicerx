// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch's edit tools, as in Fusion: trim, extend, mirror, pattern and corner fillets. The engine changes the loops
// (sketch.trim and the rest); the constraints follow here. A point of an edited loop is found again where it was, and
// a curve by its ends, or by the line or circle it lies on for constraints that only need that. A constraint whose
// point or curve is gone goes with it. Ends a trim or extend leaves on another curve stay on it.
import type { SketchEdited } from '../geom/cad'
import type { SketchConstraint, SketchCurveRef, SketchPointRef } from './sketch-constraints'
import { pointAt } from './sketch-dimension'
import { arcThrough, dist, segStart, toLoops, type Entity, type Sketch, type V2 } from './sketch-model'

// points this close are one, mm (the drawing keeps 6 decimals)
const TOL = 1e-5

/** Every point of an entity a constraint can name: a circle's center; a chain's start, corners, ends and arc centers. */
export function pointRefs(e: Entity, i: number): SketchPointRef[] {
  if (e.kind === 'circle') return [{ e: i, at: 'center' }]
  // a closed chain's start is its last segment's end
  const out: SketchPointRef[] = e.closed ? [] : [{ e: i, at: 'start' }]
  e.segs.forEach((s, seg) => {
    out.push({ e: i, at: 'to', seg })
    if (s.kind === 'arc') out.push({ e: i, at: 'arcCenter', seg })
  })
  return out
}

type Carrier = { line: [V2, V2] } | { circle: V2; r: number }

// what a curve is: its ends (none for a circle) and the line or circle it lies on
function curveOf(sketch: Sketch, r: SketchCurveRef): { ends: [V2, V2] | null; on: Carrier } | null {
  const e = sketch[r.e]
  if (!e) return null
  if (e.kind === 'circle') return r.seg === 0 ? { ends: null, on: { circle: e.center, r: e.diameterMm / 2 } } : null
  const s = e.segs[r.seg]
  if (!s) return null
  const a = segStart(e, r.seg)
  if (s.kind === 'line') return { ends: [a, s.to], on: { line: [a, s.to] } }
  const c = arcThrough(a, s.through, s.to)
  return c ? { ends: [a, s.to], on: { circle: c.center, r: c.r } } : null
}

const sameCarrier = (a: Carrier, b: Carrier): boolean => {
  if ('line' in a && 'line' in b) return b.line.every((p) => offLine(p, a.line) < TOL)
  if ('circle' in a && 'circle' in b) return dist(a.circle, b.circle) < TOL && Math.abs(a.r - b.r) < TOL
  return false
}

function offLine(p: V2, [a, b]: [V2, V2]): number {
  const d: V2 = [b[0] - a[0], b[1] - a[1]]
  const l = Math.hypot(d[0], d[1])
  return l > 0 ? Math.abs((p[0] - a[0]) * d[1] - (p[1] - a[1]) * d[0]) / l : dist(p, a)
}

function curveRefs(e: Entity, i: number): SketchCurveRef[] {
  return e.kind === 'circle' ? [{ e: i, seg: 0 }] : e.segs.map((_, seg) => ({ e: i, seg }))
}

const isLineish = (k: Carrier): boolean => 'line' in k

// constraints that need the very same curve, ends and all; the rest hold on any piece of its line or circle
const needsEnds = (c: SketchConstraint, was: Carrier): boolean => c.type === 'length' || c.type === 'midpoint' || (c.type === 'equal' && isLineish(was))

const key = (c: SketchConstraint): string => JSON.stringify(c)
const loopKey = (e: Entity | undefined): string => (e ? JSON.stringify(toLoops([e])) : '')

/**
 * The constraints of `old` moved onto `next`, where `from[j]` lists the loops of `old` that loop j of `next` came from.
 * A loop kept as it was keeps its constraints as they are, under its new index.
 */
export function remapConstraints(old: Sketch, next: Sketch, from: readonly (readonly number[])[], constraints: readonly SketchConstraint[]): SketchConstraint[] {
  const kept = new Map<number, number>()
  from.forEach((o, j) => {
    if (o.length === 1 && !kept.has(o[0]!) && loopKey(old[o[0]!]) === loopKey(next[j])) kept.set(o[0]!, j)
  })
  const pieces = (o: number): number[] => from.flatMap((x, j) => (x.includes(o) ? [j] : []))
  const point = (r: SketchPointRef): SketchPointRef | null => {
    if (r.e === -1) return r
    const k = kept.get(r.e)
    if (k !== undefined) return { ...r, e: k }
    const p = pointAt(old, r)
    if (!p) return null
    for (const j of pieces(r.e)) {
      const hit = pointRefs(next[j]!, j).find((q) => {
        const at = pointAt(next, q)
        // a point stays the kind it was: an end is not an arc center that happens to sit there
        return at && dist(at, p) < TOL && (q.at === 'arcCenter' || q.at === 'center') === (r.at === 'arcCenter' || r.at === 'center')
      })
      if (hit) return hit
    }
    return null
  }
  const curves = (r: SketchCurveRef, c: SketchConstraint): SketchCurveRef[] => {
    const k = kept.get(r.e)
    if (k !== undefined) return [{ ...r, e: k }]
    const was = curveOf(old, r)
    if (!was) return []
    const exact: SketchCurveRef[] = []
    const loose: SketchCurveRef[] = []
    for (const j of pieces(r.e)) {
      for (const q of curveRefs(next[j]!, j)) {
        const now = curveOf(next, q)
        if (!now || !sameCarrier(was.on, now.on)) continue
        const same = was.ends && now.ends ? (dist(was.ends[0], now.ends[0]) < TOL && dist(was.ends[1], now.ends[1]) < TOL) || (dist(was.ends[0], now.ends[1]) < TOL && dist(was.ends[1], now.ends[0]) < TOL) : !was.ends && !now.ends
        ;(same ? exact : loose).push(q)
      }
    }
    if (exact.length) return exact.slice(0, 1)
    return needsEnds(c, was.on) ? [] : loose
  }
  const out: SketchConstraint[] = []
  const seen = new Set<string>()
  const push = (c: SketchConstraint) => {
    const k = key(c)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(c)
    }
  }
  for (const c of constraints) {
    const fields = Object.entries(c)
    const pts: Record<string, SketchPointRef> = {}
    const crv: Record<string, SketchCurveRef[]> = {}
    let ok = true
    for (const [f, v] of fields) {
      if (!v || typeof v !== 'object') continue
      if ('at' in v) {
        const p = point(v as SketchPointRef)
        if (p) pts[f] = p
        else ok = false
      } else {
        const list = curves(v as SketchCurveRef, c)
        if (list.length) crv[f] = list
        else ok = false
      }
    }
    if (!ok) continue
    // a lone line's or circle's own constraint (horizontal, a radius) holds on each piece; pairs take the first
    const names = Object.keys(crv)
    const alone = names.length === 1 && !Object.keys(pts).length && !isDim(c)
    for (const one of alone ? crv[names[0]!]! : [null]) {
      const moved: Record<string, unknown> = { ...c, ...pts }
      for (const n of names) moved[n] = one ?? crv[n]![0]
      const nc = moved as SketchConstraint
      if (!degenerate(nc) && !ownJoint(next, nc)) push(nc)
    }
  }
  return out
}

const isDim = (c: SketchConstraint): boolean => 'value' in c

// what a chain already holds: a point on or at the end of its own neighboring segment, two names for one corner
function ownJoint(sketch: Sketch, c: SketchConstraint): boolean {
  if (c.type === 'coincident') {
    const [a, b] = [pointAt(sketch, c.a), pointAt(sketch, c.b)]
    return c.a.e === c.b.e && !!a && !!b && dist(a, b) < TOL && c.a.at !== 'arcCenter' && c.b.at !== 'arcCenter'
  }
  if (c.type !== 'onLine' && c.type !== 'onCircle') return false
  const r = 'line' in c ? c.line : c.circle
  const p = pointAt(sketch, c.point)
  const g = curveOf(sketch, r)
  return c.point.e === r.e && !!p && !!g?.ends && g.ends.some((q) => dist(p, q) < TOL)
}

// a constraint between a thing and itself
function degenerate(c: SketchConstraint): boolean {
  const refs = Object.values(c).filter((v): v is object => !!v && typeof v === 'object')
  return refs.length === 2 && JSON.stringify(refs[0]) === JSON.stringify(refs[1])
}

/**
 * New ends of loops that came from `edited` (a trim's crossings, an extend's landing) held where they are: on the
 * point of another loop that sits there, or on the line or circle they meet.
 */
export function heldEnds(old: Sketch, next: Sketch, from: readonly (readonly number[])[], edited: number): SketchConstraint[] {
  const out: SketchConstraint[] = []
  from.forEach((o, j) => {
    if (!o.includes(edited)) return
    // the points the loops it came from had already
    const before = o.flatMap((i) => (old[i] ? pointRefs(old[i]!, i).map((r) => pointAt(old, r)) : [])).filter((p): p is V2 => !!p)
    const e = next[j]!
    if (e.kind !== 'chain' || e.closed) return
    const ends: SketchPointRef[] = [{ e: j, at: 'start' }, { e: j, at: 'to', seg: e.segs.length - 1 }]
    for (const r of ends) {
      const p = pointAt(next, r)
      if (!p || before.some((b) => dist(b, p) < TOL)) continue
      const other = next.flatMap((x, k) => (k === j ? [] : pointRefs(x, k))).find((q) => q.at !== 'arcCenter' && q.at !== 'center' && dist(pointAt(next, q) ?? [Infinity, Infinity], p) < TOL)
      if (other) {
        out.push({ type: 'coincident', a: r, b: other })
        continue
      }
      for (let k = 0; k < next.length; k++) {
        if (k === j) continue
        const on = curveRefs(next[k]!, k).find((q) => {
          const g = curveOf(next, q)
          return g && onCurve(p, g)
        })
        if (!on) continue
        const g = curveOf(next, on)!
        out.push('line' in g.on ? { type: 'onLine', point: r, line: on } : { type: 'onCircle', point: r, circle: on })
        break
      }
    }
  })
  return out
}

function onCurve(p: V2, g: { ends: [V2, V2] | null; on: Carrier }): boolean {
  if ('circle' in g.on) return Math.abs(dist(p, g.on.circle) - g.on.r) < TOL
  const [a, b] = g.on.line
  const l = dist(a, b)
  const t = l > 0 ? ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (l * l) : 0
  return offLine(p, g.on.line) < TOL && t > -TOL / l && t < 1 + TOL / l
}

/** A copy mirrored across sketch line `axis` held to its original: each pair of points symmetric (one point if on the line), circles equal. */
export function mirrorConstraints(next: Sketch, pairs: readonly (readonly [number, number])[], axis: SketchCurveRef): SketchConstraint[] {
  const out: SketchConstraint[] = []
  for (const [o, c] of pairs) {
    const a = pointRefs(next[o]!, o)
    const b = pointRefs(next[c]!, c)
    a.forEach((ra, i) => {
      const rb = b[i]
      const pa = pointAt(next, ra)
      const pb = rb ? pointAt(next, rb) : null
      if (!rb || !pa || !pb) return
      out.push(dist(pa, pb) < TOL ? { type: 'coincident', a: ra, b: rb } : { type: 'symmetric', a: ra, b: rb, line: axis })
    })
    if (next[o]!.kind === 'circle') out.push({ type: 'equal', a: { e: o, seg: 0 }, b: { e: c, seg: 0 } })
  }
  return out
}

/** The loops and their constraints after an engine edit, with the edited loop's new ends held where they landed. */
export function afterEdit(old: Sketch, next: Sketch, r: Pick<SketchEdited, 'from'>, constraints: readonly SketchConstraint[], edited?: number): SketchConstraint[] {
  const moved = remapConstraints(old, next, r.from, constraints)
  if (edited === undefined) return moved
  const have = new Set(moved.map(key))
  return [...moved, ...heldEnds(old, next, r.from, edited).filter((c) => !have.has(key(c)))]
}

/** Which end of an open chain a click near segment `seg` means, or null when that segment has no open end. */
export function endNear(sketch: Sketch, e: number, seg: number, at: V2): 'start' | 'end' | null {
  const c = sketch[e]
  if (!c || c.kind !== 'chain' || c.closed || !c.segs.length) return null
  const last = c.segs.length - 1
  if (seg !== 0 && seg !== last) return null
  if (last === 0) return dist(at, c.start) <= dist(at, c.segs[0]!.to) ? 'start' : 'end'
  return seg === 0 ? 'start' : 'end'
}
