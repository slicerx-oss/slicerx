// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A step's lean (Step.tilt): what an extrude, a loft or an added part (a post, a cylinder) made, turned about its foot
// so its top leans one way by some degrees; each separate piece of an added part leans about its own foot. A step
// built on a leaning one leans with it about that step's foot (StepTilt.about). The lean is kept beside the step's
// own numbers and laid on them as the step replays, so an edit of a size, a move or a section afterwards keeps it, the
// timeline shows the same steps, and undoing the edit takes it back. A pattern made of the step copies the leaning one.
import { meshPieces } from '@slicerx/contracts/mesh-pieces'
import { BED_FRAME, type HistoryMesh, type LoftProfile, type Step, type StepParams, type StepTilt } from './model'
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

/** The middle of the lowest points along `up` (within 0.5 mm of the lowest) of the vertices `at`, or of all of them. */
function footOf(p: ArrayLike<number>, up: Vec3, at?: readonly number[]): Vec3 | null {
  const n = at ? at.length : p.length / 3
  const v = (k: number): number => (at ? at[k]! : k) * 3
  let low = Infinity
  for (let k = 0; k < n; k++) low = Math.min(low, p[v(k)]! * up[0] + p[v(k) + 1]! * up[1] + p[v(k) + 2]! * up[2])
  if (!Number.isFinite(low)) return null
  const lo: Vec3 = [Infinity, Infinity, Infinity]
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let k = 0; k < n; k++) {
    const i = v(k)
    if (p[i]! * up[0] + p[i + 1]! * up[1] + p[i + 2]! * up[2] > low + 0.5) continue
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, p[i + a]!)
      hi[a] = Math.max(hi[a]!, p[i + a]!)
    }
  }
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
}

/** How far apart two pieces' boxes may be and still count as one piece that leans as one, mm. */
const PIECE_GAP_MM = 0.05

/**
 * The separate pieces of an added part, as lists of its vertex numbers: triangles that share a corner (by number or by
 * place, to 1 micrometer) are one piece, and pieces whose boxes meet (a top resting on a post, a ring around it)
 * count as one. One list holding every vertex when the part is a single piece.
 */
function partPieces(m: Pick<HistoryMesh, 'positions' | 'indices'>): number[][] {
  const p = m.positions
  // pieces whose boxes meet lean as one
  const groups = meshPieces(p, m.indices).vertices().map((verts) => {
    const lo: Vec3 = [Infinity, Infinity, Infinity]
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
    for (const i of verts)
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a]!, p[i * 3 + a]!)
        hi[a] = Math.max(hi[a]!, p[i * 3 + a]!)
      }
    return { verts, lo, hi }
  })
  const meets = (a: (typeof groups)[number], b: (typeof groups)[number]): boolean => [0, 1, 2].every((k) => a.lo[k]! - PIECE_GAP_MM <= b.hi[k]! && b.lo[k]! - PIECE_GAP_MM <= a.hi[k]!)
  for (let merged = true; merged && groups.length > 1; ) {
    merged = false
    for (let a = 0; a < groups.length && !merged; a++)
      for (let b = a + 1; b < groups.length && !merged; b++) {
        const ga = groups[a]!
        const gb = groups[b]!
        if (!meets(ga, gb)) continue
        ga.verts.push(...gb.verts)
        for (let k = 0; k < 3; k++) {
          ga.lo[k] = Math.min(ga.lo[k]!, gb.lo[k]!)
          ga.hi[k] = Math.max(ga.hi[k]!, gb.hi[k]!)
        }
        groups.splice(b, 1)
        merged = true
      }
  }
  return groups.map((g) => g.verts)
}

/** The foot of each separate piece of an added part (partPieces): each leans about its own. */
export function partFeet(m: Pick<HistoryMesh, 'positions' | 'indices'>, up: Vec3): Vec3[] {
  return partPieces(m)
    .map((at) => footOf(m.positions, up, at))
    .filter((f): f is Vec3 => f !== null)
}

/** Of `feet`, the one nearest `q` across `up` (its height along `up` left out). */
export function nearestFoot(feet: readonly Vec3[], q: Vec3, up: Vec3): Vec3 | undefined {
  const across = (f: Vec3): number => {
    const d: Vec3 = [f[0] - q[0], f[1] - q[1], f[2] - q[2]]
    const h = dot(d, up)
    return Math.hypot(d[0] - up[0] * h, d[1] - up[1] * h, d[2] - up[2] * h)
  }
  return feet.reduce<Vec3 | undefined>((a, f) => (a === undefined || across(f) < across(a) ? f : a), undefined)
}

/**
 * A part's points turned, each separate piece (partPieces) by the turn `turnOf` gives for its vertices; its faces keep
 * their keys, and the shape it was made as no longer fits.
 */
function turnedPart(part: HistoryMesh, turnOf: (at: readonly number[]) => Mat4 | null): HistoryMesh {
  const p = part.positions
  const out = Float32Array.from(p)
  for (const at of partPieces(part)) {
    const m = turnOf(at)
    if (!m) continue
    for (const v of at) {
      const i = v * 3
      const [x, y, z] = [p[i]!, p[i + 1]!, p[i + 2]!]
      out[i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
      out[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
      out[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
    }
  }
  const { primitive: _shape, ...rest } = part
  return { ...rest, positions: out }
}

/**
 * A step's numbers with its lean laid on them; the step as it is when it has none or cannot lean. A lean with `about`
 * turns about that point (a step carried by the one it stands on); one without turns about the step's own foot, each
 * separate piece of an added part about its own. A carried added part with `feet` turns each of its pieces about the
 * one of them it stands over.
 */
export function tiltedParams(p: StepParams, t: StepTilt | undefined): StepParams {
  if (!t || t.degrees === 0) return p
  if (p.op === 'parts.add') {
    // each separate piece of a part turns about its own foot; one a lean carries, about the foot it stands over
    const parts = p.parts.map((part) =>
      turnedPart(part, (at) => {
        const own = footOf(part.positions, t.up, at)
        const foot = t.feet?.length && own ? nearestFoot(t.feet, own, t.up) : (t.about ?? own)
        return foot ? tiltMatrix(t, foot) : null
      }),
    )
    return { ...p, parts }
  }
  const foot = t.about ?? tiltFoot(p, t.up)
  const m = foot ? tiltMatrix(t, foot) : null
  if (!m) return p
  // a carried step sinks a hair into the step it stands on before it turns: faces that met flat would otherwise meet
  // as slivers once both turn, which a join refuses
  return movedParams(p, t.about ? sunk(m, t.up) : m)
}

/** `m` after a move of SINK_MM against `up`. */
function sunk(m: Mat4, up: Vec3): Mat4 {
  const d: Vec3 = [-up[0] * SINK_MM, -up[1] * SINK_MM, -up[2] * SINK_MM]
  const at: Vec3 = [m[0]! * d[0] + m[4]! * d[1] + m[8]! * d[2], m[1]! * d[0] + m[5]! * d[1] + m[9]! * d[2], m[2]! * d[0] + m[6]! * d[1] + m[10]! * d[2]]
  const out = [...m]
  out[12] = m[12]! + at[0]
  out[13] = m[13]! + at[1]
  out[14] = m[14]! + at[2]
  return out
}

/** How far a carried step sinks into the step it stands on, mm: well under any size a printer makes. */
export const SINK_MM = 0.01

/** The step as it replays: its lean laid on its numbers. */
export function withTilt(s: Step): Step {
  return s.tilt ? { ...s, params: tiltedParams(s.params, s.tilt) } : s
}

/** The most feet a saved carried lean lists. */
const MAX_FEET = 10_000

/** A lean read from a saved project: finite degrees within 89 either way and two unit directions, else none. */
export function readTilt(v: unknown): Pick<Step, 'tilt'> {
  if (!v || typeof v !== 'object') return {}
  const o = v as Record<string, unknown>
  const vec = (x: unknown): Vec3 | null => (Array.isArray(x) && x.length === 3 && x.every((n) => typeof n === 'number' && Number.isFinite(n)) ? unit(x as Vec3) : null)
  const d = o['degrees']
  const up = vec(o['up'])
  const toward = vec(o['toward'])
  if (typeof d !== 'number' || !Number.isFinite(d) || Math.abs(d) > 89 || d === 0 || !up || !toward) return {}
  const point = (x: unknown): x is Vec3 => Array.isArray(x) && x.length === 3 && x.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100_000)
  const about = point(o['about']) ? o['about'] : undefined
  const feet = about && Array.isArray(o['feet']) && o['feet'].length > 0 && o['feet'].length <= MAX_FEET && o['feet'].every(point) ? (o['feet'] as Vec3[]) : undefined
  return { tilt: { degrees: d, up, toward, ...(about ? { about } : {}), ...(feet ? { feet } : {}) } }
}
