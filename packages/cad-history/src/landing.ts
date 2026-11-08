// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where a design's body goes on the bed. A first body that does not print where it was built (off the bed, below it,
// or with what prints around it past the edge) moves once to the middle of the plate or the first free spot. An edit
// that takes a part that printed off the bed lands it again the same way; a part already off the bed before the edit
// was parked there and stays, and so does a locked one. A landing moves the design as a whole, as a placement: its
// coordinates stay the ones it was built in (Design.transform), and the host keeps the move (Design.placed), so a step
// given in the design's frame after a landing still meets its body. The rule is the same wherever designs are built
// (the app's plate, the creative eval); what counts as printing on the bed and where a part fits are the host's (its
// bed, margins and other objects), given as a BedLanding.
import type { Design, Landed } from './host'
import type { Mat4 } from './model'

/** How a host reads its bed for parts `P` placed by a transform. */
export interface BedLanding<P> {
  /** True when the parts print where the transform puts them. */
  printsOnBed(parts: P, transform: Mat4): boolean
  /** Where the parts go when they do not: the middle of the bed or the first free spot. Null when nothing fits. */
  landOnBed(parts: P, transform: Mat4): Mat4 | null
}

const r2 = (v: number) => Math.round(v * 100) / 100

/** `t` moved on the plate by `by` (mm in X and Y), or back by it with `back`. */
export function movedBy(t: Mat4, by: readonly [number, number] | undefined, back = false): Mat4 {
  const m = [...t]
  if (!by) return m
  const s = back ? -1 : 1
  m[12] = (m[12] ?? 0) + s * by[0]
  m[13] = (m[13] ?? 0) + s * by[1]
  return m
}

/** Where design `d` stands on the plate: its frame moved by the host's landings. */
export function placement(d: { transform: Mat4; placed?: Design['placed'] | undefined }): Mat4 {
  return movedBy(d.transform, d.placed)
}

/** The landing move `placed` adds up to after a landing from `from` to `to` (both on the plate). */
export function placedAfter(placed: readonly [number, number] | undefined, from: Mat4, to: Mat4): [number, number] {
  return [(placed?.[0] ?? 0) + (to[12] ?? 0) - (from[12] ?? 0), (placed?.[1] ?? 0) + (to[13] ?? 0) - (from[13] ?? 0)]
}

/** How far a landing moved a part, mm, in X and Y. */
export const landShift = (from: Mat4, to: Mat4) => ({ dxMm: r2((to[12] ?? 0) - (from[12] ?? 0)), dyMm: r2((to[13] ?? 0) - (from[13] ?? 0)) })

/**
 * Where a new body built at `transform` goes: where it was built when it prints there, else where `bed` lands it. A
 * body with no room anywhere stays where it was built, and says so.
 */
export function landNew<P>(parts: P, transform: Mat4, bed: BedLanding<P>): { transform: Mat4; moved?: Landed } {
  const at = [...transform]
  if (bed.printsOnBed(parts, at)) return { transform: at }
  const to = bed.landOnBed(parts, at)
  if (!to) return { transform: at, moved: { offBed: true } }
  return { transform: to, moved: landShift(transform, to) }
}

/**
 * For an edit that gives a part standing at `before.transform` new parts: the transform it lands at, when it moves,
 * and what happened. It lands again only when it printed on the bed before the edit (its old parts where it stands)
 * and with its new shape it no longer does. A part already off the bed before the edit was parked there, so it stays;
 * so does a locked part, or one with no room anywhere.
 */
export function landEdit<P>(before: { parts: P; transform: Mat4; locked?: boolean | undefined }, parts: P, bed: BedLanding<P>): { to?: Mat4; landed?: Landed } {
  const at = [...before.transform]
  if (bed.printsOnBed(parts, at)) return {}
  if (!bed.printsOnBed(before.parts, before.transform)) return { landed: { offBed: true, edit: true, parked: true } }
  if (before.locked) return { landed: { offBed: true, edit: true, locked: true } }
  const to = bed.landOnBed(parts, at)
  return to ? { to, landed: { ...landShift(before.transform, to), edit: true } } : { landed: { offBed: true, edit: true } }
}
