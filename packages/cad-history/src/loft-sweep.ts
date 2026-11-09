// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The loft and sweep steps as data, built in one place so Model's Loft and Sweep panels and the design tools a client
// calls record exactly the same sketch.loft and sweep steps. Each step keeps its own copy of the loops it was made
// from; nothing links back to a timeline sketch. Also the check that a sweep profile sits on the path's start.
import type { LoftProfile, StepParams, SweepPath, Thicken } from './model'
import type { FaceFrame, SketchLoop, Vec3 } from './types'

export type SolidOperation = 'new' | 'join' | 'cut'

/** A deep copy as plain JSON: undefined fields go, and nothing is shared with the caller. */
const plain = <T>(v: unknown): T => JSON.parse(JSON.stringify(v)) as T

/**
 * A loft's profiles and options. The profiles and the shell are copied as plain JSON, so a caller may pass them as its
 * own parser typed them (the design tools' schemas), as long as they have the shape of LoftProfile and Thicken.
 */
export interface LoftOptions {
  /** In loft order. */
  profiles: readonly (LoftProfile | object)[]
  smooth?: boolean | undefined
  closed?: boolean | undefined
  thicken?: Thicken | object | undefined
  operation?: SolidOperation | undefined
  name?: string | undefined
}

/** The sketch.loft step for these profiles and options: smooth and closed only when on. */
export function loftParams(o: LoftOptions): StepParams {
  return plain({ op: 'sketch.loft', profiles: o.profiles, ...(o.smooth ? { smooth: true } : {}), ...(o.closed ? { closed: true } : {}), ...(o.thicken ? { thicken: o.thicken } : {}), operation: o.operation, name: o.name })
}

/** A sweep's profile, path and options, copied as plain JSON like LoftOptions. */
export interface SweepOptions {
  profile: LoftProfile | object
  path: SweepPath | object
  thicken?: Thicken | object | undefined
  /** the size at the end of the path against the start */
  scaleEnd?: number | readonly [number, number] | undefined
  /** the turn about the path by its end, degrees */
  twistDeg?: number | undefined
  ease?: 'linear' | 'smooth' | undefined
  operation?: SolidOperation | undefined
  name?: string | undefined
}

/** The sketch.sweep step for this profile, path and options: the taper, twist and ease only when they change it. */
export function sweepParams(o: SweepOptions): StepParams {
  return plain({ op: 'sketch.sweep', profile: o.profile, path: o.path, ...(o.thicken ? { thicken: o.thicken } : {}), ...(o.scaleEnd !== undefined && o.scaleEnd !== 1 ? { scaleEnd: o.scaleEnd } : {}), ...(o.twistDeg ? { twistDeg: o.twistDeg } : {}), ...(o.ease === 'smooth' ? { ease: o.ease } : {}), operation: o.operation, name: o.name })
}

const BED: Pick<FaceFrame, 'origin' | 'u' | 'v'> = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] }

/** Where an open path loop starts, on the bed: its first point mapped through its frame. */
export function loopStart(frame: FaceFrame | undefined, l: SketchLoop): Vec3 | undefined {
  const q = 'start' in l ? l.start : 'points' in l ? l.points[0] : undefined
  if (!q) return undefined
  const f = frame ?? BED
  return [0, 1, 2].map((k) => f.origin[k]! + f.u[k]! * q[0] + f.v[k]! * q[1]) as Vec3
}

/** Where a sweep path starts, on the bed: its first point, or the start of its first loop. */
export function pathStart(path: SweepPath): Vec3 | undefined {
  if (path.points?.length) return [...path.points[0]!] as Vec3
  const first = path.loops?.find((l) => !l.construction)
  return first ? loopStart(path.frame, first) : undefined
}

/**
 * How far a sweep profile sits from where the path starts, in mm, when that is too far to be meant as on it; null when
 * it is near enough. The profile is carried as it sits, so one drawn away from the path's start sweeps from there,
 * and every bend then reads as too tight. "Near enough" is three times the profile's half size, and at least 10 mm,
 * from the middle of its loops to the start.
 */
export function profileOffPathMm(frame: FaceFrame | undefined, loops: readonly SketchLoop[], start: Vec3): number | null {
  const f = frame ?? BED
  const uv: [number, number][] = []
  for (const l of loops) {
    if ('type' in l && l.type === 'circle') {
      const r = l.diameterMm / 2
      uv.push([l.center[0] - r, l.center[1] - r], [l.center[0] + r, l.center[1] + r])
    } else if ('points' in l) uv.push(...l.points.map((q) => [q[0], q[1]] as [number, number]))
    else if ('start' in l) {
      uv.push([l.start[0], l.start[1]])
      for (const g of l.segments) {
        if ('to' in g && g.to) uv.push([g.to[0], g.to[1]])
        if ('points' in g) for (const q of g.points) uv.push([q[0], q[1]])
      }
    }
  }
  if (!uv.length) return null
  const lo = [Math.min(...uv.map((q) => q[0])), Math.min(...uv.map((q) => q[1]))]
  const hi = [Math.max(...uv.map((q) => q[0])), Math.max(...uv.map((q) => q[1]))]
  const c = [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2]
  const size = Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!) / 2
  const at = [0, 1, 2].map((k) => f.origin[k]! + f.u[k]! * c[0]! + f.v[k]! * c[1]!)
  const off = Math.hypot(at[0]! - start[0], at[1]! - start[1], at[2]! - start[2])
  return off <= Math.max(3 * size, 10) ? null : off
}
