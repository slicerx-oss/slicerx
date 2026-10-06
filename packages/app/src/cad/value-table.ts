// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The project's named values as numbers right now: the table (state.namedValues) resolved with the built-ins,
// `clearance` (the measured fit a side, plate/clearance.ts) and `nozzle` (the printer's nozzle, mm).
import { tuneContext } from '../calibration/tuned'
import { clearanceFor } from '../plate/clearance'
import { get } from '../state/store'
import { evaluate, resolveValues } from './values'

export function builtIns(s: ReturnType<typeof get>): Record<string, number> {
  return { clearance: clearanceFor(s).mm, nozzle: tuneContext(s).nozzleMm }
}

export function valueTable(s: ReturnType<typeof get> = get()): ReturnType<typeof resolveValues> {
  return resolveValues(s.namedValues, builtIns(s))
}

export function currentValues(): Record<string, number> {
  return valueTable().values
}

/** A typed number: a plain one, or an expression over the named values. NaN when it does not read. */
export function typedNumber(text: string): number {
  const plain = Number(text.trim().replace(',', '.'))
  if (Number.isFinite(plain) && text.trim() !== '') return plain
  try {
    const values = currentValues()
    return evaluate(text, (n) => values[n])
  } catch {
    return NaN
  }
}
