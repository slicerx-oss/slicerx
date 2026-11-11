// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.edit_step's move and size: a follow-up changes what a step made by editing the step, so the steps after it,
// patterns of it among them, replay with the change. move shifts what the step made; size sets its length along one
// axis, from its low end: an extrude's distance or its outline, a revolve along or across its axis, a loft along its
// run or across its sections. Outlines are scaled along one direction, so they must be straight lines and points.
import { BED_FRAME, direction, invert, movedParams, type FaceFrame, type Mat4, type SketchLoop, type Step, type StepParams, type Vec2, type Vec3 } from '@slicerx/cad-history'

export type Axis = 'x' | 'y' | 'z'
const AXIS: Record<Axis, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }
const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6

/** A step's params with what it made moved by `world` mm (world, at the design's transform now), or why it cannot be. */
export function movedStep(s: Step, world: Vec3, designTransform: Mat4): StepParams | string {
  const local = direction(invert(designTransform), world)
  if (s.params.op === 'parts.add') {
    return { ...s.params, parts: s.params.parts.map((p) => ({ ...p, positions: Array.from(p.positions, (v, i) => v + local[i % 3]!) })) }
  }
  const at = direction(s.transform, local)
  const m: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], at[2], 1]
  const next = movedParams(s.params, m)
  if (next === s.params) return 'this step has no place of its own (it works on the whole part); move the step that made the part'
  return next
}

/** Every point of a loop, or null when it has a curve that a one-way stretch would bend out of shape (an arc, a circle). */
function loopPoints(l: SketchLoop): Vec2[] | null {
  if ('points' in l) return l.points
  if ('segments' in l) return l.segments.every((g) => g.type === 'line') ? [l.start, ...l.segments.map((g) => (g as { to: Vec2 }).to)] : null
  return null
}

/** A loop with each point moved by `f`; the caller has checked loopPoints. */
function mapLoop(l: SketchLoop, f: (p: Vec2) => Vec2): SketchLoop {
  if ('points' in l) return { ...l, points: l.points.map(f) }
  if ('segments' in l) return { ...l, start: f(l.start), segments: l.segments.map((g) => ({ ...g, to: f((g as { to: Vec2 }).to) })) as typeof l.segments }
  return l
}

/** The in-plane direction of world `axis` on `frame` (unit, in u v), or null when the axis does not lie in the plane. */
function inPlane(frame: FaceFrame, axis: Vec3): Vec2 | null {
  const a = dot(frame.u, axis)
  const b = dot(frame.v, axis)
  return near(Math.hypot(a, b), 1) ? [a, b] : null
}

/** Loops stretched along in-plane direction `w` to span `mm`, from their low end; or why they cannot be. */
function stretchLoops(loops: SketchLoop[], w: Vec2, mm: number, from: number, to: number): SketchLoop[] {
  const k = mm / (to - from)
  return loops.map((l) =>
    mapLoop(l, ([x, y]) => {
      const t = x * w[0] + y * w[1]
      const d = (t - from) * (k - 1)
      return [x + d * w[0], y + d * w[1]]
    }),
  )
}

/** The span of loops along in-plane direction `w`, offset by `base` (the frame origin's own reading along the axis). */
function spanOf(loops: SketchLoop[], w: Vec2): [number, number] | null {
  let lo = Infinity
  let hi = -Infinity
  for (const l of loops) {
    const pts = loopPoints(l)
    if (!pts) return null
    for (const [x, y] of pts) {
      const t = x * w[0] + y * w[1]
      lo = Math.min(lo, t)
      hi = Math.max(hi, t)
    }
  }
  return hi > lo ? [lo, hi] : null
}

const CURVED = 'its outline has arcs or circles, which a stretch one way would bend; change it with geom.sketch_edit or build it again'

/**
 * A step's params with what it made set to `mm` long along world `axis`, from its low end, and the length it had; or
 * why it cannot be. The axis is read at the step's own transform, which is the design's unless the design was moved.
 */
export function sizedStep(s: Step, axisName: Axis, mm: number): { params: StepParams; was: number } | string {
  const axis = direction(s.transform, AXIS[axisName])
  const p = s.params
  if (p.op === 'shape.extrude') {
    const frame = p.frame ?? BED_FRAME
    const along = dot(frame.normal, axis)
    if (near(Math.abs(along), 1)) {
      if (p.spec.extent && p.spec.extent !== 'oneSide') return 'size: an extrude both ways is changed by its value, its distance'
      return { params: { ...p, spec: { ...p.spec, distanceMm: mm } }, was: p.spec.distanceMm }
    }
    const w = inPlane(frame, axis)
    if (!w) return `size: ${axisName} runs neither along this extrude nor across it`
    if (p.placement?.rotationDeg) return 'size: the outline is turned; change it with geom.sketch_edit'
    const shape = p.shape
    if (shape.type === 'rectangle') {
      const key = near(Math.abs(w[0]), 1) ? 'widthMm' : 'heightMm'
      return { params: { ...p, shape: { ...shape, [key]: mm } }, was: shape[key] }
    }
    if (shape.type === 'sketch') {
      const span = spanOf(shape.loops, w)
      if (!span) return `size: ${CURVED}`
      return { params: { ...p, shape: { ...shape, loops: stretchLoops(shape.loops, w, mm, span[0], span[1]) } }, was: span[1] - span[0] }
    }
    return `size: a ${shape.type} outline keeps its proportions; change it with its own size`
  }
  if (p.op === 'sketch.revolve') {
    const frame = p.frame ?? BED_FRAME
    const w = inPlane(frame, axis)
    const dirLen = Math.hypot(p.axis.direction[0], p.axis.direction[1])
    const a: Vec2 = [p.axis.direction[0] / dirLen, p.axis.direction[1] / dirLen]
    const span = (dir: Vec2) => spanOf(p.loops, dir)
    if (w && near(Math.abs(w[0] * a[0] + w[1] * a[1]), 1)) {
      // along the turning axis: the outline stretched along it, from its low end
      const sp = span(w)
      if (!sp) return `size: ${CURVED}`
      return { params: { ...p, loops: stretchLoops(p.loops, w, mm, sp[0], sp[1]) }, was: sp[1] - sp[0] }
    }
    if ((w && near(w[0] * a[0] + w[1] * a[1], 0)) || near(Math.abs(dot(axis, frame.normal)), 1)) {
      // across the turning axis: its diameter, the outline's reach from the axis scaled
      const n: Vec2 = [-a[1], a[0]]
      const reach = Math.max(...p.loops.flatMap((l) => (loopPoints(l) ?? [[NaN, NaN]]).map(([x, y]) => Math.abs((x - p.axis.point[0]) * n[0] + (y - p.axis.point[1]) * n[1]))))
      if (!Number.isFinite(reach) || reach <= 0) return `size: ${CURVED}`
      const k = mm / 2 / reach
      const loops = p.loops.map((l) =>
        mapLoop(l, ([x, y]) => {
          const r = (x - p.axis.point[0]) * n[0] + (y - p.axis.point[1]) * n[1]
          return [x + r * (k - 1) * n[0], y + r * (k - 1) * n[1]]
        }),
      )
      return { params: { ...p, loops }, was: reach * 2 }
    }
    return `size: ${axisName} runs neither along this revolve's axis nor across it`
  }
  if (p.op === 'sketch.loft') {
    const frames = p.profiles.map((q) => q.frame ?? BED_FRAME)
    if (frames.every((f) => near(Math.abs(dot(f.normal, axis)), 1))) {
      // along its run: the sections spaced out or drawn in, from the first one along the axis
      const at = frames.map((f) => dot(f.origin, axis))
      const lo = Math.min(...at)
      const hi = Math.max(...at)
      if (!(hi > lo)) return 'size: the sections stand at one place along that axis'
      const k = mm / (hi - lo)
      const profiles = p.profiles.map((q, i) => {
        const f = frames[i]!
        const shift = (at[i]! - lo) * (k - 1)
        return { ...q, frame: { ...f, origin: [f.origin[0] + axis[0] * shift, f.origin[1] + axis[1] * shift, f.origin[2] + axis[2] * shift] as Vec3 } }
      })
      return { params: { ...p, profiles }, was: hi - lo }
    }
    // across its sections: every section stretched the same way, from the low end of them all
    const ws = frames.map((f) => inPlane(f, axis))
    if (ws.some((w) => !w)) return `size: ${axisName} runs neither along this loft nor across its sections`
    let lo = Infinity
    let hi = -Infinity
    for (const [i, q] of p.profiles.entries()) {
      const sp = spanOf(q.loops, ws[i]!)
      if (!sp) return `size: ${CURVED}`
      const base = dot(frames[i]!.origin, axis)
      lo = Math.min(lo, base + sp[0])
      hi = Math.max(hi, base + sp[1])
    }
    const profiles = p.profiles.map((q, i) => {
      const base = dot(frames[i]!.origin, axis)
      return { ...q, loops: stretchLoops(q.loops, ws[i]!, mm, lo - base, lo - base + (hi - lo)) }
    })
    return { params: { ...p, profiles }, was: hi - lo }
  }
  return 'size: only an extrude, revolve or loft step is sized this way; change this one by its value'
}
