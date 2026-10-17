// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { appUnitInputs, type AppUnits } from '@slicerx/mcp/toolset'
import { unitPrecision, withUnitSettings } from '../cad/unit-settings'
import { unitMm } from '../cad/units'
import { editionHasCad } from '../edition'
import { get, set } from '../state/store'
import { LinkError } from './methods-error'

export function read(args: Record<string, unknown>): AppUnits {
  const parsed = appUnitInputs.get.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  const units = get().units
  return { available: editionHasCad(), ...units, precision: unitPrecision(units), millimetersPerUnit: unitMm(units), dataUnit: 'mm' }
}

export function change(args: Record<string, unknown>): AppUnits {
  const parsed = appUnitInputs.set.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  if (!editionHasCad()) throw new LinkError('refused', 'This edition does not offer Model display units')
  const before = get().units
  let next
  try { next = withUnitSettings(before, parsed.data) }
  catch (e) { throw new LinkError('invalid_input', e instanceof Error ? e.message : String(e)) }
  if (next !== before) set({ units: next })
  return read({})
}
