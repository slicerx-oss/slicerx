// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A design's own frame, beside the plate's. A landing (landing.ts) moves a design as a whole: the object moves on the
// plate, and the history keeps the move (History.placed), so the frame the design tools give and read points in, the
// object's transform moved back by that move, stays where the design was built. What is stored stays in plate
// coordinates: a recorded step keeps the object's transform when it ran and world values at it, and a timeline sketch
// keeps the frame of the step that owns it (the first feature drawn on it), or the plate's when no feature uses it.
// The conversion happens only where a design tool meets the host: a step is moved into plate coordinates before it is
// recorded, and a sketch is moved into the design's frame when a tool reads it. Every offset comes from what the
// store holds (the history, the timeline and the objects' transforms), so any number of hosts read the same.
import type { SketchItem, Timeline } from './design'
import { direction, IDENTITY, invert, multiply, point, type History, type Mat4, type PaintTarget, type SolidSpec, type StepParams } from './model'
import type { ArraySpec, EdgeRef, FaceFrame, Vec3 } from './types'

/** The bed as a plane: what a step or sketch with no frame is drawn on. */
export const BED_FRAME: FaceFrame = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }

/** A move by `v`, mm. */
export const translation = (v: readonly [number, number, number]): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v[0], v[1], v[2], 1]

/** `t` moved on the plate by `by` (mm in X and Y), or back by it with `back`. */
export function movedBy(t: Mat4, by: readonly [number, number] | undefined, back = false): Mat4 {
  const m = [...t]
  if (!by) return m
  const s = back ? -1 : 1
  m[12] = (m[12] ?? 0) + s * by[0]
  m[13] = (m[13] ?? 0) + s * by[1]
  return m
}

/** The frame design tools work in for an object standing at `plate` with history `h`: the plate less its landing moves. */
export function designFrame(plate: Mat4, h: Pick<History, 'placed'> | undefined): Mat4 {
  return movedBy(plate, h?.placed, true)
}

/** The landing moves after one more, from `from` to `to` (both on the plate); none when they come to nothing. */
export function placedAfter(placed: readonly [number, number] | undefined, from: Mat4, to: Mat4): [number, number] | undefined {
  const x = (placed?.[0] ?? 0) + (to[12] ?? 0) - (from[12] ?? 0)
  const y = (placed?.[1] ?? 0) + (to[13] ?? 0) - (from[13] ?? 0)
  // float noise from adding and taking back the same move is no move
  const clean = (v: number) => (Math.abs(v) < 1e-9 ? 0 : Math.round(v * 1e9) / 1e9)
  return clean(x) === 0 && clean(y) === 0 ? undefined : [clean(x), clean(y)]
}

/** `h` with `placed` as its landing moves (none drops them). */
export function withPlaced(h: History, placed: readonly [number, number] | undefined): History {
  const { placed: _p, ...rest } = h
  return placed && (placed[0] !== 0 || placed[1] !== 0) ? { ...rest, placed: [placed[0], placed[1]] } : rest
}

const isIdentity = (m: Mat4) => m.every((v, i) => Math.abs(v - IDENTITY[i]!) < 1e-12)

/** A plane moved by `m`. */
export function movedFrame(f: FaceFrame | undefined, m: Mat4): FaceFrame {
  const g = f ?? BED_FRAME
  return { origin: point(m, g.origin), normal: direction(m, g.normal), u: direction(m, g.u), v: direction(m, g.v) }
}

/** A frame or none, moved by `m`: none stays none when `m` moves nothing, so a sketch on the bed stays on the bed. */
const frameOrNone = (f: FaceFrame | undefined, m: Mat4): { frame?: FaceFrame } => (f === undefined && isIdentity(m) ? {} : { frame: movedFrame(f, m) })

function movedEdge(e: EdgeRef, m: Mat4): EdgeRef {
  return { ...e, a: point(m, e.a), b: point(m, e.b), face: direction(m, e.face), ...(e.center ? { center: point(m, e.center) } : {}) }
}

function movedSolid(s: SolidSpec, m: Mat4): SolidSpec {
  if (s.type === 'cylinder') return { ...s, origin: point(m, s.origin), axis: direction(m, s.axis) }
  // a box keeps its sides along the axes: exact for a move, and for quarter turns about Z
  const a = point(m, s.min)
  const b = point(m, s.max)
  return { ...s, min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])], max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])] }
}

function movedArray(a: ArraySpec, m: Mat4): ArraySpec {
  if (a.kind === 'linear') return { ...a, step: direction(m, a.step), ...(a.step2 ? { step2: direction(m, a.step2) } : {}) }
  return { ...a, center: point(m, a.center), ...(a.axis ? { axis: direction(m, a.axis) } : {}) }
}

function movedTarget(t: PaintTarget, m: Mat4): PaintTarget {
  const dz = m[14] ?? 0
  switch (t.kind) {
    case 'seed':
      return { ...t, point: point(m, t.point) }
    case 'direction': {
      const dir = Array.isArray(t.direction) ? { direction: direction(m, t.direction as Vec3) } : {}
      const pick = t.pick && typeof t.pick === 'object' ? { pick: { nearest: point(m, t.pick.nearest) } } : {}
      return { ...t, ...dir, ...pick }
    }
    case 'height': {
      // heights above the bed: only a move up or down changes them
      const out: Extract<PaintTarget, { kind: 'height' }> = { kind: 'height' }
      for (const k of ['below', 'above', 'from', 'to'] as const) {
        const v = t[k]
        if (v !== undefined) out[k] = v + dz
      }
      return out
    }
    default:
      return t
  }
}

/**
 * A step's params as world values after the move `m`: every point and direction it holds moved, its sizes, face keys,
 * sketch loops (in their plane) and patterns (on their face) as they are. Recorded at a transform moved by `m` too,
 * the step replays to the same body. Exact for a move; a box of subtract keeps its sides along the axes, and heights of
 * a paint band follow a move up or down only, so for those `m` must be a move.
 */
export function movedParams(p: StepParams, m: Mat4): StepParams {
  if (isIdentity(m)) return p
  switch (p.op) {
    case 'face.push':
      return { ...p, at: point(m, p.at), normal: direction(m, p.normal) }
    case 'shape.extrude': {
      const { frame, ...rest } = p
      return { ...rest, ...frameOrNone(frame, m) }
    }
    case 'sketch.revolve': {
      const { frame, ...rest } = p
      return { ...rest, ...frameOrNone(frame, m) }
    }
    case 'sketch.loft':
      return { ...p, profiles: p.profiles.map(({ frame, ...rest }) => ({ ...rest, ...frameOrNone(frame, m) })) }
    case 'sketch.sweep': {
      const { frame: pf, ...profile } = p.profile
      const { frame: qf, ...path } = p.path
      const movedPath = path.points ? { ...path, points: path.points.map((q) => point(m, q)), ...(qf ? { frame: movedFrame(qf, m) } : {}) } : { ...path, ...frameOrNone(qf, m) }
      return { ...p, profile: { ...profile, ...frameOrNone(pf, m) }, path: movedPath }
    }
    case 'subtract':
      return { ...p, solids: p.solids.map((s) => movedSolid(s, m)) }
    case 'array.merged':
      return { ...p, spec: movedArray(p.spec, m) }
    case 'edge.fillet':
    case 'edge.chamfer':
      return { ...p, edges: p.edges.map((e) => movedEdge(e, m)) }
    case 'hole.apply':
      return { ...p, hole: { ...p.hole, entry: point(m, p.hole.entry), axis: direction(m, p.hole.axis) } }
    case 'thread.apply':
      return { ...p, thread: { ...p.thread, start: point(m, p.thread.start), axis: direction(m, p.thread.axis) } }
    case 'shell':
      return { ...p, open: p.open.map((o) => ({ ...o, at: point(m, o.at), normal: direction(m, o.normal) })) }
    case 'plane.cut':
    case 'mirror':
      return { ...p, plane: { point: point(m, p.plane.point), normal: direction(m, p.plane.normal) } }
    case 'paint':
      return { ...p, target: movedTarget(p.target, m) }
    // parts.add keeps its parts in the object's own frame; the rest hold no place
    default:
      return p
  }
}

/** A finished sketch as it reads after the move `m`: its plane moved, its loops (in the plane) as they are. */
export function movedSketch(k: SketchItem, m: Mat4): SketchItem {
  if (isIdentity(m)) return k
  const { frame, ...rest } = k
  return { ...rest, frame: movedFrame(frame, m) }
}

/**
 * The feature that owns a timeline sketch: the first one drawn on it. Its frame is in plate coordinates at that
 * feature's transform. Undefined when no feature uses the sketch, whose frame is then the plate's as it stands.
 */
export function sketchOwner(t: Timeline, id: string): { body: string; transform: Mat4 } | undefined {
  const f = t.items.find((i) => i.kind === 'feature' && i.sketch === id)
  return f?.kind === 'feature' ? { body: f.body, transform: f.transform } : undefined
}

/**
 * How far sketch `id` has moved on the plate since its frame was stored: the move of the body that owns it since its
 * owning feature ran (a landing, a person's move), or none for a sketch no feature uses. `plateOf` gives a body's
 * transform as it stands, undefined when the body is not there.
 */
export function sketchMove(t: Timeline, id: string, plateOf: (body: string) => Mat4 | undefined): Mat4 {
  const owner = sketchOwner(t, id)
  if (!owner) return [...IDENTITY]
  const now = plateOf(owner.body)
  return now ? multiply(now, invert(owner.transform)) : [...IDENTITY]
}

/**
 * The move that takes a sketch as stored into the frame of a design with landing moves `placed`: the sketch's own move
 * since it was stored (sketchMove), then back by the design's landing. A read applies it; a step drawn on the sketch is
 * recorded through its inverse, so the sketch keeps the frame it has.
 */
export function storedToDesign(move: Mat4, placed: readonly [number, number] | undefined): Mat4 {
  return multiply(translation([-(placed?.[0] ?? 0), -(placed?.[1] ?? 0), 0]), move)
}
