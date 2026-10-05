// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which nozzle prints each filament on a printer with two extruders fed by their own AMS (Bambu Lab H2D, H2C):
// the plate's filament map. By default the slicer picks it (each filament where it flushes least, as Bambu Studio's
// "Auto For Flush" does) and reports it with the slice; a plate can set it by hand, slot by slot. The hand-set map
// reaches the engine as `filament_map_mode` Manual and `filament_map`, and the project file as Bambu Studio writes it.
import type { FilamentMapInfo, SettingValue } from '@slicerx/contracts'
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
