// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The bed a plate slices for when no printer is selected, or the selected one matches no profile. The plate, the
// engine's printable area and the safety preflight all read it from here, so they cannot disagree.
import type { Bed, SettingValue } from '@slicerx/contracts'

export const GENERIC_BED: Readonly<Bed> = { widthMm: 256, depthMm: 256, heightMm: 256 }

/** The machine settings that describe a bed: its printable area from the origin and its printable height. */
export function bedSettings(bed: Bed): Record<string, SettingValue> {
  const { widthMm: w, depthMm: d } = bed
  return { printable_area: [[0, 0], [w, 0], [w, d], [0, d]], printable_height: bed.heightMm }
}
