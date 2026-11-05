// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate's facts every shard of a slice carries the same of, read once into the result, and the engine's chamber
// cooling report and its per-object feature filaments as the result carries them. The desktop's slicer reads the
// native report the same way.
import type { ChamberCooling, FeatureFilaments, SliceResult } from '@slicerx/contracts'
import type { ShardInfo } from './protocol'

const SOURCES: readonly ChamberCooling['source'][] = ['override', 'project', 'preset', 'config', 'derived']

/** The engine's `chamberCooling` report (the mode the G-code got and where it came from), or undefined when there is none. */
export function chamberCoolingOf(v: unknown): ChamberCooling | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const r = v as Record<string, unknown>
  const source = SOURCES.find((s) => s === r['source'])
  if (typeof r['mode'] !== 'number' || !Number.isInteger(r['mode']) || !source || typeof r['text'] !== 'string') return undefined
  const filaments = Array.isArray(r['filaments']) ? r['filaments'].map(String) : []
  return { mode: r['mode'], source, ...(filaments.length ? { filaments } : {}), text: r['text'] }
}

/**
 * The engine's `featureFilaments` report (which filament slots each object's features printed with), or undefined when
 * there is none. Entries that are not well formed are left out.
 */
export function featureFilamentsOf(v: unknown): FeatureFilaments[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: FeatureFilaments[] = []
  for (const e of v) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue
    const r = e as Record<string, unknown>
    if (typeof r['object'] !== 'string' || !r['features'] || typeof r['features'] !== 'object' || Array.isArray(r['features'])) continue
    const features: Record<string, number[]> = {}
    for (const [k, slots] of Object.entries(r['features'] as Record<string, unknown>)) {
      if (Array.isArray(slots)) features[k] = slots.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    }
    const nozzle = r['nozzleMm']
    out.push({ object: r['object'], name: typeof r['name'] === 'string' ? r['name'] : r['object'], ...(typeof r['engineObject'] === 'string' ? { engineObject: r['engineObject'] } : {}), features, ...(typeof nozzle === 'number' && Number.isFinite(nozzle) && nozzle > 0 ? { nozzleMm: nozzle } : {}) })
  }
  return out.length ? out : undefined
}

/**
 * The shards' feature filament reports joined into one: shards split the plate by layers, so each object's features
 * print with the union of the slots its shards report, ascending. Objects keep the order they first appear in.
 */
export function joinFeatureFilaments(reports: readonly (readonly FeatureFilaments[] | undefined)[]): FeatureFilaments[] | undefined {
  const byObject = new Map<string, { entry: FeatureFilaments; slots: Map<string, Set<number>> }>()
  for (const report of reports) {
    for (const f of report ?? []) {
      let o = byObject.get(f.object)
      if (!o) byObject.set(f.object, (o = { entry: { object: f.object, name: f.name, ...(f.engineObject ? { engineObject: f.engineObject } : {}), features: {} }, slots: new Map() }))
      // An object prints with one nozzle size; a shard where it printed nothing reports none.
      if (f.nozzleMm !== undefined && o.entry.nozzleMm === undefined) o.entry.nozzleMm = f.nozzleMm
      for (const [k, list] of Object.entries(f.features)) {
        const set = o.slots.get(k) ?? new Set<number>()
        for (const n of list ?? []) set.add(n)
        o.slots.set(k, set)
      }
    }
  }
  if (!byObject.size) return undefined
  return [...byObject.values()].map(({ entry, slots }) => ({ ...entry, features: Object.fromEntries([...slots].map(([k, set]) => [k, [...set].sort((a, b) => a - b)])) }))
}

/** What the shards all carry the same of (worked out for the whole plate): the first shard's. */
export function plateFacts(infos: readonly ShardInfo[]): Pick<SliceResult, 'primeTower' | 'varyLayerCost' | 'filamentMap' | 'chamberCooling' | 'featureFilaments'> {
  const first = infos[0]
  const chamber = chamberCoolingOf(first?.chamberCooling)
  // Not the same in every shard: each covers its own layers, so the reports are joined.
  const featureFilaments = joinFeatureFilaments(infos.map((i) => featureFilamentsOf(i.featureFilaments)))
  return {
    ...(first?.primeTower ? { primeTower: first.primeTower } : {}),
    ...(first?.varyLayerCost ? { varyLayerCost: first.varyLayerCost } : {}),
    ...(first?.filamentMap ? { filamentMap: first.filamentMap } : {}),
    ...(chamber ? { chamberCooling: chamber } : {}),
    ...(featureFilaments ? { featureFilaments } : {}),
  }
}
