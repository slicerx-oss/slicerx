// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where a design's body goes on the bed. A body whose lowest point is under the bed (from an arc that dips a little
// under its lowest line to a part built centered on z 0) is first lifted onto it: raised only, never lowered, so a
// part built standing above the bed stays where it is. A first body that then does not print where it was built (off
// the bed, or with what prints around it past the edge) moves once to the middle of the plate or the first free spot.
// An edit that takes a part that printed off the bed lands it again the same way, lifted first; a part already off the
// bed before the edit was parked there and stays, and so does a locked one. Opening a project lands nothing: a part
// saved under the bed shows where it was saved until a landing (a new body, an edit) lifts it. A landing moves the
// design as a whole: the host keeps the move in the design's history (History.placed), and the design's coordinates
// stay the ones it was built in (design-frame.ts). The rule is the same wherever designs are built (the app's plate,
// the creative eval); what counts as printing on the bed and where a part fits are the host's (its bed, margins and
// other objects), given as a BedLanding.
import type { Landed } from './host'
import type { Mat4 } from './model'

/** How a host reads its bed for parts `P` placed by a transform. */
export interface BedLanding<P> {
  /** True when the parts print where the transform puts them. */
  printsOnBed(parts: P, transform: Mat4): boolean
  /** Where the parts go when they do not: the middle of the bed or the first free spot. Null when nothing fits. */
  landOnBed(parts: P, transform: Mat4): Mat4 | null
  /** The lowest point of the parts where the transform puts them, mm above the bed; null for no parts. */
  lowest(parts: P, transform: Mat4): number | null
}

/** How far under the bed a part may reach and still stand on it, mm: STL coordinates are float32 (the app's arrange). */
export const UNDER_BED_TOL_MM = 0.01

const r2 = (v: number) => Math.round(v * 100) / 100

/** How far a landing moved a part, mm, in X and Y, and in Z when it lifted it. */
export function landShift(from: Mat4, to: Mat4): { dxMm: number; dyMm: number; dzMm?: number } {
  const dz = r2((to[14] ?? 0) - (from[14] ?? 0))
  return { dxMm: r2((to[12] ?? 0) - (from[12] ?? 0)), dyMm: r2((to[13] ?? 0) - (from[13] ?? 0)), ...(dz !== 0 ? { dzMm: dz } : {}) }
}

/** `transform` raised so the parts' lowest point is on the bed when it is under it; never lowered. */
export function liftedOnto<P>(parts: P, transform: Mat4, bed: BedLanding<P>): Mat4 {
  const at = [...transform]
  const z = bed.lowest(parts, at)
  if (z === null || z >= -UNDER_BED_TOL_MM) return at
  at[14] = (at[14] ?? 0) - z
  return at
}

const moves = (a: Mat4, b: Mat4) => a.some((v, i) => v !== b[i])

/**
 * Where a new body built at `transform` goes: where it was built when it prints there, lifted onto the bed when it
 * was under it, else where `bed` lands it. A body with no room anywhere stays where it was built, and says so.
 */
export function landNew<P>(parts: P, transform: Mat4, bed: BedLanding<P>): { transform: Mat4; moved?: Landed } {
  const at = liftedOnto(parts, transform, bed)
  if (bed.printsOnBed(parts, at)) return moves(at, transform) ? { transform: at, moved: landShift(transform, at) } : { transform: at }
  const to = bed.landOnBed(parts, at)
  if (!to) return { transform: [...transform], moved: { offBed: true } }
  return { transform: to, moved: landShift(transform, to) }
}

/**
 * For an edit that gives a part standing at `before.transform` new parts: the transform it lands at, when it moves,
 * and what happened. It lands again only when it printed on the bed before the edit (its old parts where it stands,
 * lifted onto the bed when they were under it) and with its new shape it no longer does: lifted when that is enough,
 * else moved as a new body is. A part saved under the bed so lifts at its first edit. A part already off the bed before
 * the edit was parked there, so it stays; so does a locked part, never lifted, or one with no room anywhere.
 */
export function landEdit<P>(before: { parts: P; transform: Mat4; locked?: boolean | undefined }, parts: P, bed: BedLanding<P>): { to?: Mat4; landed?: Landed } {
  const at = before.locked ? [...before.transform] : liftedOnto(parts, before.transform, bed)
  if (bed.printsOnBed(parts, at)) return moves(at, before.transform) ? { to: at, landed: { ...landShift(before.transform, at), edit: true } } : {}
  if (!bed.printsOnBed(before.parts, liftedOnto(before.parts, before.transform, bed))) return { landed: { offBed: true, edit: true, parked: true } }
  if (before.locked) return { landed: { offBed: true, edit: true, locked: true } }
  const to = bed.landOnBed(parts, at)
  return to ? { to, landed: { ...landShift(before.transform, to), edit: true } } : { landed: { offBed: true, edit: true } }
}
