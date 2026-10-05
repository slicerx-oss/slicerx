// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print and filament settings a 3MF project carries, turned into changes on top of the current
// settings. A project file is untrusted (docs/safety.md): only plain numbers, switches and choices are
// taken. Text fields (G-code), scripts (`post_process`), network and credential keys, and the printer's
// own settings (its bed and limits) are left for the person's own printer to decide.
import type { PrintConfig, SettingValue } from '@slicerx/contracts'
import { importFlat, sameValue, settingDef } from '@slicerx/settings'

const TAKEN = new Set(['float', 'int', 'percent', 'bool', 'enum', 'floats', 'ints', 'percents', 'floatOrPercent', 'bools'])

export interface ProjectSettings {
  /** Changes against the current settings, in our keys. */
  values: Record<string, SettingValue>
  /** Keys left out on purpose: text, scripts, credentials, printer settings. */
  left: string[]
}

export function projectSettingChanges(raw: Record<string, unknown>, current: PrintConfig): ProjectSettings {
  const imported = importFlat(raw).config as Record<string, SettingValue>
  const now = current as unknown as Record<string, SettingValue | undefined>
  const values: Record<string, SettingValue> = {}
  const left: string[] = []
  for (const [key, value] of Object.entries(imported)) {
    const def = settingDef(key)
    if (!def || def.section === 'printer' || !TAKEN.has(def.type)) {
      left.push(key)
      continue
    }
    if (!sameValue(value, now[key])) values[key] = value
  }
  return { values, left }
}

/** A modifier's settings from a file: the same plain values only (no text, scripts, credentials or printer keys). */
export function modifierSettings(raw: Record<string, string>): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {}
  const config = importFlat(raw).config as Record<string, SettingValue>
  for (const [key, value] of Object.entries(config)) {
    const def = settingDef(key)
    if (def && def.section === 'process' && TAKEN.has(def.type)) out[key] = value
  }
  return out
}
