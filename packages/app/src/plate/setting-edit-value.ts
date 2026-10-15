// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { SettingDef, SettingValue } from '@slicerx/contracts'
import { coerce, isVectorType } from '@slicerx/settings'

/** Explicit edits must not truncate counts, discard values or store nonfinite numbers. */
export function settingEditValue(def: SettingDef, raw: unknown): SettingValue {
  const items = Array.isArray(raw) ? raw : [raw]
  if (items.length > 256 || items.some((v) => !['string', 'number', 'boolean'].includes(typeof v) || typeof v === 'string' && v.length > 500)) throw new Error(`${def.key} needs plain setting values`)
  if (items.length === 0 || (!isVectorType(def.type) && items.length !== 1)) throw new Error(`${def.key} has the wrong number of values`)
  // Profile imports may truncate counts; an explicit edit must preserve the requested number.
  if ((def.type === 'int' || def.type === 'ints') && items.some((v) => typeof v === 'boolean' || !Number.isInteger(Number(v)))) throw new Error(`${def.key} needs whole numbers`)
  const converted = coerce(def, raw)
  if (converted.ok !== true) throw new Error(`${def.key} has an invalid value; use clear to restore its inherited value`)
  const values = Array.isArray(converted.value) ? converted.value : [converted.value]
  if (values.some((v) => typeof v === 'number' && !Number.isFinite(v) || typeof v === 'string' && ['floatOrPercent', 'floatsOrPercents'].includes(def.type) && !Number.isFinite(Number(v.replace(/%$/, ''))))) throw new Error(`${def.key} needs finite values`)
  const lo = def.orcaMin === undefined ? def.min : def.orcaMin
  if (lo !== undefined && lo !== null && lo >= 0 && values.some((v) => typeof v === 'string' && v.endsWith('%') && Number(v.slice(0, -1)) < 0)) throw new Error(`${def.key} cannot be a negative percent`)
  return converted.value
}
