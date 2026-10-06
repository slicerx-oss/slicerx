// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How loose a fit should be, per side, for everything that asks: the fit check, cut connectors, and the hole
// tools. Half the clearance the hole tolerance test measured for this filament, printer and nozzle (the first
// used slot that has one), else half the nozzle, with a sentence that says which.
import { measuredHoleClearance, tuneContext } from '../calibration/tuned'
import { resolveSlots } from '../filament/slots'
import { gapFromHoleTolerance } from '../geom/cad'
import type { get } from '../state/store'

export interface Clearance {
  /** Per side, mm. */
  mm: number
  /** From the hole tolerance test, not the nozzle. */
  measured: boolean
  /** Where the number came from, for the field that shows it. */
  words: string
}

const mm2 = (v: number) => `${v.toFixed(2)} mm`

export function clearanceFor(s: ReturnType<typeof get>): Clearance {
  const { printerId, nozzleMm } = tuneContext(s)
  for (const slot of resolveSlots(s)) {
    const measured = measuredHoleClearance(s.userPresets, slot, printerId, nozzleMm)
    if (measured === undefined) continue
    const mm = gapFromHoleTolerance(measured)
    const on = slot.type ? ` on ${slot.brand ? `${slot.brand} ` : ''}${slot.type}` : ''
    return { mm, measured: true, words: `${mm2(mm)} a side, from your hole test${on} with this printer and its ${nozzleMm} mm nozzle.` }
  }
  const mm = Math.max(0.1, nozzleMm / 2)
  return {
    mm,
    measured: false,
    words: `${mm2(mm)} a side, half the ${nozzleMm} mm nozzle. Print the hole tolerance test for a fit measured on this printer.`,
  }
}
