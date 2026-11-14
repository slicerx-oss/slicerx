// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A sketch drawn on a frame whose v runs against normal x u, moved onto the frame the engine reads (v = normal x u):
// the same plane seen the other way round, so every v coordinate is negated and every turn goes the other way. The
// shape lands where the given frame put it, on both the mesh and the exact path, as the exact path already mirrors a
// step whose frame a mirrored design turned round (cad-history exact.ts, loops).

type Rec = Record<string, unknown>
type P2 = [number, number]

const flip = (p: unknown): unknown => (Array.isArray(p) && p.length === 2 ? ([p[0], -(p[1] as number) + 0] as P2) : p)
const neg = (n: unknown): unknown => (typeof n === 'number' ? -n + 0 : n)

/** Each field of a record that is a point or a turn, mirrored in v; the rest kept. */
function mirrored<T>(r: T, points: readonly string[], turns: readonly string[]): T {
  const out: Rec = { ...(r as Rec) }
  for (const k of points) if (k in out) out[k] = k === 'points' ? (out[k] as unknown[]).map(flip) : flip(out[k])
  for (const k of turns) if (k in out) out[k] = neg(out[k])
  return out as T
}

/** A segment of a chain mirrored in v: its points, its angles, and which way an arc of a given radius bends. */
function mirroredSegment<T>(g: T): T {
  const s = mirrored(g, ['to', 'points', 'center', 'through'], ['angleDeg', 'turnDeg', 'sweepDeg']) as Rec
  // an arc to a point at a radius bends the other way round; with no clockwise it was counterclockwise
  if (s['type'] === 'arc' && s['radiusMm'] !== undefined && s['to'] !== undefined) s['clockwise'] = !(s['clockwise'] ?? false)
  return s as T
}

/** A sketch loop (circle, ellipse, spline, points or a chain of segments) mirrored in v. */
export function mirroredLoop<T>(l: T): T {
  const r = l as Rec
  if (Array.isArray(r['segments'])) return { ...mirrored(l, ['start'], []), segments: (r['segments'] as unknown[]).map(mirroredSegment) } as T
  return mirrored(l, ['center', 'points'], ['angleDeg'])
}

export const mirroredLoops = <T>(loops: readonly T[]): T[] => loops.map(mirroredLoop)

/** Sketch points such as loft landmarks or a rail's path, mirrored in v. */
export const mirroredPoints = <T>(points: readonly T[]): T[] => points.map((p) => flip(p) as T)

/** A revolve axis in the sketch plane, mirrored in v. */
export const mirroredAxis = <T extends { point: unknown; direction: unknown }>(a: T): T => ({ ...a, point: flip(a.point), direction: flip(a.direction) })

/**
 * A shape's placement mirrored in v: the center mirrored and the turn the other way. A rectangle, circle, slot and
 * ellipse are each the same mirrored across their own width; a polygon is the same mirrored across its height
 * (sx-geom face.rs starts it on a flat bottom), so mirrored across its width it is turned half round.
 */
export function mirroredPlacement<T extends { center?: [number, number] | undefined; rotationDeg?: number | undefined }>(type: string, p: T | undefined): T | undefined {
  const turn = -(p?.rotationDeg ?? 0) + (type === 'polygon' ? 180 : 0) + 0
  if (!p && !turn) return undefined
  return { ...p, ...(p?.center ? { center: flip(p.center) } : {}), ...(turn || p?.rotationDeg !== undefined ? { rotationDeg: turn } : {}) } as T
}

/** Sketch constraints on mirrored loops: an angle from one line to another turns the other way; the rest keep. */
export function mirroredConstraints<T extends { type: string }>(cs: readonly T[]): T[] {
  return cs.map((c) => (c.type === 'angle' ? (mirrored(c, [], ['value']) as T) : c))
}
