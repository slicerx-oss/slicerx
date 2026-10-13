// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The shown length unit for a field that keeps mm: its label, mm to shown and back, and the typed parse.
import { useApp } from '../state/store'
import { lengthText, parseLength, unitMm, type UnitPrefs } from './units'
import { currentValues } from './value-table'

export interface LengthView {
  units: UnitPrefs
  /** The unit beside the field: mm or in. */
  unit: string
  show: (mm: number) => number
  toMm: (shown: number) => number
  /** Typed text as a shown number: bare numbers in the shown unit, typed units as written. */
  parse: (text: string) => number
  /** Decimals for a scrub field in inches; undefined keeps the field's own. */
  digits: number | undefined
}

export function lengthView(units: UnitPrefs): LengthView {
  const k = unitMm(units)
  return {
    units,
    unit: units.length,
    show: (mm) => mm / k,
    toMm: (shown) => shown * k,
    parse: (text) => parseLength(text, units, currentValues()) / k,
    digits: units.length === 'in' ? units.inchDigits : undefined,
  }
}

export function useLength(): LengthView {
  return lengthView(useApp((s) => s.units))
}

/** Lengths as words in the display unit, "5 mm" or "0.197 in", for step names and readouts. */
export function useLengthWords(): (mm: number) => string {
  const units = useApp((s) => s.units)
  return (mm) => lengthText(mm, units)
}
