// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ScriptIdentity } from '@slicerx/contracts'
import { listPrinterProfiles } from './profiles'
import { printerForProfile } from './vendorparent'

/** Imported names are declarations to check, never a target selection. Ambiguity retains every match. */
export function scriptDeclarations(config: Record<string, unknown>, selected: ScriptIdentity, model?: string): ScriptIdentity[] {
  const declared: ScriptIdentity[] = []
  const raw = config.gcode_flavor
  const flavors = (Array.isArray(raw) ? (raw.length ? raw : [null]) : [raw === undefined ? selected.firmware : raw]).map((value) => typeof value === 'string' ? value : 'unknown')
  const firmware = flavors[0]!
  declared.push(...flavors.filter((value) => value !== selected.firmware).map((value) => ({ model: selected.model, firmware: value })))
  if (model) declared.push({ model, firmware })
  for (const key of ['printer_model', 'printer_settings_id', 'inherits']) {
    const value = config[key]
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (typeof entry !== 'string' || !entry.trim()) continue
      const name = entry.trim()
      const matches = new Set(listPrinterProfiles().filter((printer) => printer.id === name || printer.model === name || `${printer.vendor} ${printer.model}` === name).map((printer) => printer.id))
      const profile = printerForProfile(name)
      if (profile) matches.add(profile.printerId)
      if (!matches.size) matches.add(`unknown:${name}`)
      declared.push(...[...matches].map((model) => ({ model, firmware })))
    }
  }
  return declared
}
