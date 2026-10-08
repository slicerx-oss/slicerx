// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An opened project's objects on the bed the plate slices for. A project keeps its own layout where that layout fits
// the bed (on its own printer, or one as large). One laid out for a larger bed, or with objects off its plate, would
// open with objects off the bed, so each of its plates moves onto the bed as a group, keeping its layout, and is
// arranged when the group is wider or deeper than the bed. Objects already on the plate stay where they are.
import type { Bed, MeshPart } from '@slicerx/contracts'
import { arrange, ARRANGE_DEFAULTS, type ArrangeItem } from '../plate/arrange'
import { bounds, type Box } from '../plate/transform'

export interface Placeable {
  parts: readonly Pick<MeshPart, 'positions'>[]
  transform: number[]
}

export type Placement = 'kept' | 'moved' | 'arranged'

const TOL = 0.01

/** Inside the bed in X and Y. Height is the "too tall" check's, not placement's. */
function onBed(b: Box, bed: Pick<Bed, 'widthMm' | 'depthMm'>): boolean {
  return b.min[0] >= -TOL && b.min[1] >= -TOL && b.max[0] <= bed.widthMm + TOL && b.max[1] <= bed.depthMm + TOL
}

function boxOf(objects: readonly Placeable[]): Box | null {
  const boxes = objects.map((o) => bounds(o.parts, o.transform)).filter((b): b is Box => b !== null)
  if (!boxes.length) return null
  return {
    min: [Math.min(...boxes.map((b) => b.min[0])), Math.min(...boxes.map((b) => b.min[1])), Math.min(...boxes.map((b) => b.min[2]))],
    max: [Math.max(...boxes.map((b) => b.max[0])), Math.max(...boxes.map((b) => b.max[1])), Math.max(...boxes.map((b) => b.max[2]))],
  }
}

/**
 * Puts one plate's opened `objects` on `bed`, changing their transforms in place. `existing` are objects already on
 * that plate: they stay, and opened objects off the bed are arranged around them.
 */
export function placeOnSelectedBed(objects: readonly Placeable[], bed: Bed, existing: readonly Placeable[] = []): Placement {
  const all = boxOf(objects)
  if (!all || objects.every((o) => {
    const b = bounds(o.parts, o.transform)
    return !b || onBed(b, bed)
  })) return 'kept'
  if (existing.length === 0) {
    // The group to the bed's center, keeping how its objects sit to each other.
    const dx = bed.widthMm / 2 - (all.min[0] + all.max[0]) / 2
    const dy = bed.depthMm / 2 - (all.min[1] + all.max[1]) / 2
    for (const o of objects) {
      o.transform[12] = o.transform[12]! + dx
      o.transform[13] = o.transform[13]! + dy
    }
    if (onBed(boxOf(objects)!, bed)) return 'moved'
  }
  // Too wide or deep for the bed as laid out, or onto a plate with objects: arranged, what does not fit staying put.
  const off = objects.filter((o) => {
    const b = bounds(o.parts, o.transform)
    return b !== null && !onBed(b, bed)
  })
  const items: ArrangeItem[] = off.map((o, i) => ({ id: String(i), parts: o.parts, transform: o.transform }))
  const fixed: ArrangeItem[] = [...existing, ...objects.filter((o) => !off.includes(o))].map((o, i) => ({ id: `f${i}`, parts: o.parts, transform: o.transform }))
  const r = arrange(items, fixed, bed, ARRANGE_DEFAULTS)
  off.forEach((o, i) => {
    const t = r.transforms[String(i)]
    if (t) o.transform.splice(0, 16, ...t)
  })
  return 'arranged'
}
