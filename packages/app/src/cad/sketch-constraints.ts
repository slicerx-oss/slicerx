// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch's constraints, and the bridge to the engine's solver (sketch.solve). The drawing stays chains and
// circles (sketch-model.ts); constraints name their points and curves by loop and segment, so a chain's shared
// corners are one solver point and an arc is its center, start and end. Old sketches have no constraints and load
// as free geometry.
import type { SketchConstraint, SketchCurveRef, SketchPointRef } from '@slicerx/cad-history'
import { arcThrough, type Entity, type V2 } from './sketch-model'

export type { SketchConstraint, SketchCurveRef, SketchPointRef }

export type SolverEntity = { type: 'line'; a: number; b: number } | { type: 'circle'; center: number; radius: number } | { type: 'arc'; center: number; start: number; end: number }

/** The engine's sketch: points, entities and constraints by index. */
export interface SolverSketch {
  points: V2[]
  entities: SolverEntity[]
  constraints: Record<string, unknown>[]
}

export interface Solved {
  status: 'ok' | 'redundant' | 'conflict' | 'failed'
  points: V2[]
  radii: (number | null)[]
  dof: number
  freePoints: boolean[]
  freeRadii: boolean[]
  conflicting: number[]
  redundant: number[]
}

/** Where each sketch point and curve went in the solver sketch. */
export interface SolverMap {
  point: Map<string, number>
  curve: Map<string, number>
  /** Constraints left out because a point or curve they name is gone, by index in the sketch's list. */
  dropped: number[]
  /** Solver constraint index to the sketch's. */
  from: number[]
}

export const pointKey = (r: SketchPointRef): string => ('seg' in r ? `${r.e}:${r.at}:${r.seg}` : `${r.e}:${r.at}`)
export const curveKey = (r: SketchCurveRef): string => `${r.e}:${r.seg}`

/** The solver sketch for a drawing and its constraints. */
export function toSolver(sketch: readonly Entity[], constraints: readonly SketchConstraint[]): { solver: SolverSketch; map: SolverMap } {
  const points: V2[] = []
  const entities: SolverEntity[] = []
  const point = new Map<string, number>()
  const curve = new Map<string, number>()
  const add = (p: V2, key: string): number => {
    point.set(key, points.length)
    points.push(p)
    return points.length - 1
  }
  sketch.forEach((e, i) => {
    if (e.kind === 'circle') {
      const c = add(e.center, `${i}:center`)
      curve.set(`${i}:0`, entities.length)
      entities.push({ type: 'circle', center: c, radius: e.diameterMm / 2 })
      return
    }
    const start = add(e.start, `${i}:start`)
    let from = start
    e.segs.forEach((s, k) => {
      // a closed chain's last segment ends on its start
      const last = e.closed && k === e.segs.length - 1
      const to = last ? start : add(s.to, `${i}:to:${k}`)
      if (last) point.set(`${i}:to:${k}`, start)
      const arc = s.kind === 'arc' ? arcThrough(points[from]!, s.through, s.to) : null
      curve.set(`${i}:${k}`, entities.length)
      if (arc) {
        const c = add(arc.center, `${i}:arcCenter:${k}`)
        // the solver's arcs run counterclockwise
        entities.push(arc.sweep > 0 ? { type: 'arc', center: c, start: from, end: to } : { type: 'arc', center: c, start: to, end: from })
      } else {
        entities.push({ type: 'line', a: from, b: to })
      }
      from = to
    })
  })
  const dropped: number[] = []
  const from: number[] = []
  const out: Record<string, unknown>[] = []
  constraints.forEach((c, k) => {
    const r: Record<string, unknown> = { type: c.type }
    let ok = true
    for (const [field, v] of Object.entries(c)) {
      if (field === 'type') continue
      if (typeof v === 'number') r[field] = v
      else if (v && typeof v === 'object' && 'at' in v) {
        const i = point.get(pointKey(v as SketchPointRef))
        if (i === undefined) ok = false
        else r[field] = i
      } else if (v && typeof v === 'object') {
        const i = curve.get(curveKey(v as SketchCurveRef))
        if (i === undefined) ok = false
        else r[field] = i
      }
    }
    if (!ok) return void dropped.push(k)
    from.push(k)
    out.push(r)
  })
  return { solver: { points, entities, constraints: out }, map: { point, curve, dropped, from } }
}

const round = (v: number): number => Math.round(v * 1e6) / 1e6

/** The drawing moved to where the solver put its points. Arcs keep their direction and pass through their middle. */
export function fromSolver(sketch: readonly Entity[], solved: Pick<Solved, 'points' | 'radii'>, map: SolverMap): Entity[] {
  const at = (key: string, keep: V2): V2 => {
    const i = map.point.get(key)
    const p = i === undefined ? undefined : solved.points[i]
    return p ? [round(p[0]), round(p[1])] : keep
  }
  return sketch.map((e, i): Entity => {
    if (e.kind === 'circle') {
      const k = map.curve.get(`${i}:0`)
      const r = k === undefined ? null : solved.radii[k]
      return { ...e, center: at(`${i}:center`, e.center), diameterMm: r ? round(2 * r) : e.diameterMm }
    }
    const start = at(`${i}:start`, e.start)
    let from = start
    const segs = e.segs.map((s, k) => {
      const to = at(`${i}:to:${k}`, s.to)
      const a = from
      from = to
      if (s.kind === 'line') return { ...s, to }
      const was = arcThrough(segStartOf(e, k), s.through, s.to)
      const c = was ? at(`${i}:arcCenter:${k}`, was.center) : null
      return { ...s, to, through: c && was ? arcMiddle(c, a, to, was.sweep > 0) : s.through }
    })
    return { ...e, start, segs }
  })
}

function segStartOf(e: Extract<Entity, { kind: 'chain' }>, k: number): V2 {
  return k === 0 ? e.start : e.segs[k - 1]!.to
}

// the point halfway round the arc about c from a to b, counterclockwise or not
function arcMiddle(c: V2, a: V2, b: V2, ccw: boolean): V2 {
  const r = Math.hypot(a[0] - c[0], a[1] - c[1])
  const t0 = Math.atan2(a[1] - c[1], a[0] - c[0])
  const t1 = Math.atan2(b[1] - c[1], b[0] - c[0])
  const full = 2 * Math.PI
  let sweep = (((t1 - t0) % full) + full) % full
  if (sweep === 0) sweep = full
  if (!ccw) sweep -= full
  const t = t0 + sweep / 2
  return [round(c[0] + r * Math.cos(t)), round(c[1] + r * Math.sin(t))]
}

/** How a curve shows: free to move, fully defined, or fixed in place. */
export type DefState = 'free' | 'defined' | 'fixed'

/** Per curve, by `${loop}:${segment}`: whether the solve left it free, defined, or fixed by Fix constraints. */
export function curveStates(sketch: readonly Entity[], constraints: readonly SketchConstraint[], solved: Pick<Solved, 'freePoints' | 'freeRadii'>, map: SolverMap): Map<string, DefState> {
  const fixed = new Set<number>()
  for (const c of constraints) {
    if (c.type !== 'fix') continue
    const i = map.point.get(pointKey(c.point))
    if (i !== undefined) fixed.add(i)
  }
  const out = new Map<string, DefState>()
  const state = (pts: number[], radius?: number): DefState => {
    if (pts.some((p) => solved.freePoints[p] !== false) || (radius !== undefined && solved.freeRadii[radius] !== false)) return 'free'
    return pts.every((p) => fixed.has(p)) && radius === undefined ? 'fixed' : 'defined'
  }
  sketch.forEach((e, i) => {
    if (e.kind === 'circle') {
      const k = map.curve.get(`${i}:0`)
      out.set(`${i}:0`, state([map.point.get(`${i}:center`)!], k))
      return
    }
    e.segs.forEach((_, k) => {
      const a = map.point.get(k === 0 ? `${i}:start` : `${i}:to:${k - 1}`)!
      const b = map.point.get(`${i}:to:${k}`)!
      const c = map.point.get(`${i}:arcCenter:${k}`)
      out.set(`${i}:${k}`, state(c === undefined ? [a, b] : [a, b, c]))
    })
  })
  return out
}

/** The palette's line for a solve: fully defined, the freedom left, or what went wrong. */
export function dofText(solved: Pick<Solved, 'status' | 'dof'> | null): string {
  if (!solved) return ''
  if (solved.status === 'conflict') return 'Over-constrained: some constraints conflict'
  if (solved.status === 'redundant') return 'Over-constrained: a constraint repeats another'
  if (solved.status === 'failed') return 'The constraints could not be met'
  if (solved.dof === 0) return 'Fully constrained'
  return `${solved.dof} degree${solved.dof === 1 ? '' : 's'} of freedom left`
}

/** How the status line reads: done when fully constrained, warn when over-constrained or unsolved. */
export function dofTone(solved: Pick<Solved, 'status' | 'dof'>): 'done' | 'warn' | 'open' {
  if (solved.status !== 'ok') return 'warn'
  return solved.dof === 0 ? 'done' : 'open'
}

/**
 * The constraints after loop `e` is replaced by `count` loops (0 when it is deleted, 2 when a chain splits): the ones
 * naming it are dropped, and later loops' indices shift.
 */
export function afterLoopChange(constraints: readonly SketchConstraint[], e: number, count: number): SketchConstraint[] {
  const shift = count - 1
  const move = <T extends { e: number }>(r: T): T | null => (r.e === e ? null : r.e > e ? { ...r, e: r.e + shift } : r)
  const out: SketchConstraint[] = []
  for (const c of constraints) {
    const next: Record<string, unknown> = {}
    let keep = true
    for (const [field, v] of Object.entries(c)) {
      if (v && typeof v === 'object') {
        const m = move(v as { e: number })
        if (!m) keep = false
        next[field] = m
      } else next[field] = v
    }
    if (keep) out.push(next as SketchConstraint)
  }
  return out
}

/** Constraints after chain `e` (of `n` segments) was turned round, so its points and segments count from the other end. */
export function afterReverse(constraints: readonly SketchConstraint[], e: number, n: number): SketchConstraint[] {
  const flip = (r: unknown): unknown => {
    if (!r || typeof r !== 'object' || (r as { e?: number }).e !== e) return r
    const x = r as SketchPointRef | SketchCurveRef
    if ('at' in x) {
      if (x.at === 'start') return { e, at: 'to', seg: n - 1 }
      if (x.at === 'to') return x.seg === n - 1 ? { e, at: 'start' } : { e, at: 'to', seg: n - 2 - x.seg }
      if (x.at === 'arcCenter') return { e, at: 'arcCenter', seg: n - 1 - x.seg }
      return x
    }
    return { e, seg: n - 1 - x.seg }
  }
  return constraints.map((c) => {
    const next = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, flip(v)])) as SketchConstraint
    // a line turned round points the other way, so an angle to or from it turns by half a turn
    if (c.type === 'angle' && (c.a.e === e) !== (c.b.e === e)) return { ...next, value: (c.value + 180) % 360 } as SketchConstraint
    return next
  })
}

/** Where a point reference is in the sketch now, or null (an arc center is not drawn with a mark). */
function pointOf(sketch: readonly Entity[], r: SketchPointRef): V2 | null {
  const e = sketch[r.e]
  if (!e) return null
  if (e.kind === 'circle') return r.at === 'center' ? e.center : null
  if (r.at === 'start') return e.start
  if (r.at === 'to') return e.segs[r.seg]?.to ?? null
  return null
}

/** A dimension as the sketch shows it: a line from `from` to `to` with its value at the middle. */
export interface SketchDim {
  from: V2
  to: V2
  /** Where the value goes when not mid-line: the line runs on to it as a leader. */
  at?: V2
  label: string
}

const mmText = (v: number): string => `${Number(v.toFixed(2))}`

/**
 * What the sketch draws for its constraints: a dimension for each driving value (diameter across the circle,
 * radius from the center, a line's length along it, a distance between its points), a mark on each fixed point,
 * and a glyph for each constraint without a value.
 */
export function sketchMarks(sketch: readonly Entity[], constraints: readonly SketchConstraint[]): { dims: SketchDim[]; fixed: V2[]; glyphs: SketchGlyph[] } {
  const dims: SketchDim[] = []
  const fixed: V2[] = []
  // circles' dimensions go across at 45 degrees, clear of the axes
  const d = Math.SQRT1_2
  for (const c of constraints) {
    if (c.type === 'fix') {
      const p = pointOf(sketch, c.point)
      if (p) fixed.push(p)
    } else if (c.type === 'diameter' || c.type === 'radius') {
      const e = sketch[c.circle.e]
      if (e?.kind !== 'circle') continue
      const r = e.diameterMm / 2
      const rim: V2 = [e.center[0] + r * d, e.center[1] + r * d]
      // the value sits on a leader past the rim, so the center and its marks stay clear
      const out = r + Math.max(2, r * 0.4)
      const at: V2 = [e.center[0] + out * d, e.center[1] + out * d]
      if (c.type === 'diameter') dims.push({ from: [e.center[0] - r * d, e.center[1] - r * d], to: rim, at, label: `\u2300${length(c.value)}` })
      else dims.push({ from: e.center, to: rim, at, label: `R${length(c.value)}` })
    } else if (c.type === 'length') {
      const e = sketch[c.line.e]
      if (e?.kind !== 'chain' || !e.segs[c.line.seg]) continue
      dims.push({ from: segStartOf(e, c.line.seg), to: e.segs[c.line.seg]!.to, label: length(c.value) })
    } else if (c.type === 'distance' || c.type === 'horizontalDistance' || c.type === 'verticalDistance') {
      const a = pointOf(sketch, c.a)
      const b = pointOf(sketch, c.b)
      if (a && b) dims.push({ from: a, to: b, label: length(c.value) })
    }
  }
  return { dims, fixed, glyphs: glyphsOf(sketch, constraints) }
}

/** A constraint's mark beside the geometry; `slot` sets marks at one spot side by side. */
export interface SketchGlyph {
  at: V2
  kind: GlyphKind
  slot: number
}

export type GlyphKind = 'coincident' | 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'tangent' | 'equal' | 'midpoint' | 'concentric' | 'collinear' | 'symmetric'

// a point, arc centers too
function anyPointOf(sketch: readonly Entity[], r: SketchPointRef): V2 | null {
  if (r.at !== 'arcCenter') return pointOf(sketch, r)
  const e = sketch[r.e]
  const s = e?.kind === 'chain' ? e.segs[r.seg] : undefined
  return e?.kind === 'chain' && s?.kind === 'arc' ? (arcThrough(segStartOf(e, r.seg), s.through, s.to)?.center ?? null) : null
}

// the middle of a curve, where its own marks go
function middleOf(sketch: readonly Entity[], r: SketchCurveRef): V2 | null {
  const e = sketch[r.e]
  if (!e) return null
  if (e.kind === 'circle') return [e.center[0], e.center[1] + e.diameterMm / 2]
  const s = e.segs[r.seg]
  if (!s) return null
  if (s.kind === 'arc') return s.through
  const a = segStartOf(e, r.seg)
  return [(a[0] + s.to[0]) / 2, (a[1] + s.to[1]) / 2]
}

// the ends of a curve, to find where two curves meet
function endsOf(sketch: readonly Entity[], r: SketchCurveRef): V2[] {
  const e = sketch[r.e]
  if (e?.kind !== 'chain' || !e.segs[r.seg]) return []
  return [segStartOf(e, r.seg), e.segs[r.seg]!.to]
}

/** The marks for constraints without a value: a dot on a held point, a bar on a level line, a right angle at a square corner. */
export function glyphsOf(sketch: readonly Entity[], constraints: readonly SketchConstraint[]): SketchGlyph[] {
  const out: Omit<SketchGlyph, 'slot'>[] = []
  const put = (at: V2 | null, kind: GlyphKind) => at && out.push({ at, kind })
  for (const c of constraints) {
    switch (c.type) {
      case 'coincident':
        put(anyPointOf(sketch, c.a), 'coincident')
        break
      case 'onLine':
      case 'onCircle':
        put(anyPointOf(sketch, c.point), 'coincident')
        break
      case 'midpoint':
        put(anyPointOf(sketch, c.point), 'midpoint')
        break
      case 'horizontal':
      case 'vertical':
        put(middleOf(sketch, c.line), c.type)
        break
      case 'symmetric':
        put(middleOf(sketch, c.line), 'symmetric')
        break
      case 'concentric': {
        const e = sketch[c.a.e]
        put(e?.kind === 'circle' ? e.center : anyPointOf(sketch, { e: c.a.e, at: 'arcCenter', seg: c.a.seg }), 'concentric')
        break
      }
      case 'perpendicular':
      case 'tangent': {
        // at the corner the two share, else on each
        const b = endsOf(sketch, c.b)
        const shared = endsOf(sketch, c.a).find((p) => b.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6))
        if (shared) put(shared, c.type)
        else {
          put(middleOf(sketch, c.a), c.type)
          put(middleOf(sketch, c.b), c.type)
        }
        break
      }
      case 'parallel':
      case 'equal':
      case 'collinear':
        put(middleOf(sketch, c.a), c.type)
        put(middleOf(sketch, c.b), c.type)
        break
    }
  }
  const taken = new Map<string, number>()
  return out.map((g) => {
    const k = `${g.at[0].toFixed(3)},${g.at[1].toFixed(3)}`
    const slot = taken.get(k) ?? 0
    taken.set(k, slot + 1)
    return { ...g, slot }
  })
}
