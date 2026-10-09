// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print and filament settings a 3MF project carries, turned into changes on top of the current
// settings. A project file is untrusted (docs/safety.md): only plain numbers, switches and choices are
// taken. Text fields (G-code), scripts (`post_process`), network and credential keys, and the printer's
// own settings (its bed and limits) are left for the person's own printer to decide.
import type { PrintConfig, SettingValue } from '@slicerx/contracts'
import { importFlat, sameValue, settingDef } from '@slicerx/settings'
import type { PlateEntry } from '../state/store'

// Plain numbers, percents, switches and choices, one or one per extruder or filament (overhang speeds are mm/s or %).
const TAKEN = new Set(['float', 'int', 'percent', 'bool', 'enum', 'floats', 'ints', 'percents', 'floatOrPercent', 'floatsOrPercents', 'bools', 'enums'])

export interface ProjectSettings {
  /** Changes against the current settings, in our keys. */
  values: Record<string, SettingValue>
  /** Keys left out on purpose: text, scripts, credentials, printer settings. */
  left: string[]
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])

/**
 * The project's settings with Bambu Studio's per-variant values down to the ones that apply. Bambu Studio 2 writes some
 * process values once per extruder and hotend variant (`print_extruder_id` and `print_extruder_variant`: standard, high
 * flow, TPU) and some filament values once per filament and variant (`filament_extruder_variant`). The one that slices
 * is each extruder's own variant, its `extruder_type` and `nozzle_volume_type` ("Direct Drive Standard"): a process
 * value becomes one per extruder, a filament value one per filament.
 */
export function selectVariants(raw: Record<string, unknown>): Record<string, unknown> {
  const ids = list(raw['print_extruder_id'])
  const pv = list(raw['print_extruder_variant'])
  const fv = list(raw['filament_extruder_variant'])
  const types = list(raw['extruder_type'])
  const volumes = list(raw['nozzle_volume_type'])
  const filaments = list(raw['filament_settings_id']).length || list(raw['filament_colour']).length
  const extruders = [...new Set(ids)].sort((a, b) => Number(a) - Number(b))
  const active = (e: number): string => `${types[e] ?? types[0] ?? 'Direct Drive'} ${volumes[e] ?? volumes[0] ?? 'Standard'}`
  const out: Record<string, unknown> = { ...raw }
  const skip = new Set(['print_extruder_id', 'print_extruder_variant', 'filament_extruder_variant', 'printer_extruder_id', 'printer_extruder_variant'])
  for (const [k, v] of Object.entries(raw)) {
    if (!Array.isArray(v) || skip.has(k)) continue
    if (pv.length > extruders.length && extruders.length > 0 && v.length === pv.length && ids.length === pv.length) {
      out[k] = extruders.map((id, e) => {
        const at = pv.findIndex((name, i) => ids[i] === id && name === active(e))
        return v[at >= 0 ? at : ids.indexOf(id)]
      })
    } else if (filaments > 0 && fv.length > filaments && fv.length % filaments === 0 && v.length === fv.length) {
      const per = fv.length / filaments
      out[k] = Array.from({ length: filaments }, (_, f) => {
        const j = fv.slice(f * per, f * per + per).indexOf(active(0))
        return v[f * per + (j >= 0 ? j : 0)]
      })
    }
  }
  return out
}

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
