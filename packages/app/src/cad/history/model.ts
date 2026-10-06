// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The CAD history of an object as data (docs/cad-history.md): the parts it started from and the
// ordered steps done to it since. A step keeps the engine request it ran, in world millimeters as
// they were when it ran, plus the object's transform at that moment; replaying it with the current
// local mesh and that transform gives the same result wherever the object has moved since. No
// React, no store and no engine calls in here, so the geometry worker can load it too.
import type { ArraySpec, ExtrudeSpec, FaceFrame, FreeShape, Hole, HoleSpec, MovedFace, OpenFace, Placement, Polygon, Shape, SketchLoop, ThreadPlace, ThreadSpec, Vec2, Vec3 } from '../../geom/cad'

export type Mat4 = number[]

/** An edge as edge.pick returns it (docs/cad-fillet.md): straight between two flat faces, or round where a flat face meets a cylinder. World at the step's transform. */
export interface EdgeRef {
  a: Vec3
  b: Vec3
  face: Vec3
  /** Set on a replay when an end moved with a face it lies on; the engine then finds the edge along its line. */
  moved?: boolean
  /** A round edge: the center of its circle; `a` is a corner of it and `b` the same. */
  center?: Vec3
}

/** A mesh in the engine's flat form, with the part's name and filament slot. */
export interface HistoryMesh {
  name: string
  slot: number
  positions: ArrayLike<number>
  indices: ArrayLike<number>
}

export type StepParams =
  | { op: 'face.push'; at: Vec3; normal: Vec3; distanceMm: number }
  | { op: 'shape.extrude'; frame?: FaceFrame; shape: Shape | FreeShape; placement?: Placement; spec: ExtrudeSpec; font?: string; name?: string }
  | { op: 'sketch.revolve'; frame?: FaceFrame; loops: SketchLoop[]; axis: { point: Vec2; direction: Vec2 }; angleDeg?: number; operation?: 'new' | 'join' | 'cut'; name?: string }
  | { op: 'subtract'; solids: SolidSpec[]; label: string }
  | { op: 'hollow'; wallMm: number }
  | { op: 'repair' }
  | { op: 'simplify'; targetRatio: number }
  | { op: 'array.merged'; spec: ArraySpec }
  | { op: 'parts.add'; parts: HistoryMesh[]; label: string }
  | { op: 'edge.fillet'; edges: EdgeRef[]; radiusMm: number; toleranceMm?: number }
  | { op: 'edge.chamfer'; edges: EdgeRef[]; distanceMm: number; distance2Mm?: number }
  | { op: 'hole.apply'; hole: Hole; spec: HoleSpec; label: string }
  | { op: 'thread.apply'; thread: ThreadPlace; spec: ThreadSpec; label: string }
  | { op: 'shell'; open: OpenFace[]; wallMm: number }

export type StepOp = StepParams['op']

export type SolidSpec =
  | { type: 'cylinder'; origin: Vec3; axis: Vec3; diameterMm: number; heightMm: number }
  | { type: 'box'; min: Vec3; max: Vec3 }

/**
 * References that sat on the end face of an earlier push or extrude, which was then `distanceMm` long.
 * `points` are the indices of those references (an edge has two, `a` then `b`); every one when absent.
 */
export interface Follow {
  step: string
  distanceMm: number
  points?: number[]
}

export interface Step {
  id: string
  /** The part index the step works on, or -1 for every part. */
  part: number
  /** The object's transform when the step ran: the frame of the world values in `params`. */
  transform: Mat4
  params: StepParams
  /** The end faces the references sat on; an edge step can sit on several, such as the top and the front. */
  follow?: Follow | Follow[]
  suppressed?: boolean
  /** The plain sentence from the last replay when the step failed there. */
  broken?: string
  /** The expression over named values the step's main number follows (`height + 2`); see cad/values.ts. */
  bind?: string
}

export interface History {
  version: 1
  /** The parts before the first step. Empty for a body a step made. */
  base: HistoryMesh[]
  steps: Step[]
  /** Why an earlier history ended, shown above the list: "History ends here: ..." */
  ended?: string
}

export type StepState = 'done' | 'broken' | 'skipped' | 'suppressed'

export interface StepStatus {
  state: StepState
  message?: string
}

export interface ReplayResult {
  parts: HistoryMesh[]
  status: StepStatus[]
  /** The face each push step moved on this replay, by step id (world at that step's transform). */
  moved: Record<string, MovedFace>
}

export const HISTORY_VERSION = 1

let seq = 0
export const stepId = (): string => `s${Date.now().toString(36)}${(++seq).toString(36)}`

// Small matrix and vector helpers (column-major, like three.js).

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

export function point(m: Mat4, p: ArrayLike<number>, i = 0): Vec3 {
  const x = p[i] ?? 0
  const y = p[i + 1] ?? 0
  const z = p[i + 2] ?? 0
  return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!]
}

export function direction(m: Mat4, d: Vec3): Vec3 {
  return [m[0]! * d[0] + m[4]! * d[1] + m[8]! * d[2], m[1]! * d[0] + m[5]! * d[1] + m[9]! * d[2], m[2]! * d[0] + m[6]! * d[1] + m[10]! * d[2]]
}

export function invert(m: Mat4): Mat4 {
  const a = (r: number, c: number) => m[c * 4 + r] ?? 0
  const det = a(0, 0) * (a(1, 1) * a(2, 2) - a(1, 2) * a(2, 1)) - a(0, 1) * (a(1, 0) * a(2, 2) - a(1, 2) * a(2, 0)) + a(0, 2) * (a(1, 0) * a(2, 1) - a(1, 1) * a(2, 0))
  if (Math.abs(det) < 1e-12) return [...IDENTITY]
  const out = [...IDENTITY]
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      const rows = [0, 1, 2].filter((x) => x !== c)
      const cols = [0, 1, 2].filter((x) => x !== r)
      const minor = a(rows[0]!, cols[0]!) * a(rows[1]!, cols[1]!) - a(rows[0]!, cols[1]!) * a(rows[1]!, cols[0]!)
      out[c * 4 + r] = (((r + c) % 2 === 0 ? 1 : -1) * minor) / det
    }
  for (let r = 0; r < 3; r++) out[12 + r] = -(out[r]! * (m[12] ?? 0) + out[4 + r]! * (m[13] ?? 0) + out[8 + r]! * (m[14] ?? 0))
  return out
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let v = 0
      for (let k = 0; k < 4; k++) v += a[k * 4 + r]! * b[c * 4 + k]!
      out[c * 4 + r] = v
    }
  return out
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/** Positions baked through a transform; a mirroring transform also turns the triangles back. */
export function bakeMesh(m: HistoryMesh, t: Mat4): HistoryMesh {
  const positions = new Array<number>(m.positions.length)
  for (let i = 0; i + 2 < m.positions.length; i += 3) {
    const w = point(t, m.positions, i)
    positions[i] = w[0]
    positions[i + 1] = w[1]
    positions[i + 2] = w[2]
  }
  const det = t[0]! * (t[5]! * t[10]! - t[9]! * t[6]!) - t[4]! * (t[1]! * t[10]! - t[9]! * t[2]!) + t[8]! * (t[1]! * t[6]! - t[5]! * t[2]!)
  let indices = Array.from(m.indices)
  if (det < 0) {
    indices = indices.slice()
    for (let k = 0; k + 2 < indices.length; k += 3) [indices[k + 1], indices[k + 2]] = [indices[k + 2]!, indices[k + 1]!]
  }
  return { name: m.name, slot: m.slot, positions, indices }
}

/**
 * The triangle of a mesh (local, shown through `t`) that holds the world point `at` on a face facing
 * `normal`: on its plane within 0.01 mm, normal within 0.01 degrees, inside it within 0.01 mm. The
 * face a step picked, found again on a mesh an earlier step changed. -1 when it is gone.
 */
export function findTriangle(mesh: Pick<HistoryMesh, 'positions' | 'indices'>, t: Mat4, at: Vec3, normal: Vec3): number {
  const n = unit(normal)
  const cosTol = Math.cos((0.01 * Math.PI) / 180)
  const p = mesh.positions
  const ix = mesh.indices
  let best = -1
  let bestOut = 0.01
  for (let k = 0; k + 2 < ix.length; k += 3) {
    const a = point(t, p, 3 * ix[k]!)
    const b = point(t, p, 3 * ix[k + 1]!)
    const c = point(t, p, 3 * ix[k + 2]!)
    const e1: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const e2: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const cr: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
    const area2 = Math.hypot(cr[0], cr[1], cr[2])
    if (area2 < 1e-12) continue
    const tn: Vec3 = [cr[0] / area2, cr[1] / area2, cr[2] / area2]
    if (dot(tn, n) < cosTol) continue
    const d: Vec3 = [at[0] - a[0], at[1] - a[1], at[2] - a[2]]
    if (Math.abs(dot(d, tn)) > 0.01) continue
    // How far outside the triangle the point lies, along the plane (0 inside).
    let out = 0
    for (const [p0, p1] of [[a, b], [b, c], [c, a]] as [Vec3, Vec3][]) {
      const e: Vec3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]
      const inward = unit([tn[1] * e[2] - tn[2] * e[1], tn[2] * e[0] - tn[0] * e[2], tn[0] * e[1] - tn[1] * e[0]])
      const s = dot([at[0] - p0[0], at[1] - p0[1], at[2] - p0[2]], inward)
      if (-s > out) out = -s
    }
    if (out === 0) return k / 3
    if (out <= bestOut) {
      bestOut = out
      best = k / 3
    }
  }
  return best
}

/** Whether any face of a mesh (local, shown through `t`) lies on the plane through `at` facing `normal`, within 0.01 mm and 0.01 degrees. */
export function hasFaceOn(mesh: Pick<HistoryMesh, 'positions' | 'indices'>, t: Mat4, at: Vec3, normal: Vec3): boolean {
  const n = unit(normal)
  const cosTol = Math.cos((0.01 * Math.PI) / 180)
  const p = mesh.positions
  const ix = mesh.indices
  for (let k = 0; k + 2 < ix.length; k += 3) {
    const a = point(t, p, 3 * ix[k]!)
    const b = point(t, p, 3 * ix[k + 1]!)
    const c = point(t, p, 3 * ix[k + 2]!)
    const cr: Vec3 = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])]
    const area2 = Math.hypot(cr[0], cr[1], cr[2])
    if (area2 < 1e-12 || dot(cr, n) / area2 < cosTol) continue
    if (Math.abs(dot([at[0] - a[0], at[1] - a[1], at[2] - a[2]], n)) <= 0.01) return true
  }
  return false
}

/**
 * The end face a step leaves, in the part's local frame: the moved face of a push, the far cap of a
 * one-sided extrude. Later steps that were placed on it follow it when this step's distance changes.
 */
export function capOf(s: Step): { point: Vec3; normal: Vec3; distanceMm: number; sign: number } | null {
  const inv = invert(s.transform)
  const p = s.params
  if (p.op === 'face.push') {
    const n = unit(p.normal)
    return { point: point(inv, [p.at[0] + n[0] * p.distanceMm, p.at[1] + n[1] * p.distanceMm, p.at[2] + n[2] * p.distanceMm]), normal: unit(direction(inv, n)), distanceMm: p.distanceMm, sign: 1 }
  }
  if (p.op === 'shape.extrude' && p.frame && (p.spec.extent ?? 'oneSide') === 'oneSide') {
    const sign = (p.spec.operation === 'cut') !== Boolean(p.spec.flip) ? -1 : 1
    const n = unit(p.frame.normal)
    const d = sign * p.spec.distanceMm
    return { point: point(inv, [p.frame.origin[0] + n[0] * d, p.frame.origin[1] + n[1] * d, p.frame.origin[2] + n[2] * d]), normal: unit(direction(inv, n)), distanceMm: p.spec.distanceMm, sign }
  }
  return null
}

/** The points a step refers to, world at its transform, for following an earlier cap. Two per edge, `a` then `b`. */
export function refPoints(p: StepParams): Vec3[] {
  if (p.op === 'face.push') return [p.at]
  if ((p.op === 'shape.extrude' || p.op === 'sketch.revolve') && p.frame) return [p.frame.origin]
  if (p.op === 'edge.fillet' || p.op === 'edge.chamfer') return p.edges.flatMap((e) => [e.a, e.b])
  return []
}

/** The faces a step follows, as a list. */
export const followsOf = (s: Pick<Step, 'follow'>): Follow[] => (s.follow === undefined ? [] : Array.isArray(s.follow) ? s.follow : [s.follow])

/** The follow field of a step for a list of follows: none, the one, or the list. */
export function followField(list: readonly Follow[]): Pick<Step, 'follow'> {
  return list.length === 0 ? {} : { follow: list.length === 1 ? list[0]! : [...list] }
}

const parallel = (a: Vec3, b: Vec3) => Math.abs(dot(a, b)) > 0.999

/**
 * Which end faces of earlier steps on the same part a new step's references lie on, so replays move
 * them when those steps change. A push or a sketch follows the latest one its reference lies on. An
 * edge follows every one an end lies on (the top and the front of a block, say), one per direction:
 * an end that lies on the cap of a later step of the same direction follows that one alone.
 */
export function followFor(steps: readonly Step[], s: Step): Step['follow'] | undefined {
  const pts = refPoints(s.params)
  if (!pts.length) return undefined
  const inv = invert(s.transform)
  const local = pts.map((q) => point(inv, q))
  const edges = s.params.op === 'edge.fillet' || s.params.op === 'edge.chamfer'
  const taken: Vec3[][] = pts.map(() => [])
  const out: Follow[] = []
  for (let i = steps.length - 1; i >= 0; i--) {
    const prev = steps[i]!
    if (prev.suppressed || (prev.part !== s.part && prev.part !== -1 && s.part !== -1)) continue
    const cap = capOf(followed(prev, steps))
    if (!cap) continue
    const on = local.flatMap((q, k) => (Math.abs(dot([q[0] - cap.point[0], q[1] - cap.point[1], q[2] - cap.point[2]], cap.normal)) < 0.01 && !taken[k]!.some((n) => parallel(n, cap.normal)) ? [k] : []))
    if (!edges) {
      if (on.length === pts.length) return { step: prev.id, distanceMm: cap.distanceMm }
      continue
    }
    if (!on.length) continue
    for (const k of on) taken[k]!.push(cap.normal)
    out.push(on.length === pts.length ? { step: prev.id, distanceMm: cap.distanceMm } : { step: prev.id, distanceMm: cap.distanceMm, points: on })
  }
  return followField(out).follow
}

/** How far one followed face has moved in the part's frame: its step's own move plus the change of its distance, and its normal. */
function leadShift(f: Follow, steps: readonly Step[], depth: number): { v: Vec3; normal: Vec3 } | null {
  const lead = steps.find((x) => x.id === f.step)
  const cap = lead && !lead.suppressed ? capOf(lead) : null
  if (!lead || !cap) return null
  const base = shiftOf(lead, 0, steps, depth + 1)
  const delta = cap.sign * (cap.distanceMm - f.distanceMm)
  return { v: [base[0] + cap.normal[0] * delta, base[1] + cap.normal[1] * delta, base[2] + cap.normal[2] * delta], normal: cap.normal }
}

/** How far reference `k` of a step has moved in the part's frame, through every face it follows. */
function shiftOf(s: Step, k: number, steps: readonly Step[], depth: number): Vec3 {
  const out: Vec3 = [0, 0, 0]
  if (depth > 50) return out
  for (const f of followsOf(s)) {
    if (f.points && !f.points.includes(k)) continue
    const m = leadShift(f, steps, depth)
    if (!m) continue
    out[0] += m.v[0]
    out[1] += m.v[1]
    out[2] += m.v[2]
  }
  return out
}

/**
 * The step with its references moved along the caps it follows, by how much their distances changed.
 * An edge with both ends on a moved face moves with it; an edge with one end there (it runs into the
 * face) keeps its line and that end slides along it, so a push in shortens it and a pull lengthens it.
 */
export function followed(s: Step, steps: readonly Step[]): Step {
  if (!s.follow) return s
  const p = s.params
  const mv = (q: Vec3, v: Vec3): Vec3 => [q[0] + v[0], q[1] + v[1], q[2] + v[2]]
  if (p.op === 'edge.fillet' || p.op === 'edge.chamfer') {
    const inv = invert(s.transform)
    let any = false
    const edges = p.edges.map((e, i) => {
      const sa: Vec3 = [0, 0, 0]
      const sb: Vec3 = [0, 0, 0]
      for (const f of followsOf(s)) {
        const onA = !f.points || f.points.includes(2 * i)
        const onB = !f.points || f.points.includes(2 * i + 1)
        const m = onA || onB ? leadShift(f, steps, 0) : null
        if (!m) continue
        let va = m.v
        let vb = m.v
        if (onA !== onB) {
          // the end on the face slides along the edge to the face's new place
          const from = point(inv, onA ? e.b : e.a)
          const to = point(inv, onA ? e.a : e.b)
          const along = unit([to[0] - from[0], to[1] - from[1], to[2] - from[2]])
          const k = dot(along, m.normal)
          const t = dot(m.v, m.normal) / k
          const v: Vec3 = Math.abs(k) > 0.05 ? [along[0] * t, along[1] * t, along[2] * t] : m.v
          va = onA ? v : [0, 0, 0]
          vb = onB ? v : [0, 0, 0]
        }
        sa[0] += va[0]
        sa[1] += va[1]
        sa[2] += va[2]
        sb[0] += vb[0]
        sb[1] += vb[1]
        sb[2] += vb[2]
      }
      const da = Math.hypot(sa[0], sa[1], sa[2]) >= 1e-9
      const db = Math.hypot(sb[0], sb[1], sb[2]) >= 1e-9
      if (!da && !db) return e
      any = true
      const a = da ? mv(e.a, direction(s.transform, sa)) : e.a
      const b = db ? mv(e.b, direction(s.transform, sb)) : e.b
      // A round edge's circle moves with its corner.
      const center = e.center && da ? { center: mv(e.center, direction(s.transform, sa)) } : {}
      return { ...e, a, b, ...center, moved: true }
    })
    return any ? { ...s, params: { ...p, edges } } : s
  }
  const shift = shiftOf(s, 0, steps, 0)
  if (Math.hypot(shift[0], shift[1], shift[2]) < 1e-9) return s
  // The move, from the part's frame into this step's world.
  const v = direction(s.transform, shift)
  let params: StepParams = p
  if (p.op === 'face.push') params = { ...p, at: mv(p.at, v) }
  else if ((p.op === 'shape.extrude' || p.op === 'sketch.revolve') && p.frame) params = { ...p, frame: { ...p.frame, origin: mv(p.frame.origin, v) } }
  return { ...s, params }
}

/** A flat face as face.pick gives it: the frame and the outline in frame coordinates (world). */
export interface FlatFace {
  frame: FaceFrame
  outline: Polygon[]
}

function inRing(q: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!
    const b = ring[j]!
    if (a[1] > q[1] !== b[1] > q[1] && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}

function toRing(q: Vec2, ring: readonly Vec2[]): number {
  let best = Infinity
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!
    const b = ring[i]!
    const e: Vec2 = [b[0] - a[0], b[1] - a[1]]
    const l2 = e[0] * e[0] + e[1] * e[1]
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * e[0] + (q[1] - a[1]) * e[1]) / l2)) : 0
    best = Math.min(best, Math.hypot(q[0] - a[0] - e[0] * t, q[1] - a[1] - e[1] * t))
  }
  return best
}

/** Where a world point lies against a flat face: on its plane, and inside its outline or on its rim, within `tol` mm. */
export function onFlatFace(p: Vec3, face: FlatFace, tol = 0.01): { inside: boolean; rim: boolean } {
  const f = face.frame
  const d: Vec3 = [p[0] - f.origin[0], p[1] - f.origin[1], p[2] - f.origin[2]]
  if (Math.abs(dot(d, f.normal)) > tol) return { inside: false, rim: false }
  const q: Vec2 = [dot(d, f.u), dot(d, f.v)]
  const rings = face.outline.flatMap((poly) => [poly.outer, ...poly.holes])
  const rim = rings.some((r) => toRing(q, r) < tol)
  const inside = rim || face.outline.some((poly) => inRing(q, poly.outer) && !poly.holes.some((h) => inRing(q, h)))
  return { inside, rim }
}

const n2 = (v: number) => String(Math.round(v * 100) / 100)

const SHAPE_WORDS: Record<string, string> = { rectangle: 'Rectangle', circle: 'Circle', slot: 'Slot', polygon: 'Polygon', text: 'Text', svg: 'SVG outline', sketch: 'Sketch' }

/** A step in a few plain words, such as "Pull 5 mm", "Hole 6 mm" or "Sketch extrude 12 mm". */
export function stepName(s: Pick<Step, 'params'>): string {
  const p = s.params
  switch (p.op) {
    case 'face.push':
      return p.distanceMm >= 0 ? `Pull ${n2(p.distanceMm)} mm` : `Push ${n2(-p.distanceMm)} mm`
    case 'shape.extrude': {
      const op = p.spec.operation ?? 'new'
      const d = `${n2(p.spec.distanceMm)} mm`
      if (p.shape.type === 'circle' && op === 'cut') return `Hole ${n2(p.shape.diameterMm)} mm`
      if (p.shape.type === 'sketch') return op === 'cut' ? `Sketch cut ${d}` : `Sketch extrude ${d}`
      if (p.shape.type === 'text') return `Text "${p.shape.text.length > 16 ? `${p.shape.text.slice(0, 15)}...` : p.shape.text}" ${op === 'cut' ? 'cut' : 'raised'} ${d}`
      return `${SHAPE_WORDS[p.shape.type] ?? 'Shape'} ${op === 'cut' ? 'cut' : 'extrude'} ${d}`
    }
    case 'sketch.revolve':
      return `Sketch revolve ${n2(p.angleDeg ?? 360)}°`
    case 'subtract':
      return p.label
    case 'hollow':
      return `Hollow, ${n2(p.wallMm)} mm walls`
    case 'shell':
      return `Shell, ${n2(p.wallMm)} mm walls${p.open.length ? `, ${p.open.length} open face${p.open.length === 1 ? '' : 's'}` : ''}`
    case 'repair':
      return 'Repair'
    case 'simplify':
      return `Simplify to ${Math.round(p.targetRatio * 100)} %`
    case 'array.merged':
      return `Array of ${p.spec.kind === 'linear' ? p.spec.count * (p.spec.count2 ?? 1) : p.spec.count}, merged`
    case 'parts.add':
      return p.label
    case 'edge.fillet':
      return `Fillet ${n2(p.radiusMm)} mm${p.edges.length > 1 ? `, ${p.edges.length} edges` : ''}`
    case 'edge.chamfer':
      return `Chamfer ${n2(p.distanceMm)} mm${p.edges.length > 1 ? `, ${p.edges.length} edges` : ''}`
    case 'hole.apply':
    case 'thread.apply':
      return p.label
  }
}

/** The one number a step is mostly about, for editing it in place in the list. Null when it has none. */
export function mainNumber(p: StepParams): { label: string; value: number; unit: string; min?: number; max?: number } | null {
  switch (p.op) {
    case 'face.push':
      return { label: 'Distance', value: p.distanceMm, unit: 'mm' }
    case 'shape.extrude':
      return { label: p.spec.operation === 'cut' ? 'Depth' : 'Distance', value: p.spec.distanceMm, unit: 'mm', min: 0 }
    case 'sketch.revolve':
      return { label: 'Angle', value: p.angleDeg ?? 360, unit: '°', min: 0, max: 360 }
    case 'hollow':
      return { label: 'Wall', value: p.wallMm, unit: 'mm', min: 0 }
    case 'simplify':
      return { label: 'Keep', value: Math.round(p.targetRatio * 100), unit: '%', min: 1, max: 100 }
    case 'edge.fillet':
      return { label: 'Radius', value: p.radiusMm, unit: 'mm', min: 0 }
    case 'edge.chamfer':
      return { label: 'Distance', value: p.distanceMm, unit: 'mm', min: 0 }
    case 'hole.apply':
      return { label: 'Diameter', value: p.spec.diameterMm, unit: 'mm', min: 0 }
    case 'thread.apply':
      return { label: 'Length', value: p.spec.lengthMm ?? p.thread.lengthMm, unit: 'mm', min: 0 }
    case 'shell':
      return { label: 'Wall', value: p.wallMm, unit: 'mm', min: 0 }
    case 'subtract': {
      const s = p.solids.length === 1 ? p.solids[0]! : null
      if (s?.type === 'cylinder') return { label: 'Diameter', value: s.diameterMm, unit: 'mm', min: 0 }
      if (s?.type === 'box') return { label: 'Width', value: Math.round((s.max[0] - s.min[0]) * 1000) / 1000, unit: 'mm', min: 0 }
      return null
    }
    default:
      return null
  }
}

/** The params with the main number set; a sentence when the number does not fit. */
export function withNumber(p: StepParams, v: number): StepParams | string {
  if (!Number.isFinite(v)) return 'Type a number.'
  switch (p.op) {
    case 'face.push':
      return v === 0 || Math.abs(v) > 10000 ? 'The distance is not 0 and at most 10000 mm.' : { ...p, distanceMm: v }
    case 'shape.extrude':
      return v > 0 ? { ...p, spec: { ...p.spec, distanceMm: v } } : 'The distance must be more than 0 mm.'
    case 'sketch.revolve':
      return v > 0 && v <= 360 ? { ...p, angleDeg: v } : 'The angle is more than 0 and at most 360 degrees.'
    case 'hollow':
      return v > 0 ? { ...p, wallMm: v } : 'The wall must be more than 0 mm.'
    case 'simplify':
      return v >= 1 && v <= 100 ? { ...p, targetRatio: v / 100 } : 'Keep 1 to 100 % of the triangles.'
    case 'edge.fillet':
      return v > 0 ? { ...p, radiusMm: v } : 'The radius must be more than 0 mm.'
    case 'edge.chamfer':
      return v > 0 ? { ...p, distanceMm: v, ...(p.distance2Mm !== undefined ? { distance2Mm: p.distance2Mm } : {}) } : 'The distance must be more than 0 mm.'
    case 'hole.apply':
      return v > 0 ? { ...p, spec: { ...p.spec, diameterMm: v }, label: `Hole ${n2(v)} mm` } : 'The diameter must be more than 0 mm.'
    case 'thread.apply':
      return v > 0 ? { ...p, spec: { ...p.spec, lengthMm: v } } : 'The length must be more than 0 mm.'
    case 'shell':
      return v > 0 ? { ...p, wallMm: v } : 'The wall must be more than 0 mm.'
    case 'subtract': {
      const s = p.solids.length === 1 ? p.solids[0]! : null
      if (!(v > 0) || !s) return 'The size must be more than 0 mm.'
      if (s.type === 'cylinder') return { ...p, solids: [{ ...s, diameterMm: v }], label: `Hole ${n2(v)} mm` }
      // A box keeps its center and depth; width and length both take the new size, as the tool makes it.
      const c: Vec2 = [(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2]
      return { ...p, solids: [{ ...s, min: [c[0] - v / 2, c[1] - v / 2, s.min[2]], max: [c[0] + v / 2, c[1] + v / 2, s.max[2]] }] }
    }
    default:
      return 'This step has no number to change.'
  }
}
