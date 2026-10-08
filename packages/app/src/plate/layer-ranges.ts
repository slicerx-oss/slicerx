// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings by height from a project (Metadata/layer_config_ranges.xml, Orca and Bambu Studio's height range
// modifiers). The keys the engine may change by height go to the slice as height ranges for their object; layer height
// ranges become the plate's layer tops when every object shares them, since layers are plate-wide here.
import type { HeightRange, SettingValue } from '@slicerx/contracts'
import type { PlateEntry } from '../state/store'
import { bounds } from './transform'

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

/** The slice's height ranges for the printable objects' range keys. */
export function heightRangesOf(entries: readonly Pick<PlateEntry, 'id' | 'printable' | 'layerRanges'>[]): HeightRange[] {
  const out: HeightRange[] = []
  for (const e of entries) {
    if (e.printable === false) continue
    for (const r of e.layerRanges ?? []) {
      const settings = Object.fromEntries(Object.entries(r.settings).filter(([k]) => RANGE_KEYS.includes(k)))
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

/**
 * Layer tops from the layer height ranges, when every printable object has the same ones (layers are plate-wide).
 * The first layer keeps its own height; elsewhere a layer takes the height of the range its bottom is in, else
 * `layerHeight`. Null when no object has a layer height range or the objects differ.
 */
export function rangeLayerTops(entries: readonly Pick<PlateEntry, 'parts' | 'transform' | 'printable' | 'layerRanges'>[], firstLayer: number, layerHeight: number): number[] | null {
  const live = entries.filter((e) => e.printable !== false)
  if (!live.length || !live.some((e) => heights(e).length)) return null
  const want = JSON.stringify(heights(live[0]!))
  if (live.some((e) => JSON.stringify(heights(e)) !== want)) return null
  const ranges = heights(live[0]!)
  let top = 0
  for (const e of live) top = Math.max(top, bounds(e.parts, e.transform)?.max[2] ?? 0)
  if (!(top > firstLayer)) return null
  const tops = [firstLayer]
  let z = firstLayer
  while (top - z > 1e-6) {
    const h = ranges.find((r) => z + 1e-6 >= r.minZ && z + 1e-6 < r.maxZ)?.h ?? layerHeight
    let next = Math.min(top, z + h)
    // A sliver at the top joins the layer below it.
    if (top - next < 0.04 && next < top) next = top
    z = next
    tops.push(Math.round(z * 1e6) / 1e6)
  }
  const last = tops.length - 1
  if (last > 1 && tops[last]! - tops[last - 1]! < 0.04) tops.splice(last - 1, 1)
  return tops
}
