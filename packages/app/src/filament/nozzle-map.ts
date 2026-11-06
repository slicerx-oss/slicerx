// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which nozzle prints each filament on a printer with two extruders fed by their own AMS (Bambu Lab H2D, H2C):
// the plate's filament map. By default the slicer picks it (each filament where it flushes least, as Bambu Studio's
// "Auto For Flush" does) and reports it with the slice; a plate can set it by hand, slot by slot. The hand-set map
// reaches the engine as `filament_map_mode` Manual and `filament_map`, and the project file as Bambu Studio writes it.
// A printer whose hotends are its tools (the Bambu Lab H3C, nine hotends on one extruder) has a map of tools instead:
// each filament on a tool of its own, set by hand as `filament_nozzle_map`.
import type { FilamentMapInfo, SettingValue } from '@slicerx/contracts'
import { autoHotends, hotendCount, hotendMapProblem, hotendRows, type HotendRow } from '@slicerx/settings/hotends'
import { get, markStale, set, type AppState, type PlateMeta } from '../state/store'

const list = (v: SettingValue | unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v])

/** The printer's extruders when it is one with a filament map (a Bambu Lab printer with two), else 0. */
export function mapExtruders(cfg: Record<string, unknown>): number {
  const nozzles = list(cfg['nozzle_diameter']).length
  const model = String(list(cfg['printer_model'])[0] ?? '')
  const semm = list(cfg['single_extruder_multi_material'])[0]
  const shared = semm === undefined || semm === true || semm === 1 || semm === '1' || semm === 'true'
  return nozzles === 2 && model.startsWith('Bambu Lab') && shared ? 2 : 0
}

/** True when the printer's right extruder takes hotends from a rack (the H2C). */
export function hasRack(cfg: Record<string, unknown>): boolean {
  return list(cfg['extruder_max_nozzle_count']).some((n) => Number(n) > 1)
}

/** The master extruder (1-based), which a filament the map leaves out prints with. */
export function masterExtruder(cfg: Record<string, unknown>): number {
  const m = Number(list(cfg['master_extruder_id'])[0])
  return m === 1 || m === 2 ? m : 1
}

/** The extruder of each slot (index slot - 1) the plate prints with: its own map, else what the last slice picked. */
export function currentMap(meta: Pick<PlateMeta, 'settings'> | undefined, picked: FilamentMapInfo | undefined, slots: number, master: number): number[] {
  const own = meta?.settings.nozzleMap
  return Array.from({ length: slots }, (_, i) => own?.[i] ?? picked?.extruders[i] ?? master)
}

/** The engine's settings for a plate's map: nothing when the slicer picks it. */
export function nozzleMapConfig(meta: Pick<PlateMeta, 'settings'> | undefined): Record<string, string | number[]> {
  const own = meta?.settings.nozzleMap
  if (!own?.length) return {}
  return { filament_map_mode: 'Manual', filament_map: [...own] }
}

function patchPlate(plateId: string, map: number[] | null): void {
  set((s: AppState) => ({
    plates: s.plates.map((p) => {
      if (p.id !== plateId) return p
      const { nozzleMap: _old, ...rest } = p.settings
      return { ...p, settings: map ? { ...rest, nozzleMap: map } : rest }
    }),
  }))
  markStale()
}

/** Back to the slicer's pick. */
export function setNozzleAuto(plateId: string): void {
  patchPlate(plateId, null)
}

/** Sets slot `slot` (1-based) to `extruder` (1 left, 2 right); the other slots keep what they print with now. */
export function setSlotNozzle(plateId: string, slot: number, extruder: number, current: readonly number[]): void {
  if (slot < 1 || (extruder !== 1 && extruder !== 2)) return
  const map = current.slice()
  while (map.length < slot) map.push(current[current.length - 1] ?? 1)
  map[slot - 1] = extruder
  patchPlate(plateId, map)
}

/** What the slicer reported for the plate now on screen, when the slice is current. */
export function pickedMap(s: Pick<AppState, 'slice'> = get()): FilamentMapInfo | undefined {
  return s.slice.status === 'done' ? s.slice.result.filamentMap : undefined
}

/** The name of an extruder in the interface: "Left nozzle", "Right nozzle" or, with a rack, "Right hotend rack". */
export function nozzleName(extruder: number, rack: boolean): string {
  if (extruder === 1) return 'Left nozzle'
  return rack ? 'Right hotend rack' : 'Right nozzle'
}

/** The tools of a printer whose hotends are its tools (the H3C's nine), else 0. */
export function mapHotends(cfg: Record<string, unknown>): number {
  return hotendCount(cfg)
}

/**
 * The tool (1-based) of each slot (index slot - 1) the plate prints with: its own map, else what the last slice picked,
 * else the engine's rule for the filaments in `used` (1-based slots).
 */
export function currentHotends(meta: Pick<PlateMeta, 'settings'> | undefined, picked: FilamentMapInfo | undefined, cfg: Record<string, unknown>, slots: number, used: readonly number[]): number[] {
  const own = meta?.settings.hotendMap
  const rule = autoHotends(cfg, slots, used)
  return Array.from({ length: slots }, (_, i) => own?.[i] ?? (picked ? (picked.nozzles[i] ?? 0) + 1 : (rule[i] ?? 0) + 1))
}

/** The engine's settings for a plate's tools set by hand (hotends from 0): nothing when the slicer picks them. */
export function hotendMapConfig(meta: Pick<PlateMeta, 'settings'> | undefined): Record<string, string | number[]> {
  const own = meta?.settings.hotendMap
  if (!own?.length) return {}
  return { filament_map_mode: 'Manual', filament_nozzle_map: own.map((t) => t - 1) }
}

function patchHotends(plateId: string, map: number[] | null): void {
  set((s: AppState) => ({
    plates: s.plates.map((p) => {
      if (p.id !== plateId) return p
      const { hotendMap: _old, ...rest } = p.settings
      return { ...p, settings: map ? { ...rest, hotendMap: map } : rest }
    }),
  }))
  markStale()
}

/** Back to the slicer's pick of tools. */
export function setHotendAuto(plateId: string): void {
  patchHotends(plateId, null)
}

/** Sets slot `slot` (1-based) to `tool` (1-based); the other slots keep the tools they print with now. */
export function setSlotHotend(plateId: string, slot: number, tool: number, current: readonly number[]): void {
  if (slot < 1 || !Number.isInteger(tool) || tool < 1) return
  const map = current.slice()
  while (map.length < slot) map.push(1)
  map[slot - 1] = tool
  patchHotends(plateId, map)
}

/** A tool's name in the interface: "Tool 3", and the TPU tool says what it takes. */
export function toolName(tool: number, tpu: boolean): string {
  return tpu ? `Tool ${tool}, TPU 2.85 mm` : `Tool ${tool}`
}

/**
 * The TPU tool (1-based) the printer's own device data names, where it differs from the print profiles' TPU hotend.
 * The maker's device file for the H3C (from its 2.9.1 slicer release) gives index 6 (tool 7) for the TPU tool, while its print profiles put
 * the TPU285 hotend on index 7 (tool 8). Until a real printer settles which, the tool rows say so plainly.
 */
export function deviceTpuTool(cfg: Record<string, unknown>): number | undefined {
  const model = String(list(cfg['printer_model'])[0] ?? '')
  return model === 'Bambu Lab H3C' ? 7 : undefined
}

/** Why a hand-set map of tools does not fit the printer (the rule the engine refuses by); null when it fits. */
export { hotendMapProblem }

/** The shown plate's filaments in use on their tools, for the app link: whether the slicer picks them, and each one. */
export function hotendReadback(s: Pick<AppState, 'slice'>, meta: Pick<PlateMeta, 'settings'> | undefined, cfg: Record<string, unknown>, slots: number, used: readonly number[]): { auto: boolean; filaments: HotendRow[] } {
  const tools = currentHotends(meta, pickedMap(s), cfg, slots, used)
  return { auto: !meta?.settings.hotendMap, filaments: hotendRows(cfg, tools.map((t) => t - 1), used) }
}
