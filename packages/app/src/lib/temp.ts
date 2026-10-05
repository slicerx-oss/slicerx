// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Temperatures as people read them: a whole number and the degree sign, "250 °C". Every place
// that prints one goes through here so the sign is never missing.
import type { Temp } from '@slicerx/contracts'

export const DEG_C = '°C'

/** "250 °C". */
export function degC(c: number): string {
  return `${Math.round(c)} ${DEG_C}`
}

/** "210 / 220 °C" while heating, "25 °C" at rest. */
export function tempText(t: Temp): string {
  return t.target > 0 ? `${Math.round(t.current)} / ${Math.round(t.target)} ${DEG_C}` : degC(t.current)
}
