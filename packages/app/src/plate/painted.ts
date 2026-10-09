// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Getting paint to the engine: filament color, seam position, support blockers and enforcers, and fuzzy skin. A painted
// object goes to the engine as its parts with their paint (raw parts with the paint block, plate/raw-parts.ts), loaded
// as a mesh of its own whose handle stands in for the object's when slicing. The result is kept until the paint or
// mesh changes.
import type { MeshHandle, MeshPart, SlicerHost } from '@slicerx/contracts'
import type { PlateEntry } from '../state/store'

const cache = new Map<string, Promise<MeshHandle>>()

/** Every painted layer of the object, as a stable string; empty when nothing is painted. */
function paintKey(e: PlateEntry): string {
  const out: Record<number, Record<string, Record<number, string>>> = {}
  for (const [part, layers] of Object.entries(e.paint ?? {})) {
    for (const [layer, texts] of Object.entries(layers)) if (texts && Object.keys(texts).length) (out[Number(part)] ??= {})[layer] = texts
  }
  return Object.keys(out).length ? JSON.stringify(out) : ''
}

export function hasEnginePaint(e: PlateEntry): boolean {
  return paintKey(e) !== ''
}

/**
 * The object's parts as the engine slices them with paint: each part's own paint, and the filament slot the object
 * sets for it (its slot override), which the engine compares color paint against.
 */
export function paintedParts(e: Pick<PlateEntry, 'parts' | 'paint' | 'slotOverrides'>): MeshPart[] {
  return e.parts.map((p, i) => {
    const paint = e.paint?.[i]
    const slot = e.slotOverrides?.[p.name] ?? p.slot
    return { name: p.name, slot, positions: p.positions, indices: p.indices, ...(paint && Object.keys(paint).length ? { paint } : {}) }
  })
}

/** The engine handle to slice this object with: its own, or one loaded from its parts with their paint. */
export async function sliceHandle(slicer: Pick<SlicerHost, 'loadModel'>, e: PlateEntry): Promise<MeshHandle> {
  const key = paintKey(e)
  if (!key) return e.handle
  const id = `${e.handle.id}|${JSON.stringify(e.slotOverrides ?? {})}|${key}`
  let hit = cache.get(id)
  if (!hit) {
    // The encoder loads with the first painted object, not with the app.
    const bytes = (await import('./raw-parts')).encodePaintedParts(paintedParts(e))
    hit = slicer.loadModel(bytes.buffer as ArrayBuffer, `${e.name} (painted)`)
    cache.set(id, hit)
    // A failed load is not kept: the next slice tries again.
    hit.catch(() => cache.delete(id))
  }
  return hit
}
