// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { LengthUnit, UnitPrefs } from './units'

export const MM_DIGITS = [0, 1, 2, 3] as const
export const INCH_DIGITS = [2, 3, 4] as const
export const INCH_FRACTIONS = [16, 32, 64] as const
export type UnitPrecision = { decimals: number } | { fraction: number }
export interface UnitChange { length?: LengthUnit | undefined; precision?: UnitPrecision | undefined }

export function unitPrecision(u: UnitPrefs): UnitPrecision {
  return u.length === 'in' && u.inchFraction ? { fraction: u.inchFraction } : { decimals: u.length === 'in' ? u.inchDigits : u.mmDigits }
}

/** The Settings controls' choices, applied together before changing the preference. */
export function withUnitSettings(before: UnitPrefs, change: UnitChange): UnitPrefs {
  const next = { ...before, ...(change.length ? { length: change.length } : {}) }
  const p = change.precision
  if (p && 'decimals' in p) {
    const choices: readonly number[] = next.length === 'mm' ? MM_DIGITS : INCH_DIGITS
    if (!choices.includes(p.decimals)) throw new Error(next.length === 'mm' ? 'Millimeters support 0 to 3 decimal places' : 'Inches support 2 to 4 decimal places')
    if (next.length === 'mm') next.mmDigits = p.decimals
    else { next.inchDigits = p.decimals; next.inchFraction = 0 }
  } else if (p) {
    if (next.length !== 'in' || !(INCH_FRACTIONS as readonly number[]).includes(p.fraction)) throw new Error('Fractions require inches and a denominator of 16, 32 or 64')
    next.inchFraction = p.fraction
  }
  return Object.keys(next).every((key) => next[key as keyof UnitPrefs] === before[key as keyof UnitPrefs]) ? before : next
}
