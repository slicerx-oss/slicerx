// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PlateEntry } from '../state/store'
import { apply, multiply, type Box, type Mat4 } from './transform'

/** Spatial print data follows the material when the cut pieces are placed on the bed. */
export function cutMetadata(source: PlateEntry, id: string, toLocal: Mat4, before: Box, after: Box, ears: readonly [number, number, number, number][]) {
  const height = after.max[2] - after.min[2]
  const shift = after.min[2] - before.min[2]
  const layerRanges = (source.layerRanges ?? []).flatMap((range) => {
    const minZ = Math.max(0, range.minZ - shift)
    const maxZ = Math.min(height, range.maxZ - shift)
    return maxZ > minZ ? [{ minZ, maxZ, settings: { ...range.settings } }] : []
  })
  return {
    ...(source.volumes?.length ? { volumes: source.volumes.map((volume) => ({ ...volume, id: `${id}:${volume.id}`, local: multiply(toLocal, volume.local) })) } : {}),
    ...(ears.length ? { brimPoints: ears.map((ear): [number, number, number, number] => [...apply(toLocal, [ear[0], ear[1], ear[2]]), ear[3]]) } : {}),
    ...(layerRanges.length ? { layerRanges } : {}),
  }
}
