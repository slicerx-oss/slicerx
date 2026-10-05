// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The layer height picker: fixed heights, then sleipnir (adaptive layer height) as the last option.
// Choosing sleipnir turns the adaptive switch on and keeps the base layer height; choosing a fixed
// height sets Detail to that height and turns the switch off. Stored keys are unchanged.
import type { EasySettings } from '@slicerx/contracts'

/** Fixed heights offered, in mm, on a 0.4 mm nozzle (the Detail control's 0.28 to 0.08 range). */
export const FIXED_HEIGHTS = [0.08, 0.12, 0.16, 0.2, 0.24, 0.28] as const
export const SLEIPNIR = 'sleipnir'
export type LayerChoice = (typeof FIXED_HEIGHTS)[number] | typeof SLEIPNIR

export const SLEIPNIR_LINE = 'Thinner layers where steps would show, your layer height elsewhere'

/** Detail (0 to 100) that gives a fixed height: 0 is 0.28 mm, 100 is 0.08 mm. */
export function detailForHeight(mm: number): number {
  return Math.min(100, Math.max(0, Math.round(((0.28 - mm) / 0.2) * 100)))
}

/** The Easy settings a choice writes. */
export function choicePatch(choice: LayerChoice): Partial<EasySettings> {
  if (choice === SLEIPNIR) return { varyLayerHeight: true }
  return { varyLayerHeight: false, detail: detailForHeight(choice) }
}

/** What the picker shows chosen: sleipnir when the switch is on, else the fixed height when it is one of the list, else null (a custom height). */
export function chosenFrom(vary: boolean, layerMm: number): LayerChoice | null {
  if (vary) return SLEIPNIR
  return FIXED_HEIGHTS.find((h) => Math.abs(h - layerMm) < 0.005) ?? null
}
