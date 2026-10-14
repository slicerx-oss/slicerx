// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which faces of a part are the inside of its walls, how thick each wall is, and how far to push each face for a new
// thickness. A wall is a flat, axis-aligned inner face (inside the part's bounds on its own axis) with a parallel face
// facing the other way behind it; the gap between them is its thickness.
import type { FaceSummary, V3 } from '../geom_common/faces'

export type WallKind = 'wall' | 'floor'

export interface WallTarget {
  kind: WallKind
  /** The face to push, as listed: a point on it, its normal and a triangle. */
  at: V3
  normal: V3
  triangle: number
  /** Where its plane sits along its normal axis, mm. */
  pos: number
  axis: 0 | 1 | 2
  sign: 1 | -1
  thicknessMm: number
  /** How far to move the face along its normal: more than 0 thickens the wall. */
  deltaMm: number
}

export interface WallPlanOptions {
  which: 'walls' | 'floor' | 'both'
  /** The new thickness; or `byMm`, the change. */
  wallMm?: number
  byMm?: number
}

/** The thinnest wall a plan may leave, mm. */
export const MIN_WALL_MM = 0.4
/** Faces smaller than this share of the largest inner face are features (holes, ribs), not walls. */
const MIN_SHARE = 0.02
const EPS = 0.01

function axisOf(n: V3): { axis: 0 | 1 | 2; sign: 1 | -1 } | null {
  for (const k of [0, 1, 2] as const) if (Math.abs(n[k]) > 0.9999) return { axis: k, sign: n[k] > 0 ? 1 : -1 }
  return null
}

/** The faces to push and by how much, or an error a person can act on. */
export function planWalls(faces: readonly FaceSummary[], bounds: { min: V3; max: V3 }, o: WallPlanOptions): { targets: WallTarget[] } | { error: string } {
  const flat = faces.flatMap((f) => {
    const a = axisOf(f.normal)
    return a ? [{ f, ...a, pos: f.at[a.axis] }] : []
  })
  // inner: off the part's outside on the side it faces
  const inner = flat.filter((x) => Math.abs(x.pos - (x.sign > 0 ? bounds.max[x.axis] : bounds.min[x.axis])) > EPS)
  const kindOf = (x: (typeof flat)[number]): WallKind | null => (x.axis !== 2 ? 'wall' : x.sign > 0 ? 'floor' : null)
  const wanted = inner.filter((x) => {
    const k = kindOf(x)
    return k !== null && (o.which === 'both' || (o.which === 'walls' ? k === 'wall' : k === 'floor'))
  })
  const largest = Math.max(0, ...wanted.map((x) => x.f.areaMm2))
  const targets: WallTarget[] = []
  for (const x of wanted) {
    if (x.f.areaMm2 < largest * MIN_SHARE) continue
    // the outside of this wall: the nearest face behind it, facing the other way
    const opposite = flat.filter((g) => g.axis === x.axis && g.sign === -x.sign)
    const behind = opposite.map((g) => x.sign * (x.pos - g.pos)).filter((d) => d > EPS)
    if (!behind.length) continue
    const thicknessMm = Math.min(...behind)
    const deltaMm = o.wallMm !== undefined ? o.wallMm - thicknessMm : (o.byMm ?? 0)
    if (Math.abs(deltaMm) < 1e-3) continue
    // the room in front: the nearest face across the opening, facing back
    const ahead = opposite.map((g) => x.sign * (g.pos - x.pos)).filter((d) => d > EPS)
    const roomMm = ahead.length ? Math.min(...ahead) : Infinity
    if (thicknessMm + deltaMm < MIN_WALL_MM) return { error: `that leaves a ${round(thicknessMm + deltaMm)} mm ${kindOf(x) === 'floor' ? 'floor' : 'wall'}; the thinnest is ${MIN_WALL_MM} mm` }
    if (deltaMm > 0 && 2 * deltaMm > roomMm - MIN_WALL_MM) return { error: `there is only ${round(roomMm)} mm of room inside, so the walls can grow at most ${round((roomMm - MIN_WALL_MM) / 2)} mm` }
    targets.push({ kind: kindOf(x) as WallKind, at: x.f.at, normal: x.f.normal, triangle: x.f.triangle, pos: x.pos, axis: x.axis, sign: x.sign, thicknessMm: round(thicknessMm), deltaMm: round(deltaMm) })
  }
  if (!targets.length) return { error: o.wallMm !== undefined && wanted.length ? `the ${o.which === 'floor' ? 'floor is' : 'walls are'} already ${o.wallMm} mm` : `no flat ${o.which === 'floor' ? 'floor' : 'walls'} to change: this works on flat, square-on walls with an inside and an outside` }
  // floors last, so the walls they meet are already in place
  return { targets: targets.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'floor' ? 1 : -1)) }
}

/** The listed face that is `t` now, after earlier pushes moved other faces: same normal, same plane, nearest to it. */
export function findTarget(faces: readonly FaceSummary[], t: WallTarget): FaceSummary | undefined {
  const near = (f: FaceSummary) => (f.center[0] - t.at[0]) ** 2 + (f.center[1] - t.at[1]) ** 2 + (f.center[2] - t.at[2]) ** 2
  return faces
    .filter((f) => Math.abs(f.normal[t.axis] - t.sign) < 1e-4 && Math.abs(f.at[t.axis] - t.pos) < 1e-3)
    .sort((a, b) => b.areaMm2 - a.areaMm2 || near(a) - near(b))[0]
}

const round = (v: number): number => Math.round(v * 1000) / 1000
