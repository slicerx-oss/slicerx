// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Exploded view in the scene: each part mesh of an object is drawn moved out from the others (setExplode). Only the
// part meshes move, inside their object's group, so the object's transform, its picking frame and everything the app
// reads stay as they are. The offsets come from @slicerx/contracts/explode, the same math the app link reports.
import { Box3, Matrix3, Vector3 } from 'three'
import { explodeOffsets, type ExplodeAxis, type PartBox, type Vec3 } from '@slicerx/contracts/explode'
import type { ObjectEntry } from './model'

export type { ExplodeAxis }

/** What setExplode draws: the objects spread apart, how far (0 to 100 percent) and along which axis. */
export interface ExplodeSpec {
  ids: readonly string[]
  spread: number
  axis: ExplodeAxis
  /**
   * How many of each object's first parts are spread, by id: the parts it prints. What follows them (modifier, blocker
   * and negative volumes) stays with the object. Every part when an object is left out.
   */
  parts?: Readonly<Record<string, number>>
}

/** Each part's box in bed coordinates (the object's group frame's parent), from its geometry and the object's transform. */
export function partBoxes(entry: ObjectEntry): PartBox[] {
  return entry.parts.map((p) => {
    const g = p.mesh.geometry
    if (!g.boundingBox) g.computeBoundingBox()
    const b = (g.boundingBox ?? new Box3()).clone().applyMatrix4(entry.group.matrix)
    return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] }
  })
}

/**
 * Moves the part meshes of `entry` by `spread` percent along `axis`, or back home at 0. Offsets are worked out in bed
 * coordinates and turned into the group's own frame, so a rotated or scaled object still spreads along the bed's axes.
 * Only the first `count` parts spread (the parts it prints); the rest stay home. Returns the offsets of those parts in bed
 * coordinates, mm, one per part.
 */
export function applyExplode(entry: ObjectEntry, spread: number, axis: ExplodeAxis, count = entry.parts.length): Vec3[] {
  const n = Math.max(0, Math.min(count, entry.parts.length))
  const spreadOf = n < 2 || spread <= 0 ? null : explodeOffsets(partBoxes(entry).slice(0, n), spread, axis)
  // parts past `count` (volumes) stay with the object
  const offsets = entry.parts.map((_, i): Vec3 => spreadOf?.[i] ?? [0, 0, 0])
  const toLocal = new Matrix3().setFromMatrix4(entry.group.matrix)
  const invertible = Math.abs(toLocal.determinant()) > 1e-12
  if (invertible) toLocal.invert()
  const v = new Vector3()
  entry.parts.forEach((p, i) => {
    const o = offsets[i]!
    if (!invertible || (o[0] === 0 && o[1] === 0 && o[2] === 0)) p.mesh.position.set(0, 0, 0)
    else p.mesh.position.copy(v.set(o[0], o[1], o[2]).applyMatrix3(toLocal))
    p.mesh.updateMatrix()
    p.mesh.matrixWorldNeedsUpdate = true
  })
  return offsets.slice(0, Math.max(n, 0))
}
