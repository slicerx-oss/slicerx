// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Process settings that hold for the whole plate, so an object or a part cannot have its own. The list is data
// (plate-wide.json): a key goes on it unless our engine is confirmed to apply it per object, and scope.test checks it.
import type { SettingDef } from '@slicerx/contracts'
import keys from './plate-wide.json'

export const PLATE_WIDE: ReadonlySet<string> = new Set(keys)

/** Whether an object or a part can carry its own value for a setting. */
export function variesPerObject(def: Pick<SettingDef, 'key' | 'section'>): boolean {
  return def.section === 'process' && !PLATE_WIDE.has(def.key)
}
