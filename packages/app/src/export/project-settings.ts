// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print and filament settings a 3MF project carries, turned into changes on top of the current
// settings. A project file is untrusted (docs/safety.md): only plain numbers, switches and choices are
// taken. Text fields (G-code), scripts (`post_process`), network and credential keys, and the printer's
// own settings (its bed and limits) are left for the person's own printer to decide.
import type { PrintConfig, SettingValue } from '@slicerx/contracts'
import { importFlat, sameValue, selectVariants, settingDef } from '@slicerx/settings'
import type { PlateEntry } from '../state/store'

// Plain numbers, percents, switches and choices, one or one per extruder or filament (overhang speeds are mm/s or %).
const TAKEN = new Set(['float', 'int', 'percent', 'bool', 'enum', 'floats', 'ints', 'percents', 'floatOrPercent', 'floatsOrPercents', 'bools', 'enums'])

export interface ProjectSettings {
  /** Changes against the current settings, in our keys. */
  values: Record<string, SettingValue>
  /** Keys left out on purpose: text, scripts, credentials, printer settings. */
  left: string[]
}

// Bambu Studio's per-variant values down to the ones that apply (shared with the MCP server's project reading).
export { selectVariants } from '@slicerx/settings'

export function projectSettingChanges(raw: Record<string, unknown>, current: PrintConfig): ProjectSettings {
  const imported = importFlat(selectVariants(raw)).config as Record<string, SettingValue>
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

/** The key and reason when the engine refuses a setting ("config key raft_first_layer_expansion: -1 is outside 0 to 100"). */
export function refusedSetting(message: string): { key: string; reason: string } | null {
  const m = /config key ([a-z0-9_]+): (.+)/.exec(message)
  return m ? { key: m[1]!, reason: m[2]!.trim() } : null
}

const omit = <V>(o: Record<string, V>, key: string): Record<string, V> => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key))

/** A plate entry without `key` in its part and modifier settings (the same entry when it has none). */
export function entryWithout<T extends Pick<PlateEntry, 'partSettings' | 'volumes'>>(e: T, key: string): T {
  const parts = e.partSettings !== undefined && Object.values(e.partSettings).some((p) => key in p)
  const vols = e.volumes?.some((v) => v.settings !== undefined && key in v.settings) === true
  if (!parts && !vols) return e
  return {
    ...e,
    ...(parts ? { partSettings: Object.fromEntries(Object.entries(e.partSettings!).map(([n, p]) => [n, omit(p, key)])) } : {}),
    ...(vols ? { volumes: e.volumes!.map((v) => (v.settings && key in v.settings ? { ...v, settings: omit(v.settings, key) } : v)) } : {}),
  }
}
