// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A step's lean (Step.tilt): what an extrude or a loft made, turned about its foot so its top leans one way by some
// degrees. The lean is kept beside the step's own numbers and laid on them as the step replays, so an edit of a size,
// a move or a section afterwards keeps it, the timeline shows one step, and undoing the edit takes it back. A pattern
// made of the step copies the leaning one.
import { BED_FRAME, type LoftProfile, type Step, type StepParams, type StepTilt } from './model'
import { movedParams } from './design-frame'
import type { Mat4, SketchLoop, Vec2, Vec3 } from './types'

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a: Vec3): Vec3 | null => {
  const n = Math.hypot(a[0], a[1], a[2])
  return n > 1e-9 ? [a[0] / n, a[1] / n, a[2] / n] : null
}

/** The middle of a loop's extent, in its frame's u v. */
function loopCenter(l: SketchLoop): Vec2 {
  if ('center' in l) return l.center
  const pts: Vec2[] = 'points' in l ? l.points : [l.start, ...l.segments.flatMap((g) => ('to' in g ? [g.to as Vec2] : []))]
  if (!pts.length) return [0, 0]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
}

function onFrame(frame: LoftProfile['frame'], c: Vec2): Vec3 {
  const f = frame ?? BED_FRAME
  return [f.origin[0] + f.u[0] * c[0] + f.v[0] * c[1], f.origin[1] + f.u[1] * c[0] + f.v[1] * c[1], f.origin[2] + f.u[2] * c[0] + f.v[2] * c[1]]
}

/** Where what the step made stands: the middle of its lowest section along `up`. Null for a step that cannot lean. */
export function tiltFoot(p: StepParams, up: Vec3): Vec3 | null {
  if (p.op === 'shape.extrude') {
    const f = p.frame ?? BED_FRAME
    const c = p.shape.type === 'sketch' && p.shape.loops.length ? loopCenter(p.shape.loops[0]!) : ([0, 0] as Vec2)
    const at = p.placement?.center ?? [0, 0]
    const start = onFrame(f, [c[0] + at[0], c[1] + at[1]])
    const n: Vec3 = p.spec.flip ? [-f.normal[0], -f.normal[1], -f.normal[2]] : f.normal
    const d = p.spec.distanceMm
    const back = p.spec.extent === 'symmetric' ? d / 2 : p.spec.extent === 'twoSides' ? (p.spec.distance2Mm ?? d) : 0
    const fwd = p.spec.extent === 'symmetric' ? d / 2 : d
    const ends: Vec3[] = [
      [start[0] + n[0] * fwd, start[1] + n[1] * fwd, start[2] + n[2] * fwd],
      [start[0] - n[0] * back, start[1] - n[1] * back, start[2] - n[2] * back],
    ]
    return ends.reduce((a, b) => (dot(b, up) < dot(a, up) ? b : a))
  }
  if (p.op === 'sketch.loft') {
    const feet = p.profiles.map((q) => onFrame(q.frame, q.loops.length ? loopCenter(q.loops[0]!) : [0, 0]))
    return feet.length ? feet.reduce((a, b) => (dot(b, up) < dot(a, up) ? b : a)) : null
  }
  return null
}

/** The turn of `t` about `foot`, as a matrix (column major): `up` leans toward `toward` by t.degrees. */
export function tiltMatrix(t: StepTilt, foot: Vec3): Mat4 | null {
  const axis = unit(cross(t.up, t.toward))
  if (!axis) return null
  const a = (t.degrees * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const [x, y, z] = axis
  // Rodrigues' rotation, rows r0 r1 r2
  const r = [
    [c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
    [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
    [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)],
  ] as const
  const rf = [0, 1, 2].map((i) => r[i]![0] * foot[0] + r[i]![1] * foot[1] + r[i]![2] * foot[2])
  return [r[0][0], r[1][0], r[2][0], 0, r[0][1], r[1][1], r[2][1], 0, r[0][2], r[1][2], r[2][2], 0, foot[0] - rf[0]!, foot[1] - rf[1]!, foot[2] - rf[2]!, 1]
}

/** A step's numbers with its lean laid on them; the step as it is when it has none or cannot lean. */
export function tiltedParams(p: StepParams, t: StepTilt | undefined): StepParams {
  if (!t || t.degrees === 0) return p
  const foot = tiltFoot(p, t.up)
  const m = foot ? tiltMatrix(t, foot) : null
  return m ? movedParams(p, m) : p
}

/** The step as it replays: its lean laid on its numbers. */
export function withTilt(s: Step): Step {
  return s.tilt ? { ...s, params: tiltedParams(s.params, s.tilt) } : s
}

/** A lean read from a saved project: finite degrees within 89 either way and two unit directions, else none. */
export function readTilt(v: unknown): Pick<Step, 'tilt'> {
  if (!v || typeof v !== 'object') return {}
  const o = v as Record<string, unknown>
  const vec = (x: unknown): Vec3 | null => (Array.isArray(x) && x.length === 3 && x.every((n) => typeof n === 'number' && Number.isFinite(n)) ? unit(x as Vec3) : null)
  const d = o['degrees']
  const up = vec(o['up'])
  const toward = vec(o['toward'])
  if (typeof d !== 'number' || !Number.isFinite(d) || Math.abs(d) > 89 || d === 0 || !up || !toward) return {}
  return { tilt: { degrees: d, up, toward } }
}
