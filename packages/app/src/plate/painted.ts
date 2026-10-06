// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Getting paint to the engine: filament color, seam position and support blockers and enforcers. The engine reads paint from a 3MF
// model, so a painted object is written as a one-object 3MF (its parts unmoved, with the paint texts) and loaded again; the handle of that
// model stands in for the object's own when slicing. The result is kept until the paint or mesh changes.
import type { MeshHandle, SlicerHost } from '@slicerx/contracts'
import type { PlateEntry } from '../state/store'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

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

/** The engine handle to slice this object with: its own, or one loaded from a 3MF that carries its color paint. */
export async function sliceHandle(slicer: Pick<SlicerHost, 'loadModel'>, e: PlateEntry): Promise<MeshHandle> {
  const key = paintKey(e)
  if (!key) return e.handle
  const id = `${e.handle.id}|${key}`
  let hit = cache.get(id)
  if (!hit) {
    // The project writer loads with the first painted object, not with the app.
    const { writeProject } = await import('../export/threemf')
    const bytes = writeProject({
      plates: [{ id: 'p', name: 'Plate', settings: {}, objects: [{ ...e, transform: IDENTITY, volumes: [] }] }],
      bed: { widthMm: 256, depthMm: 256 },
      settings: {},
    })
    hit = slicer.loadModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, `${e.name}-painted.3mf`)
    cache.set(id, hit)
    // A failed load is not kept: the next slice tries again.
    hit.catch(() => cache.delete(id))
  }
  return hit
}
