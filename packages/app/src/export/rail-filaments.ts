// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The filaments a project save lists: every filament on the rail, in rail order, and any more the opened file listed,
// each with its own settings. A slice carries only the filaments up to the highest one a part prints, so a save of
// those alone left paint on another filament (filament 25 of 32, no part on it) without an entry in the file's
// per-filament lists, which other slicers read together by index.
import type { SettingValue } from '@slicerx/contracts'
import type { SettingsApi } from '../adapters/load'
import { slotConfig } from '../filament/slot-config'
import { MAX_SLOTS, resolveSlots, slotCount } from '../filament/slots'
import { inputOf, slotsOf } from '../state/profile-sync'
import { get, type AppState } from '../state/store'

const NIL = 'nil'
const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v)

export interface RailFilaments {
  /** How many filaments the save lists. */
  count: number
  /** The slot keys (colors, types, makers, flush matrix, tower) for all of them. */
  slotKeys: Record<string, SettingValue>
  /** A filament's own value of a per-filament key, as project files write it, for a filament the slice's settings leave out. */
  own(key: string, index: number, list: readonly unknown[], settings: Readonly<Record<string, unknown>>): unknown
}

/** The filaments a save lists: the rail's, and those the opened file has past the rail, so a reopen keeps them too. */
export function savedFilamentCount(s: Pick<AppState, 'printerSlots' | 'plates' | 'plate' | 'activePlate' | 'slotSetup' | 'layerMarks' | 'fileSlotColors'>): number {
  return Math.min(MAX_SLOTS, Math.max(slotCount(s), s.fileSlotColors.length))
}

type Layer = { values: Record<string, SettingValue>; filamentIds: string[] } | null
/** The last printer layer built for a save, by its inputs: autosave writes the project often, with the same rail. */
let cached: { key: string; layer: Promise<Layer> } | null = null

/** The printer's layer for every filament on the rail, as the slice's own layer is built for the filaments it prints. */
function railLayer(s: AppState, count: number): Promise<Layer> {
  const model = s.printerModel
  if (!model) return Promise.resolve(null)
  const slots = resolveSlots(s, count).map((r) => ({ type: r.type, ...(r.vendor ? { vendor: r.vendor } : {}), ...(r.family ? { family: r.family } : {}) }))
  const input = { ...inputOf(s, model, s.goal === 'custom' ? s.goalBase : s.goal), slots }
  const key = JSON.stringify(input)
  if (cached?.key !== key) {
    const layer = import('../adapters/profile').then((m) => m.buildProfileLayer(input)).then((l) => (l ? { values: l.values, filamentIds: l.filamentIds } : null), () => null)
    cached = { key, layer }
  }
  return cached.layer
}

/**
 * The rail's filaments for a save, at least `atLeast` of them, or null when the slice's settings list every one (the
 * save is then as before, so is the G-code of the file). The filaments the slice prints keep the values it slices
 * with, a list it gives shorter its last entry, which is what the engine prints them with; the others take their own
 * filament's values from the printer's layer, or without a printer, the last entry of each list.
 */
export async function railFilaments(api: SettingsApi, atLeast = 0): Promise<RailFilaments | null> {
  const s = get()
  const count = Math.min(MAX_SLOTS, Math.max(savedFilamentCount(s), atLeast))
  const sliced = slotsOf(s).length
  if (count <= sliced) return null
  const layer = await railLayer(s, count)
  const written = new Map<string, unknown[]>()
  const layerList = (key: string): unknown[] => {
    if (!written.has(key)) {
      const v = key === 'filament_ids' ? layer?.filamentIds : layer?.values[key]
      const def = api.settingDef(key)
      const o = v === undefined ? [] : def && key !== 'filament_ids' ? api.toOrca(def, v as SettingValue) : v
      written.set(key, Array.isArray(o) ? o : [o])
    }
    return written.get(key)!
  }
  const own = (key: string, index: number, list: readonly unknown[], settings: Readonly<Record<string, unknown>>): unknown => {
    if (!layer || index < sliced || !list.length) return undefined
    const mine = layerList(key)
    // A value the slice gives the filaments it prints other than their presets do (an Easy choice, a value set by hand,
    // one value for every filament) is the project's for every filament: the others take it too, as the last entry.
    for (let j = 0; j < sliced; j++) if (String(list[Math.min(j, list.length - 1)]) !== String(mine[j])) return undefined
    const v = mine[index]
    // A filament override the filament's preset leaves unset prints on the printer's value, which the file writes out.
    if (v === NIL) return first(settings[key.replace(/^filament_/, '')])
    return v
  }
  return { count, slotKeys: slotConfig(s, s.activePlate, count), own }
}
