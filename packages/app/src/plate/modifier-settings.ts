// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { SettingDef, SettingValue } from '@slicerx/contracts'
import { checkValues, settingDef } from '@slicerx/settings'
import { settingEditValue } from './setting-edit-value'

const GROUPS = new Set(['strength', 'speed', 'quality', 'extrusion'])
const TYPES = new Set(['float', 'int', 'percent', 'bool', 'enum', 'floats', 'ints', 'percents', 'floatOrPercent'])

/** The same print keys offered by the modifier's settings panel. */
export function modifierSetting(def: Pick<SettingDef, 'section' | 'type' | 'group'>): boolean {
  return def.section === 'process' && TYPES.has(def.type) && GROUPS.has(def.group)
}

export function modifierDefinition(key: string): SettingDef {
  const def = settingDef(key)
  if (!def || !modifierSetting(def)) throw new Error(`${key} is not a modifier print setting`)
  return def
}

/** Validate the complete patch before changing any volume. */
export function modifierValues(values: Record<string, unknown>): Record<string, SettingValue> {
  const typed: Record<string, SettingValue> = {}
  for (const [key, value] of Object.entries(values)) {
    typed[key] = settingEditValue(modifierDefinition(key), value)
  }
  const errors = checkValues(typed).filter((e) => e.severity === 'error' || e.code === 'unknown_key' || e.code === 'enum_value_unavailable')
  if (errors.length) throw new Error(errors.map((e) => e.message).join('; '))
  return typed
}
