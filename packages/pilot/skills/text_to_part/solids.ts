// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Parametric solids for text_to_part: the spec the model writes, its
// conversion to boxes and cylinders, closed meshes for each (separate shells,
// which slicers union) and the through holes as solids to subtract.
import type { MeshPart } from '@slicerx/contracts'
import { z } from 'zod'
import type { Vec3 } from '../orientation_search/geometry'
import { holeSolid, round, type GeomSolid } from '../geom_common/index'

const V3 = z.array(z.number()).length(3)
const AXIS = z.enum(['x', 'y', 'z'])
type Axis = z.infer<typeof AXIS>

const boxLike = {
  sizeMm: V3.describe('Size along X, Y and Z in mm'),
  atMm: V3.optional().describe('Minimum corner in mm, default 0,0,0'),
}

export const SolidSpec = z.discriminatedUnion('type', [
  z.object({ type: z.literal('box'), ...boxLike }),
  z.object({ type: z.literal('plate'), ...boxLike }),
  z.object({
    type: z.literal('cylinder'),
    diameterMm: z.number().positive().max(1000),
    heightMm: z.number().positive().max(1000),
    atMm: V3.optional().describe('Center of the base in mm, default 0,0,0'),
    axis: AXIS.default('z').describe('Axis the cylinder stands along'),
  }),
  z.object({
    type: z.literal('l_bracket'),
    legAMm: z.number().positive().max(1000).describe('Length of the leg on the bed, along X'),
    legBMm: z.number().positive().max(1000).describe('Height of the upright leg, along Z, including the base thickness'),
    widthMm: z.number().positive().max(1000).describe('Width along Y'),
    thicknessMm: z.number().positive().max(100),
    atMm: V3.optional().describe('Outer corner in mm, default 0,0,0'),
  }),
])
export type SolidSpecInput = z.infer<typeof SolidSpec>

const XY = z.tuple([z.number(), z.number()])
/** One closed loop of a profile, in sx-geom's sketch form (docs/cad-engine.md, "Sketches"). */
const Loop = z.union([
  z.object({ points: z.array(XY).min(3).max(400).describe('Corners, joined by straight sides and closed back to the first') }),
  z.object({ type: z.literal('circle'), center: XY, diameterMm: z.number().positive().max(1000) }),
  z.object({
    start: XY,
    segments: z
      .array(
        z.union([
          z.object({ type: z.literal('line'), to: XY }),
          z.object({ type: z.literal('arc'), to: XY, through: XY.describe('Any point on the arc between its ends') }),
          z.object({ type: z.literal('arc'), to: XY, radiusMm: z.number().positive(), clockwise: z.boolean().optional(), large: z.boolean().optional() }),
        ]),
      )
      .min(1)
      .max(200)
      .describe('Lines and arcs from start; the last one ends back on start'),
  }),
])

export const ProfileSpec = z.object({
  loops: z.array(Loop).min(1).max(32).describe('Closed loops in mm, x right and y back; a loop inside another is a hole, a loop inside a hole an island'),
  heightMm: z.number().positive().max(1000).describe('How far the profile stands up along Z'),
  atMm: V3.optional().describe('Where the profile origin sits, default 0,0,0; the profile rises from this Z'),
  draftDeg: z.number().min(-45).max(45).optional().describe('Side taper, positive narrows toward the top'),
})
export type ProfileInput = z.infer<typeof ProfileSpec>

/** shape.extrude's request for a profile: a new body standing on a level plane at the profile's origin. */
export function profileRequest(p: ProfileInput): unknown {
  const at = v(p.atMm)
  return {
    frame: { origin: at, normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    shape: { type: 'sketch', loops: p.loops },
    spec: { distanceMm: p.heightMm, operation: 'new', ...(p.draftDeg ? { taperDeg: p.draftDeg } : {}) },
  }
}

export const HoleSpecInput = z.object({
  diameterMm: z.number().positive().max(200),
  atMm: V3.describe('Any point on the hole axis, mm; the hole runs through the whole part along the axis'),
  axis: AXIS.default('z'),
  countersinkMm: z.number().positive().max(400).optional().describe('Countersink head diameter at the high end of the hole (90 degrees)'),
})
export type HoleInput = z.infer<typeof HoleSpecInput>

export type Prim = { kind: 'box'; min: Vec3; max: Vec3 } | { kind: 'cylinder'; base: Vec3; axis: Axis; r: number; h: number }

const v = (a: number[] | undefined): Vec3 => [a?.[0] ?? 0, a?.[1] ?? 0, a?.[2] ?? 0]
const AX: Record<Axis, number> = { x: 0, y: 1, z: 2 }

/** Boxes and cylinders for a spec. An L bracket is two plates that touch without overlapping. */
export function primitives(solids: SolidSpecInput[]): Prim[] {
  const out: Prim[] = []
  for (const s of solids) {
    if (s.type === 'box' || s.type === 'plate') {
      const at = v(s.atMm)
      out.push({ kind: 'box', min: at, max: [at[0] + (s.sizeMm[0] ?? 0), at[1] + (s.sizeMm[1] ?? 0), at[2] + (s.sizeMm[2] ?? 0)] })
    } else if (s.type === 'cylinder') {
      out.push({ kind: 'cylinder', base: v(s.atMm), axis: s.axis, r: s.diameterMm / 2, h: s.heightMm })
    } else {
      const at = v(s.atMm)
      const t = s.thicknessMm
      out.push({ kind: 'box', min: at, max: [at[0] + s.legAMm, at[1] + s.widthMm, at[2] + t] })
      if (s.legBMm > t) out.push({ kind: 'box', min: [at[0], at[1], at[2] + t], max: [at[0] + t, at[1] + s.widthMm, at[2] + s.legBMm] })
    }
  }
  return out
}

export function primBounds(p: Prim): { min: Vec3; max: Vec3 } {
  if (p.kind === 'box') return { min: p.min, max: p.max }
  const k = AX[p.axis]
  const min: Vec3 = [p.base[0] - p.r, p.base[1] - p.r, p.base[2] - p.r]
  const max: Vec3 = [p.base[0] + p.r, p.base[1] + p.r, p.base[2] + p.r]
  min[k] = p.base[k] ?? 0
  max[k] = (p.base[k] ?? 0) + p.h
  return { min, max }
}

export function specBounds(prims: Prim[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const p of prims) {
    const b = primBounds(p)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] ?? 0, b.min[k] ?? 0)
      max[k] = Math.max(max[k] ?? 0, b.max[k] ?? 0)
    }
  }
  return prims.length ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] }
}

/** Frame for an axis: u and v across it, w along it, with u x v = w. */
function frame(axis: Axis): [Vec3, Vec3, Vec3] {
  if (axis === 'x') return [[0, 1, 0], [0, 0, 1], [1, 0, 0]]
  if (axis === 'y') return [[0, 0, 1], [1, 0, 0], [0, 1, 0]]
  return [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
}

/** Segments for a circle with about 0.02 mm chord error, 24 to 128. */
export function segmentsFor(r: number): number {
  const half = Math.acos(Math.max(-1, 1 - Math.min(1, 0.02 / Math.max(r, 1e-6))))
  return Math.min(128, Math.max(24, Math.ceil(Math.PI / Math.max(half, 1e-6))))
}

/** Closed, outward-facing meshes, one shell per primitive, in one part. */
export function primMesh(prims: Prim[], name: string): MeshPart {
  const pos: number[] = []
  const idx: number[] = []
  for (const p of prims) {
    const b = pos.length / 3
    if (p.kind === 'box') {
      const [x0, y0, z0] = p.min
      const [x1, y1, z1] = p.max
      for (const [px, py, pz] of [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] as const) pos.push(px, py, pz)
      for (const t of [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]] as const) idx.push(b + t[0], b + t[1], b + t[2])
      continue
    }
    const [u, w2, w] = frame(p.axis)
    const n = segmentsFor(p.r)
    const at = (a: number, h: number): void => {
      const c = Math.cos(a) * p.r
      const s = Math.sin(a) * p.r
      pos.push(p.base[0] + u[0] * c + w2[0] * s + w[0] * h, p.base[1] + u[1] * c + w2[1] * s + w[1] * h, p.base[2] + u[2] * c + w2[2] * s + w[2] * h)
    }
    for (let k = 0; k < n; k++) at((2 * Math.PI * k) / n, 0)
    for (let k = 0; k < n; k++) at((2 * Math.PI * k) / n, p.h)
    pos.push(p.base[0], p.base[1], p.base[2])
    pos.push(p.base[0] + w[0] * p.h, p.base[1] + w[1] * p.h, p.base[2] + w[2] * p.h)
    const cb = b + 2 * n
    const ct = cb + 1
    for (let k = 0; k < n; k++) {
      const i0 = b + k
      const i1 = b + ((k + 1) % n)
      idx.push(cb, i1, i0)
      idx.push(ct, i0 + n, i1 + n)
      idx.push(i0, i1, i1 + n)
      idx.push(i0, i1 + n, i0 + n)
    }
  }
  return { name, slot: 1, positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}

/** The solids in sx-geom `build` form. */
export function buildSolids(prims: Prim[]): GeomSolid[] {
  return prims.map((p) => {
    if (p.kind === 'box') return { type: 'box', min: p.min, max: p.max }
    return { type: 'cylinder', origin: p.base, axis: frame(p.axis)[2], diameterMm: 2 * p.r, heightMm: p.h }
  })
}

export interface PlannedThrough {
  hole: HoleInput
  /** Solid to subtract; null when the hole misses the part. */
  solid: GeomSolid | null
  lengthMm: number
}

/** Does the primitive's cross-section across `axis` contain the hole center? */
function crosses(p: Prim, axis: Axis, at: Vec3, r: number): boolean {
  const k = AX[axis]
  if (p.kind === 'cylinder' && p.axis === axis) {
    const others = [0, 1, 2].filter((j) => j !== k)
    return Math.hypot(...others.map((j) => (at[j] ?? 0) - (p.base[j] ?? 0))) + r <= p.r + 1e-6
  }
  const b = primBounds(p)
  return [0, 1, 2].filter((j) => j !== k).every((j) => (at[j] ?? 0) - r >= (b.min[j] ?? 0) - 1e-6 && (at[j] ?? 0) + r <= (b.max[j] ?? 0) + 1e-6)
}

/** Through holes: each runs from the high end of the primitives it crosses to past the low end. */
export function planHoles(prims: Prim[], holes: HoleInput[]): PlannedThrough[] {
  return holes.map((h) => {
    const at = v(h.atMm)
    const k = AX[h.axis]
    const r = h.diameterMm / 2
    const hit = prims.filter((p) => crosses(p, h.axis, at, r))
    if (hit.length === 0) return { hole: h, solid: null, lengthMm: 0 }
    const lo = Math.min(...hit.map((p) => primBounds(p).min[k] ?? 0))
    const hi = Math.max(...hit.map((p) => primBounds(p).max[k] ?? 0))
    const top: Vec3 = [at[0], at[1], at[2]]
    top[k] = hi
    const inward: Vec3 = [0, 0, 0]
    inward[k] = -1
    const len = round(hi - lo, 3)
    const cs = h.countersinkMm && h.countersinkMm > h.diameterMm ? { headMm: h.countersinkMm } : undefined
    return { hole: h, solid: holeSolid(top, inward, h.diameterMm, len + 1, cs), lengthMm: len }
  })
}
