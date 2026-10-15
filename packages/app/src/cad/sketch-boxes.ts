// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Dimension boxes on the shape: Width and Height on a rectangle's sides, Length and Angle on a line, Diameter on a
// circle. While a shape is drawn the boxes ride on its preview; once it is down, a picked shape shows them again with
// its sizes. A value typed in a box becomes a driving dimension, solved like any other (sketch.solve): a rectangle's
// width and height are the lengths of its first two sides, a line's angle is measured from the sketch's X axis, and a
// circle's diameter is its own. This file is the geometry and the mapping, with no React; the panel wires it up and
// the app link reads and sets the same boxes for clients.
import { settle, isDimension, measured, type DimConstraint } from './sketch-dimension'
import { X_AXIS, type SketchConstraint, type Solved } from './sketch-constraints'
import { dist, segStart, type Draft, type Entity, type Sketch, type V2 } from './sketch-model'

export type BoxKey = 'width' | 'height' | 'length' | 'angle' | 'diameter'

export interface BoxDef {
  key: BoxKey
  label: string
  unit: 'mm' | '°'
}

const DEFS: Record<BoxKey, BoxDef> = {
  width: { key: 'width', label: 'Width', unit: 'mm' },
  height: { key: 'height', label: 'Height', unit: 'mm' },
  length: { key: 'length', label: 'Length', unit: 'mm' },
  angle: { key: 'angle', label: 'Angle', unit: '°' },
  diameter: { key: 'diameter', label: 'Diameter', unit: 'mm' },
}

/** A shape the boxes sit on: a rectangle (a closed chain of four lines with square corners), one line of a chain, or a circle. */
export type BoxShape = { kind: 'rect'; e: number } | { kind: 'line'; e: number; seg: number } | { kind: 'circle'; e: number }

const KEYS: Record<BoxShape['kind'], BoxKey[]> = { rect: ['width', 'height'], line: ['length', 'angle'], circle: ['diameter'] }

/** The boxes a shape has, in Tab order. */
export const boxesOf = (kind: BoxShape['kind']): BoxDef[] => KEYS[kind].map((k) => DEFS[k])

/** The box a drawing field stands for, by its label ("Width"), or null for one that has no box on the shape. */
export function boxKeyOf(label: string): BoxKey | null {
  const k = label.toLowerCase()
  return k in DEFS ? (k as BoxKey) : null
}

const EPS = 1e-6
const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]]
const unit = (a: V2, b: V2): V2 => {
  const l = dist(a, b)
  return l < EPS ? [1, 0] : [(b[0] - a[0]) / l, (b[1] - a[1]) / l]
}
const round = (v: number): number => Math.round(v * 1e6) / 1e6
const norm360 = (deg: number): number => ((deg % 360) + 360) % 360

/** Whether loop `e` is a rectangle: closed, four straight sides, each corner square. */
export function isRect(sketch: Sketch, e: number): boolean {
  const x = sketch[e]
  if (x?.kind !== 'chain' || !x.closed || x.segs.length !== 4 || x.segs.some((s) => s.kind !== 'line')) return false
  for (let i = 0; i < 4; i++) {
    const a = unit(segStart(x, i), x.segs[i]!.to)
    const b = unit(segStart(x, (i + 1) % 4), x.segs[(i + 1) % 4]!.to)
    if (Math.abs(a[0] * b[0] + a[1] * b[1]) > 1e-6) return false
  }
  return true
}

/** The shape a pick (Select's `{e, seg}`) gives boxes to, or null for one with none (an arc, a construction curve). */
export function shapeAt(sketch: Sketch, pick: { e: number; seg: number } | null): BoxShape | null {
  if (!pick) return null
  const x = sketch[pick.e]
  if (!x || x.construction) return null
  if (x.kind === 'circle') return { kind: 'circle', e: pick.e }
  if (isRect(sketch, pick.e)) return { kind: 'rect', e: pick.e }
  return x.segs[pick.seg]?.kind === 'line' ? { kind: 'line', e: pick.e, seg: pick.seg } : null
}

/** The dimension a box sets, at `value` (mm, or degrees for an angle). */
export function constraintFor(shape: BoxShape, key: BoxKey, value: number): DimConstraint | null {
  const v = round(value)
  if (shape.kind === 'rect' && (key === 'width' || key === 'height')) return { type: 'length', line: { e: shape.e, seg: key === 'width' ? 0 : 1 }, value: v }
  if (shape.kind === 'line' && key === 'length') return { type: 'length', line: { e: shape.e, seg: shape.seg }, value: v }
  if (shape.kind === 'line' && key === 'angle') return { type: 'angle', a: X_AXIS, b: { e: shape.e, seg: shape.seg }, value: round(norm360(value)) }
  if (shape.kind === 'circle' && key === 'diameter') return { type: 'diameter', circle: { e: shape.e, seg: 0 }, value: v }
  return null
}

const sameRef = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Where the box's dimension is in the sketch's constraints, or -1. A rectangle's top or left side counts as its width or height too. */
export function boxIndex(sketch: Sketch, constraints: readonly SketchConstraint[], shape: BoxShape, key: BoxKey): number {
  const c = constraintFor(shape, key, 0)
  if (!c) return -1
  const also = shape.kind === 'rect' && isRect(sketch, shape.e) ? { type: 'length', line: { e: shape.e, seg: key === 'width' ? 2 : 3 } } : null
  return constraints.findIndex((x) => {
    if (x.type !== c.type) return false
    if (x.type === 'length' && c.type === 'length') return sameRef(x.line, c.line) || (!!also && sameRef(x.line, also.line))
    if (x.type === 'diameter' && c.type === 'diameter') return sameRef(x.circle, c.circle)
    if (x.type === 'angle' && c.type === 'angle') return sameRef(x.a, c.a) && sameRef(x.b, c.b)
    return false
  })
}

/** A box as it reads now: the value (the dimension's when it drives, else as drawn), and whether a dimension sets it. */
export interface BoxValue extends BoxDef {
  value: number
  /** 'driving' when its dimension moves the shape, 'driven' when one only reports it, null when nothing sets it. */
  set: 'driving' | 'driven' | null
  /** The dimension's index in the sketch's constraints, or -1. */
  index: number
}

/** Every box of a shape with its value now. */
export function boxValues(sketch: Sketch, constraints: readonly SketchConstraint[], shape: BoxShape): BoxValue[] {
  return boxesOf(shape.kind).map((d) => {
    const index = boxIndex(sketch, constraints, shape, d.key)
    const c = index >= 0 ? constraints[index] : undefined
    const now = constraintFor(shape, d.key, 0)
    const drawn = now ? measured(sketch, now) : null
    const kept = c && isDimension(c) && !c.driven ? c.value : null
    return { ...d, value: round(kept ?? drawn ?? 0), set: c && isDimension(c) ? (c.driven ? 'driven' : 'driving') : null, index }
  })
}

/**
 * The drawing with the box's size already put on the shape, so a solve can start beside the answer: the far side of a
 * rectangle moves, a line's end slides along it or turns about its start, a circle grows from its center. Setting an
 * angle starts from here, so the line ends on the asked direction rather than the opposite one, which meets the same
 * constraint.
 */
export function seeded(sketch: Sketch, shape: BoxShape, key: BoxKey, value: number): Entity[] {
  const out = [...sketch] as Entity[]
  const x = out[shape.e]
  if (!x) return out
  if (x.kind === 'circle') {
    if (shape.kind === 'circle' && value > 0) out[shape.e] = { ...x, diameterMm: round(value) }
    return out
  }
  const pts: V2[] = [x.start, ...x.segs.map((s) => s.to)]
  const move = (i: number, d: V2) => {
    pts[i] = [round(pts[i]![0] + d[0]), round(pts[i]![1] + d[1])]
    // a closed chain's last end is its start
    if (x.closed && i === 0) pts[pts.length - 1] = pts[0]!
    if (x.closed && i === pts.length - 1) pts[0] = pts[i]!
  }
  if (shape.kind === 'rect') {
    const side = key === 'width' ? 0 : 1
    const a = pts[side]!
    const b = pts[side + 1]!
    const u = unit(a, b)
    const d: V2 = [u[0] * (value - dist(a, b)), u[1] * (value - dist(a, b))]
    // the two corners past the side move with it, so the rectangle stays square
    for (const i of side === 0 ? [1, 2] : [2, 3]) move(i, d)
  } else if (shape.kind === 'line') {
    const a = pts[shape.seg]!
    const b = pts[shape.seg + 1]!
    const len = dist(a, b)
    const t = key === 'angle' ? (norm360(value) * Math.PI) / 180 : Math.atan2(b[1] - a[1], b[0] - a[0])
    const l = key === 'length' ? value : len
    move(shape.seg + 1, sub([a[0] + l * Math.cos(t), a[1] + l * Math.sin(t)], b))
  }
  out[shape.e] = { ...x, start: pts[0]!, segs: x.segs.map((s, i) => (s.kind === 'line' ? { ...s, to: pts[i + 1]! } : { ...s, to: pts[i + 1]! })) }
  return out
}

/** Why a typed box value can't be used, or null when it can. */
export function boxProblem(key: BoxKey, value: number): string | null {
  if (!Number.isFinite(value)) return 'Type a number.'
  if (key === 'angle') return null
  return value > 0 ? null : `The ${DEFS[key].label.toLowerCase()} must be more than 0.`
}

export interface BoxResult {
  sketch: Entity[]
  constraints: SketchConstraint[]
  solved: Solved
  /** True when the value would over-define the sketch, so its dimension only reports the size. */
  driven: boolean
}

/**
 * Sets one box: its dimension takes `value` (added, or the one there changed) and the sketch is solved to meet it. A
 * value that would over-define the sketch is kept driven, as the dimension tool keeps it. Null takes the box's
 * dimension away, so that size is free again. `expr` is the typed text when it names a value from the table.
 */
export async function setBox(sketch: Sketch, constraints: readonly SketchConstraint[], shape: BoxShape, key: BoxKey, value: number | null, o: { expr?: string; signal?: AbortSignal } = {}): Promise<BoxResult> {
  const at = boxIndex(sketch, constraints, shape, key)
  const rest = constraints.filter((_, i) => i !== at)
  if (value === null) {
    const r = await settle(sketch, rest, o.signal)
    return { ...r, driven: false }
  }
  const problem = boxProblem(key, value)
  if (problem) throw new Error(problem)
  const was = at >= 0 ? constraints[at] : undefined
  const base = constraintFor(shape, key, value)!
  // the new value goes last, so it is the one kept driven if the sketch can't take it
  const c = { ...base, ...(was && 'offset' in was && was.offset !== undefined ? { offset: was.offset } : {}), ...(o.expr ? { expr: o.expr } : {}) } as SketchConstraint
  // the solve starts from the shape already at the size, so its first corner stays put and an angle keeps its way
  // round; not when something holds the shape in place, since a held point stays where the solve finds it
  const held = rest.some((x) => x.type === 'fix' && x.point.e === shape.e)
  const r = await settle(held ? sketch : seeded(sketch, shape, key, value), [...rest, c], o.signal)
  const mine = r.constraints[r.constraints.length - 1]
  const driven = !!mine && isDimension(mine) && !!mine.driven
  if (!driven) return { ...r, driven }
  // a driven value changes nothing: the drawing stays as it was, and the dimension reads it
  const now = measured(sketch, mine)
  const read = r.constraints.map((x, i) => (i === r.constraints.length - 1 && now !== null ? ({ ...x, value: round(now) } as SketchConstraint) : x))
  return { ...r, sketch: [...sketch], constraints: read, driven }
}

/** Every shape in the sketch that has boxes: each circle and rectangle, and each straight segment of other chains. Construction curves have none. */
export function allShapes(sketch: Sketch): BoxShape[] {
  const out: BoxShape[] = []
  sketch.forEach((x, e) => {
    if (x.construction) return
    if (x.kind === 'circle') return void out.push({ kind: 'circle', e })
    if (isRect(sketch, e)) return void out.push({ kind: 'rect', e })
    x.segs.forEach((s, seg) => s.kind === 'line' && out.push({ kind: 'line', e, seg }))
  })
  return out
}

/** The sketch's boxes and dimensions as a client reads them (the app link's sketch.boxes): mm, and degrees for an angle. */
export function boxesState(sketch: Sketch, constraints: readonly SketchConstraint[], dof: number | null) {
  return {
    dof,
    shapes: allShapes(sketch).map((sh) => ({
      shape: sh.kind === 'rect' ? ('rectangle' as const) : sh.kind,
      loop: sh.e,
      ...(sh.kind === 'line' ? { seg: sh.seg } : {}),
      boxes: boxValues(sketch, constraints, sh).map((b) => ({ box: b.key, label: b.label, value: b.value, unit: b.unit === '°' ? ('deg' as const) : ('mm' as const), set: b.set })),
    })),
    dimensions: constraints.flatMap((c, index) => {
      if (!isDimension(c)) return []
      const v = c.driven ? (measured(sketch, c) ?? c.value) : c.value
      return [{ index, type: c.type, value: round(v), driven: !!c.driven, ...(c.expr ? { expr: c.expr } : {}) }]
    }),
  }
}

/** The shape a drawing step leaves for its boxes, from the sketch before and after the click: the new rectangle or circle, or the line just added. */
export function placedShape(before: Sketch, after: Sketch, tool: Draft['tool']): BoxShape | null {
  const e = after.length > before.length ? after.length - 1 : after.findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(before[i]))
  const x = after[e]
  if (!x) return null
  if (tool === 'circle' && x.kind === 'circle') return { kind: 'circle', e }
  if (tool === 'rect' && isRect(after, e)) return { kind: 'rect', e }
  if (tool === 'line' && x.kind === 'chain') {
    const seg = x.segs.length - 1
    return x.segs[seg]?.kind === 'line' ? { kind: 'line', e, seg } : null
  }
  return null
}

/**
 * The dimensions a drawn shape keeps from its typed boxes: each typed value drives its size. An angle is left out when
 * the line already holds level or upright, which says the same.
 */
export function typedConstraints(shape: BoxShape, typed: Partial<Record<BoxKey, number>>, have: readonly SketchConstraint[]): DimConstraint[] {
  const out: DimConstraint[] = []
  for (const d of boxesOf(shape.kind)) {
    const v = typed[d.key]
    if (v === undefined || !Number.isFinite(v)) continue
    if (d.key === 'angle' && shape.kind === 'line' && have.some((c) => (c.type === 'horizontal' || c.type === 'vertical') && c.line.e === shape.e && c.line.seg === shape.seg)) continue
    const c = constraintFor(shape, d.key, v)
    if (c) out.push(c)
  }
  return out
}

// ---------- where the boxes go on screen ----------

/** A shape on screen, client px: a rectangle's four corners from its start (counterclockwise in the plane), a line's ends, or a circle's center and a point on its rim. */
export type ScreenShape = { kind: 'rect'; corners: [V2, V2, V2, V2] } | { kind: 'line'; a: V2; b: V2 } | { kind: 'circle'; center: V2; rim: V2 }

export interface Area {
  left: number
  top: number
  right: number
  bottom: number
}

/** How far a box sits off the line it labels, px, past its own half size. */
export const BOX_GAP = 8
/** How close to the view's edge a box may come, px. */
export const BOX_INSET = 4

/** One box's top left, client px. */
export interface BoxSpot {
  key: BoxKey
  left: number
  top: number
}

const mid = (a: V2, b: V2): V2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]

// the center of a w by h box set off from `at` along the unit `n`, its near edge BOX_GAP away
function offBy(at: V2, n: V2, w: number, h: number): V2 {
  const half = (Math.abs(n[0]) * w + Math.abs(n[1]) * h) / 2
  return [at[0] + n[0] * (BOX_GAP + half), at[1] + n[1] * (BOX_GAP + half)]
}

// the unit square to a - b on screen, turned away from `away`; `none` for a side with no length yet
function outward(a: V2, b: V2, away: V2, none: V2): V2 {
  if (dist(a, b) < 1) return none
  const u = unit(a, b)
  let n: V2 = [-u[1], u[0]]
  const m = mid(a, b)
  if (n[0] * (away[0] - m[0]) + n[1] * (away[1] - m[1]) > 0) n = [-n[0], -n[1]]
  return n
}

/**
 * Where each box goes for a shape on screen, given each box's size: a rectangle's Width beside its first side and Height
 * beside its second, both outside it; a line's Length beside its middle and Angle past its start; a circle's Diameter
 * beside its radius line, outside the rim. Each box stays inside `area` and clear of the rectangles in `avoid` (the
 * controls floating over the view), moving the shortest way.
 */
export function placeBoxes(shape: ScreenShape, sizes: Partial<Record<BoxKey, { w: number; h: number }>>, area: Area | null, avoid: readonly Area[] = []): BoxSpot[] {
  const centers: [BoxKey, V2][] = []
  const size = (k: BoxKey) => sizes[k] ?? { w: 0, h: 0 }
  if (shape.kind === 'rect') {
    const [c0, c1, c2] = shape.corners
    const center = mid(c0, c2)
    const w = size('width')
    const h = size('height')
    // a rectangle with no size yet (a first tap on a phone) has Width below its corner and Height above it
    centers.push(['width', offBy(mid(c0, c1), outward(c0, c1, center, [0, 1]), w.w, w.h)])
    centers.push(['height', offBy(mid(c1, c2), outward(c1, c2, center, [0, -1]), h.w, h.h)])
  } else if (shape.kind === 'line') {
    const { a, b } = shape
    const u = unit(a, b)
    // above the line on screen when it can be, so the box never sits under the pointer at the line's far end
    let n: V2 = [u[1], -u[0]]
    if (n[1] > 0 || (n[1] === 0 && n[0] < 0)) n = [-n[0], -n[1]]
    const l = size('length')
    centers.push(['length', offBy(mid(a, b), n, l.w, l.h)])
    const g = size('angle')
    centers.push(['angle', offBy(a, [-u[0], -u[1]], g.w, g.h)])
  } else {
    const { center, rim } = shape
    const m = mid(center, rim)
    const u = unit(center, rim)
    let n: V2 = [u[1], -u[0]]
    if (n[1] > 0 || (n[1] === 0 && n[0] < 0)) n = [-n[0], -n[1]]
    const d = size('diameter')
    centers.push(['diameter', offBy(m, n, d.w, d.h)])
  }
  // on a small shape two boxes can meet at a corner: a later one steps aside the least way that clears the earlier
  const placed: { key: BoxKey; left: number; top: number; w: number; h: number }[] = []
  for (const [key, c] of centers) {
    const { w, h } = size(key)
    const b = { key, left: c[0] - w / 2, top: c[1] - h / 2, w, h }
    for (const o of placed) {
      const dx = Math.min(b.left + w, o.left + o.w) - Math.max(b.left, o.left)
      const dy = Math.min(b.top + h, o.top + o.h) - Math.max(b.top, o.top)
      if (dx <= 0 || dy <= 0) continue
      const right = b.left + w / 2 >= o.left + o.w / 2
      const below = b.top + h / 2 >= o.top + o.h / 2
      if (dx < dy) b.left += right ? o.left + o.w + BOX_INSET - b.left : o.left - BOX_INSET - w - b.left
      else b.top += below ? o.top + o.h + BOX_INSET - b.top : o.top - BOX_INSET - h - b.top
    }
    placed.push(b)
  }
  // then each box inside the view and clear of the floating controls and of the boxes placed before it
  const done: Area[] = []
  return placed.map(({ key, left: l0, top: t0, w, h }) => {
    const [left, top] = clearOf(l0, t0, w, h, [...avoid, ...done], area)
    done.push({ left, top, right: left + w, bottom: top + h })
    return { key, left: Math.round(left), top: Math.round(top) }
  })
}

const hits = (l: number, t: number, w: number, h: number, r: Area): boolean => l < r.right && r.left < l + w && t < r.bottom && r.top < t + h

/**
 * A w by h box wanted at (left, top), kept inside `area` and moved the shortest way off every rectangle in `avoid`
 * (the floating controls, other boxes). Where no clear spot is inside `area`, it stays where the view's edge puts it.
 */
function clearOf(left: number, top: number, w: number, h: number, avoid: readonly Area[], area: Area | null): V2 {
  const fit = (l: number, t: number): V2 => (area ? [Math.max(area.left + BOX_INSET, Math.min(l, area.right - BOX_INSET - w)), Math.max(area.top + BOX_INSET, Math.min(t, area.bottom - BOX_INSET - h))] : [l, t])
  const [l, t] = fit(left, top)
  const over = avoid.filter((a) => hits(l, t, w, h, a))
  if (!over.length) return [l, t]
  // one step past each control it touches, on each of its four sides; the shortest that is inside the view and clear of all
  const spots: V2[] = over.flatMap((r): V2[] => [[r.left - BOX_INSET - w, t], [r.right + BOX_INSET, t], [l, r.top - BOX_INSET - h], [l, r.bottom + BOX_INSET]])
  const clear = spots.filter((c) => {
    const f = fit(c[0], c[1])
    return f[0] === c[0] && f[1] === c[1] && !avoid.some((a) => hits(c[0], c[1], w, h, a))
  })
  if (!clear.length) return [l, t]
  return clear.reduce((best, c) => (Math.hypot(c[0] - l, c[1] - t) < Math.hypot(best[0] - l, best[1] - t) ? c : best))
}

/**
 * The shape a drawing step would leave with the pointer at `p`, in the plane, for its boxes to ride on: a rectangle from
 * the first corner, a line from its start, a circle about its center. Null for any other tool or step.
 */
export function draftShape(draft: Draft, p: V2): { kind: 'rect'; corners: [V2, V2, V2, V2] } | { kind: 'line'; a: V2; b: V2 } | { kind: 'circle'; center: V2; rim: V2 } | null {
  const a = draft.points[0]
  if (!a || draft.points.length !== 1) return null
  if (draft.tool === 'rect') {
    const x0 = Math.min(a[0], p[0])
    const x1 = Math.max(a[0], p[0])
    const y0 = Math.min(a[1], p[1])
    const y1 = Math.max(a[1], p[1])
    return { kind: 'rect', corners: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] }
  }
  if (draft.tool === 'line') return { kind: 'line', a, b: p }
  if (draft.tool === 'circle') return { kind: 'circle', center: a, rim: dist(a, p) > EPS ? p : [a[0] + 1, a[1]] }
  return null
}

/** The tools whose next step shows boxes on the shape. */
export const onShapeTool = (draft: Draft): boolean => draft.points.length === 1 && (draft.tool === 'rect' || draft.tool === 'line' || draft.tool === 'circle')

/** A shape kept in the sketch, in the plane, for its boxes: a circle's rim point sits at 45 degrees, clear of the axes. */
export function keptShape(sketch: Sketch, shape: BoxShape): { kind: 'rect'; corners: [V2, V2, V2, V2] } | { kind: 'line'; a: V2; b: V2 } | { kind: 'circle'; center: V2; rim: V2 } | null {
  const x = sketch[shape.e]
  if (!x) return null
  if (shape.kind === 'circle' && x.kind === 'circle') {
    const r = x.diameterMm / 2
    return { kind: 'circle', center: x.center, rim: [x.center[0] + r * Math.SQRT1_2, x.center[1] + r * Math.SQRT1_2] }
  }
  if (x.kind !== 'chain') return null
  if (shape.kind === 'rect') return { kind: 'rect', corners: [x.start, x.segs[0]!.to, x.segs[1]!.to, x.segs[2]!.to] }
  if (shape.kind === 'line') return x.segs[shape.seg] ? { kind: 'line', a: segStart(x, shape.seg), b: x.segs[shape.seg]!.to } : null
  return null
}
