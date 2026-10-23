// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings by height from a project (Metadata/layer_config_ranges.xml, Orca and Bambu Studio's height range
// modifiers). The keys the engine may change by height go to the slice as height ranges for their object, and so do
// layer heights by height: the engine plans the plate's layers from them when every object shares them, since layers
// are plate-wide here (packages/core/src/layers.rs, plate_range_tops).
import type { HeightRange, SettingValue } from '@slicerx/contracts'
import type { PlateEntry } from '../state/store'

/** One range of an object, its heights from the object's bottom, mm. */
export interface LayerRange {
  minZ: number
  maxZ: number
  settings: Record<string, SettingValue>
}

/** What the engine lets a height range change (packages/core/src/config.rs RANGE_KEYS), and layer height. */
export const RANGE_KEYS: readonly string[] = [
  'wall_loops',
  'nozzle_temperature',
  'filament_flow_ratio',
  'enable_pressure_advance',
  'pressure_advance',
  'outer_wall_speed',
  'inner_wall_speed',
  'sparse_infill_speed',
  'internal_solid_infill_speed',
  'top_surface_speed',
  'travel_speed',
  'retraction_length',
  'retraction_speed',
  'retraction_minimum_travel',
  'outer_wall_filament_id',
  'inner_wall_filament_id',
  'sparse_infill_filament_id',
  'internal_solid_filament_id',
  'top_surface_filament_id',
  'bottom_surface_filament_id',
]

/** A file's ranges cut to what the plate can use, and the keys left out. */
export function usableRanges(ranges: readonly LayerRange[]): { ranges: LayerRange[]; left: string[] } {
  const left = new Set<string>()
  const out: LayerRange[] = []
  for (const r of ranges) {
    if (!(Number.isFinite(r.minZ) && Number.isFinite(r.maxZ) && r.maxZ > r.minZ)) continue
    const settings: Record<string, SettingValue> = {}
    for (const [k, v] of Object.entries(r.settings)) {
      if (k === 'layer_height' || RANGE_KEYS.includes(k)) settings[k] = v
      else left.add(k)
    }
    if (Object.keys(settings).length) out.push({ minZ: r.minZ, maxZ: r.maxZ, settings })
  }
  return { ranges: out, left: [...left].sort() }
}

/**
 * The slice's height ranges for the printable objects' range keys, with their layer heights when `layerHeights` is
 * set and the objects share them: the engine plans the plate's layers from those. Objects that change layer height at
 * different heights send none, so the plate keeps one layer height (the note on opening the project says so).
 */
export function heightRangesOf(entries: readonly Pick<PlateEntry, 'id' | 'printable' | 'layerRanges'>[], opts: { layerHeights?: boolean } = {}): HeightRange[] {
  const keys = opts.layerHeights && !layerHeightsDiffer(entries) ? [...RANGE_KEYS, 'layer_height'] : RANGE_KEYS
  const out: HeightRange[] = []
  for (const e of entries) {
    if (e.printable === false) continue
    for (const r of e.layerRanges ?? []) {
      const settings = Object.fromEntries(Object.entries(r.settings).filter(([k]) => keys.includes(k)))
      if (Object.keys(settings).length) out.push({ zFromMm: r.minZ, zToMm: r.maxZ, settings, objects: [e.id] })
    }
  }
  return out
}

const heights = (e: Pick<PlateEntry, 'layerRanges'>): { minZ: number; maxZ: number; h: number }[] =>
  (e.layerRanges ?? []).flatMap((r) => (typeof r.settings['layer_height'] === 'number' ? [{ minZ: r.minZ, maxZ: r.maxZ, h: r.settings['layer_height'] }] : []))

/** The printable objects change layer height at different heights, which plate-wide layers cannot follow. */
export function layerHeightsDiffer(entries: readonly Pick<PlateEntry, 'printable' | 'layerRanges'>[]): boolean {
  const live = entries.filter((e) => e.printable !== false)
  if (!live.some((e) => heights(e).length)) return false
  return new Set(live.map((e) => JSON.stringify(heights(e)))).size > 1
}
