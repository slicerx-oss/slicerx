// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Feature patterns: a shape on a face repeated along a line, a grid or a circle, or at points, as one step (sx-geom
// face.rs, Pattern). The engine makes the copies; this places them for the preview the same way, counts them,
// reads the panel's fields (with the panel's number reader, so the geometry worker never loads the panels) and says what is wrong with a pattern in words. Positions are face coordinates (u, v),
// mm, and the shape itself is always the first copy.
// Step patterns: earlier steps done again elsewhere on their part, along a line or grid, around an axis or mirrored
// through a plane, as one step (model.ts, op pattern). Their copies are moves in world mm at the step's transform.
import type { Step } from './model'
import type { ArraySpec, Mat4, Vec2, Vec3 } from './types'

export type Pattern =
  | { kind: 'linear'; count: number; stepMm: Vec2; count2?: number; step2Mm?: Vec2 }
  | { kind: 'circular'; count: number; center: Vec2; angleDeg?: number }
  | { kind: 'points'; offsets: Vec2[] }

/** At most this many copies in one step. */
export const MAX_COPIES = 500

export function copyCount(p: Pattern): number {
  if (p.kind === 'linear') return p.count * (p.count2 ?? 1)
  if (p.kind === 'circular') return p.count
  return p.offsets.length + 1
}

/** Where each copy puts a point of the shape. */
export function patternCopies(p: Pattern): ((q: Vec2) => Vec2)[] {
  if (p.kind === 'points') return [(q) => q, ...p.offsets.map((d) => (q: Vec2): Vec2 => [q[0] + d[0], q[1] + d[1]])]
  if (p.kind === 'linear') {
    const out: ((q: Vec2) => Vec2)[] = []
    const s2 = p.step2Mm ?? [0, 0]
    for (let j = 0; j < (p.count2 ?? 1); j++) {
      for (let i = 0; i < p.count; i++) {
        const d: Vec2 = [p.stepMm[0] * i + s2[0] * j, p.stepMm[1] * i + s2[1] * j]
        out.push((q) => [q[0] + d[0], q[1] + d[1]])
      }
    }
    return out
  }
  const sweep = p.angleDeg ?? 360
  const full = Math.abs(Math.abs(sweep) - 360) < 1e-9
  const step = full ? sweep / p.count : p.count > 1 ? sweep / (p.count - 1) : 0
  const [cx, cy] = p.center
  return Array.from({ length: p.count }, (_, i) => {
    const a = (step * i * Math.PI) / 180
    const [c, s] = [Math.cos(a), Math.sin(a)]
    return (q: Vec2): Vec2 => [cx + (q[0] - cx) * c - (q[1] - cy) * s, cy + (q[0] - cx) * s + (q[1] - cy) * c]
  })
}

/** What is wrong with the pattern, in words, or null. */
export function patternProblem(p: Pattern): string | null {
  const n = copyCount(p)
  if (p.kind !== 'points' && (!Number.isInteger(p.count) || p.count < 2)) return 'A pattern has at least 2 copies.'
  if (p.kind === 'linear' && p.count2 !== undefined && (!Number.isInteger(p.count2) || p.count2 < 1)) return 'A grid has at least 1 row.'
  if (n > MAX_COPIES) return `A pattern has at most ${MAX_COPIES} copies; this one has ${n}.`
  if (p.kind === 'linear') {
    const flat = (v: Vec2 | undefined) => !v || !(Number.isFinite(v[0]) && Number.isFinite(v[1])) || Math.hypot(v[0], v[1]) === 0
    if (flat(p.stepMm) || ((p.count2 ?? 1) > 1 && flat(p.step2Mm))) return 'Give the spacing between copies, more than 0 mm.'
  }
  if (p.kind === 'circular') {
    if (!p.center.every(Number.isFinite)) return 'Give the center of the circle.'
    if (p.angleDeg !== undefined && !(Number.isFinite(p.angleDeg) && Math.abs(p.angleDeg) <= 360 && p.angleDeg !== 0)) return 'The sweep is more than 0 and at most 360 degrees.'
  }
  return null
}

/** The panel's pattern fields, as text the person typed (named values work). */
export type PatternFields =
  | { kind: 'none' }
  | { kind: 'line'; count: string; step: string; angle: string }
  | { kind: 'grid'; count: string; step: string; count2: string; step2: string }
  | { kind: 'circle'; count: string; centerX: string; centerY: string; sweep: string }
  // A pattern at points has no fields: it is kept as it is until another mode is picked.
  | { kind: 'points'; pattern: Extract<Pattern, { kind: 'points' }> }

/** The pattern the fields describe; `num` reads a typed number (the panels' own, which takes named values). */
export function patternFromFields(f: PatternFields, num: (text: string) => number): Pattern | null {
  switch (f.kind) {
    case 'none':
      return null
    case 'line': {
      const a = (num(f.angle || '0') * Math.PI) / 180
      const d = num(f.step)
      const r = (v: number) => Math.round(v * 1e9) / 1e9
      return { kind: 'linear', count: num(f.count), stepMm: [r(d * Math.cos(a)), r(d * Math.sin(a))] }
    }
    case 'grid':
      return { kind: 'linear', count: num(f.count), stepMm: [num(f.step), 0], count2: num(f.count2), step2Mm: [0, num(f.step2)] }
    case 'circle':
      return { kind: 'circular', count: num(f.count), center: [num(f.centerX), num(f.centerY)], angleDeg: num(f.sweep) }
    case 'points':
      return f.pattern
  }
}

/** How a pattern step repeats earlier steps: in a row or grid, around an axis, or as their mirror image (world, mm). */
/**
 * A step pattern: a row, grid or circle (onSurface on a row: each copy slides onto the part's surface where it lands and
 * turns to it, for a row along a curved side), or a mirror.
 */
export type StepPattern = (ArraySpec & { onSurface?: true }) | { kind: 'mirror'; plane: { point: Vec3; normal: Vec3 } }

/** At most this many copies in a step pattern: each copy runs every step it repeats again on the whole part. */
export const MAX_STEP_COPIES = 100
/** At most this many steps repeated by one pattern. */
export const MAX_STEPS_REPEATED = 16

/** The copies a step pattern makes, the steps themselves counted as the first. */
export function stepCopyCount(p: StepPattern): number {
  if (p.kind === 'mirror') return 2
  return p.kind === 'linear' ? p.count * (p.count2 ?? 1) : p.count
}

const len3 = (v: readonly number[] | undefined) => (v && v.length === 3 && v.every(Number.isFinite) ? Math.hypot(v[0]!, v[1]!, v[2]!) : NaN)

/** What is wrong with a step pattern, in words, or null. */
export function stepPatternProblem(p: StepPattern): string | null {
  if (p.kind === 'mirror') {
    if (!(len3(p.plane.point) >= 0)) return 'Give a point on the mirror plane.'
    return len3(p.plane.normal) > 0 ? null : 'Give the mirror plane a direction.'
  }
  if (!Number.isInteger(p.count) || p.count < 2) return 'A pattern has at least 2 copies.'
  if (p.onSurface && p.kind !== 'linear') return 'Only a row or a grid follows a surface; a circle of copies already turns with its axis.'
  if (p.kind === 'linear' && p.count2 !== undefined && (!Number.isInteger(p.count2) || p.count2 < 1)) return 'A grid has at least 1 row.'
  const n = stepCopyCount(p)
  if (n > MAX_STEP_COPIES) return `A pattern of steps has at most ${MAX_STEP_COPIES} copies; this one has ${n}.`
  if (p.kind === 'linear') {
    if (!(len3(p.step) > 0) || ((p.count2 ?? 1) > 1 && !(len3(p.step2) > 0))) return 'Give the spacing between copies, more than 0 mm.'
    return null
  }
  if (p.rotateCopies === false) return 'A pattern of steps turns each copy with the circle.'
  if (!(len3(p.center) >= 0)) return 'Give the center of the circle.'
  if (p.axis !== undefined && !(len3(p.axis) > 0)) return 'Give the axis a direction.'
  if (p.angleDeg !== undefined && !(Number.isFinite(p.angleDeg) && Math.abs(p.angleDeg) <= 360 && p.angleDeg !== 0)) return 'The sweep is more than 0 and at most 360 degrees.'
  return null
}

/** A turn of `deg` degrees about the axis through `center`, column-major, as the engine's array turns its copies. */
function turnAbout(center: Vec3, axis: Vec3, deg: number): Mat4 {
  const l = Math.hypot(axis[0], axis[1], axis[2])
  const [x, y, z] = [axis[0] / l, axis[1] / l, axis[2] / l]
  const a = (deg * Math.PI) / 180
  const [s, c] = [Math.sin(a), Math.cos(a)]
  const t = 1 - c
  const r = [t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0, t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0, t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0]
  // the center stays where it is: p -> R (p - center) + center
  const moved = [0, 1, 2].map((k) => center[k]! - (r[k]! * center[0] + r[4 + k]! * center[1] + r[8 + k]! * center[2]))
  return [...r, moved[0]!, moved[1]!, moved[2]!, 1]
}

/**
 * The move that puts each copy after the first (the steps themselves), world at the step's transform: a shift for a
 * row or grid, a turn about the axis for a circle (its sweep shared as the engine's array shares it), a reflection
 * for a mirror.
 */
export function stepCopyMoves(p: StepPattern): Mat4[] {
  if (p.kind === 'mirror') {
    const l = Math.hypot(...p.plane.normal)
    const n: Vec3 = [p.plane.normal[0] / l, p.plane.normal[1] / l, p.plane.normal[2] / l]
    const d = 2 * (p.plane.point[0] * n[0] + p.plane.point[1] * n[1] + p.plane.point[2] * n[2])
    // I - 2nn^T, moved by 2(n.q)n
    return [[1 - 2 * n[0] * n[0], -2 * n[1] * n[0], -2 * n[2] * n[0], 0, -2 * n[0] * n[1], 1 - 2 * n[1] * n[1], -2 * n[2] * n[1], 0, -2 * n[0] * n[2], -2 * n[1] * n[2], 1 - 2 * n[2] * n[2], 0, d * n[0], d * n[1], d * n[2], 1]]
  }
  const out: Mat4[] = []
  if (p.kind === 'linear') {
    const s2 = p.step2 ?? [0, 0, 0]
    for (let j = 0; j < (p.count2 ?? 1); j++)
      for (let i = 0; i < p.count; i++) {
        if (i === 0 && j === 0) continue
        out.push([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p.step[0] * i + s2[0] * j, p.step[1] * i + s2[1] * j, p.step[2] * i + s2[2] * j, 1])
      }
    return out
  }
  const sweep = p.angleDeg ?? 360
  const full = Math.abs(Math.abs(sweep) - 360) < 1e-9
  const step = full ? sweep / p.count : sweep / (p.count - 1)
  for (let i = 1; i < p.count; i++) out.push(turnAbout(p.center, p.axis ?? [0, 0, 1], step * i))
  return out
}

/** The kinds of step a pattern repeats: those that add, take away or round material where they are, or paint from a point. */
const REPEATS: ReadonlySet<string> = new Set(['face.push', 'shape.extrude', 'sketch.revolve', 'sketch.loft', 'sketch.sweep', 'subtract', 'hole.apply', 'thread.apply', 'edge.fillet', 'edge.chamfer', 'paint', 'pattern'])

/** Why step `s` cannot be repeated by a pattern, in words, or null when it can. The pattern works on the step's part, or on every part as the step does. */
export function repeatProblem(s: Pick<Step, 'part' | 'params'>): string | null {
  const p = s.params
  if (!REPEATS.has(p.op)) return 'A pattern repeats steps that add, cut, round or paint material where they are: a push or pull, a join or cut, a hole, a thread, a fillet, a chamfer, paint from a point, or another pattern of those.'
  const op = p.op === 'shape.extrude' ? (p.spec.operation ?? 'new') : p.op === 'sketch.revolve' || p.op === 'sketch.loft' || p.op === 'sketch.sweep' ? (p.operation ?? 'new') : null
  if (op === 'new') return 'A pattern repeats joins and cuts on a part; this step makes a new body, so array that part instead.'
  if (p.op === 'paint' && p.target.kind !== 'seed') return 'A pattern repeats paint from a point; this step paints by side or height, which already covers the part.'
  return null
}
