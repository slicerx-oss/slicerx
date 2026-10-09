// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How many layer ranges a slice is split into. Every range cuts the layers its shells reach on both sides again,
// and every worker that takes one builds the plate's session (for a painted plate, the colors of every layer), so a
// plate with few layers slices faster in a few ranges than in many.

/** Fewest layers a range should hold: below this, the work around a range outweighs the range itself. */
export const MIN_LAYERS_PER_SHARD = 3

interface ShardObject {
  mesh: string | number
  transform?: number[]
}

/**
 * The number of layer ranges for a slice: `cap` (workers times ranges per worker, at most 64), fewer when the
 * plate's estimated layer count would leave ranges under {@link MIN_LAYERS_PER_SHARD} layers. The estimate is each
 * object's height (its mesh's bounding box turned by its transform) over the layer height; objects printed one after
 * another add up, the rest print side by side. Without a size for every object the cap stands.
 */
export function shardCount(
  objects: readonly ShardObject[],
  config: Record<string, unknown>,
  sizeOf: (mesh: string) => readonly [number, number, number] | undefined,
  cap: number,
): number {
  const layer = Number(config.layer_height)
  if (!(layer > 0) || objects.length === 0) return cap
  const heights: number[] = []
  for (const o of objects) {
    const size = sizeOf(String(o.mesh))
    if (!size) return cap
    const m = o.transform?.length === 16 ? o.transform : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    // Column-major: the z row is m[2], m[6], m[10].
    heights.push(Math.abs(m[2] ?? 0) * size[0] + Math.abs(m[6] ?? 0) * size[1] + Math.abs(m[10] ?? 0) * size[2])
  }
  const byObject = String(config.print_sequence ?? '').replace(/[ _]/g, '') === 'byobject'
  const height = byObject ? heights.reduce((a, h) => a + h, 0) : Math.max(...heights)
  const layers = Math.ceil(height / layer)
  return Math.max(1, Math.min(cap, Math.ceil(layers / MIN_LAYERS_PER_SHARD)))
}
