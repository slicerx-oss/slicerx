// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Selection helpers for the object list and the selection bar: a Shift range, everything on one filament, and what a
// selection holds. React-free; the store writes stay in plate/edit.ts.
import { effectiveSlot } from '../filament/slots'
import type { PlateEntry } from '../state/store'

/**
 * The ids from `anchor` to `target` in list order, both included. Without an anchor in the list, the target alone.
 */
export function rangeSelect(order: readonly string[], anchor: string | null, target: string): string[] {
  const b = order.indexOf(target)
  if (b < 0) return []
  const a = anchor === null ? -1 : order.indexOf(anchor)
  if (a < 0) return [target]
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return order.slice(lo, hi + 1)
}

/** The objects with a part on `slot`, a filament picked in the object list included. */
export function selectByFilament(plate: readonly Pick<PlateEntry, 'id' | 'parts' | 'slotOverrides'>[], slot: number): string[] {
  return plate.filter((p) => p.parts.some((part) => effectiveSlot(p, part) === slot)).map((p) => p.id)
}

export interface SelectionSummary {
  count: number
  names: string[]
  /** Every selected object is locked, or every one prints, and so on: the bar's toggles read these. */
  allLocked: boolean
  allSkipped: boolean
}

export function selectionSummary(plate: readonly Pick<PlateEntry, 'id' | 'name' | 'locked' | 'printable'>[], ids: readonly string[]): SelectionSummary {
  const picked = plate.filter((p) => ids.includes(p.id))
  return {
    count: picked.length,
    names: picked.map((p) => p.name),
    allLocked: picked.length > 0 && picked.every((p) => p.locked === true),
    allSkipped: picked.length > 0 && picked.every((p) => p.printable === false),
  }
}
