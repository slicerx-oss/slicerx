// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A slice request names meshes by the pool's ids; each worker loaded them under ids of its own.

interface RequestShape {
  plate: { objects: { id?: string; mesh: string | number; volumes?: { name?: string; mesh: string | number }[] }[] }
}

/**
 * The request JSON with every mesh reference, each object's and each of its volumes' (negative volumes, support
 * blockers and enforcers, modifiers), in this worker's ids. A reference the worker has not loaded is refused, naming
 * the object or volume, before the engine sees it.
 */
export function workerRequest(request: string, idOf: (meshId: string) => number | undefined): string {
  const req = JSON.parse(request) as RequestShape
  for (const [i, o] of req.plate.objects.entries()) {
    const own = idOf(String(o.mesh))
    if (own === undefined) throw new Error(`Mesh ${String(o.mesh)} of object ${o.id ?? i + 1} is not loaded in this worker`)
    o.mesh = own
    for (const [k, v] of (o.volumes ?? []).entries()) {
      const id = idOf(String(v.mesh))
      if (id === undefined) throw new Error(`Mesh ${String(v.mesh)} of volume ${v.name ?? k + 1} in object ${o.id ?? i + 1} is not loaded in this worker`)
      v.mesh = id
    }
  }
  return JSON.stringify(req)
}
