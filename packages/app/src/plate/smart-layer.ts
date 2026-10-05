// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// sleipnir: sx-geom plans the layer tops for the whole plate (thin where the shape curves,
// thick where walls run straight, then smoothed), and the engine slices at exactly those heights.
import type { PlateEntry } from '../state/store'
import { geom, type GeomMesh } from '../geom/client'
import { bake } from './mesh-ops'

const num = (v: unknown, fallback: number): number => {
  const n = Array.isArray(v) ? Number(v[0]) : Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Every printable object in bed coordinates as one mesh. */
export function plateMesh(objects: readonly PlateEntry[]): GeomMesh {
  const positions: number[] = []
  const indices: number[] = []
  for (const o of objects) {
    for (const part of o.parts) {
      const w = bake(part, o.transform)
      const base = positions.length / 3
      for (const v of w.positions) positions.push(v)
      for (const i of w.indices) indices.push(base + i)
    }
  }
  return { positions, indices }
}

/** The layer tops for the plate, first layer first, or null when the plan is not wanted or not possible. */
export async function planSmartLayers(objects: readonly PlateEntry[], config: Record<string, unknown>, mode: 'quality' | 'strength'): Promise<number[] | null> {
  if (objects.length === 0) return null
  const nozzleMm = num(config['nozzle_diameter'], 0.4)
  const r = await geom().call<{ layerTopsMm?: number[] }>('layers.plan', {
    mesh: plateMesh(objects),
    nozzleMm,
    mode,
    options: {
      minHeightMm: num(config['smart_layer_min_height'], 0.15),
      maxHeightMm: num(config['smart_layer_max_height'], nozzleMm * 0.75),
      firstLayerMm: num(config['initial_layer_print_height'], 0.2),
    },
  })
  const tops = r.layerTopsMm
  return tops && tops.length > 1 ? tops : null
}
