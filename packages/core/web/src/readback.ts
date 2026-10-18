// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate's facts every shard of a slice carries the same of, read once into the result, and the engine's chamber
// cooling report as the result carries it. The desktop's slicer reads the native report the same way.
import type { ChamberCooling, SliceResult } from '@slicerx/contracts'
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

/** What the shards all carry the same of (worked out for the whole plate): the first shard's. */
export function plateFacts(infos: readonly ShardInfo[]): Pick<SliceResult, 'primeTower' | 'varyLayerCost' | 'filamentMap' | 'chamberCooling'> {
  const first = infos[0]
  const chamber = chamberCoolingOf(first?.chamberCooling)
  return {
    ...(first?.primeTower ? { primeTower: first.primeTower } : {}),
    ...(first?.varyLayerCost ? { varyLayerCost: first.varyLayerCost } : {}),
    ...(first?.filamentMap ? { filamentMap: first.filamentMap } : {}),
    ...(chamber ? { chamberCooling: chamber } : {}),
  }
}
