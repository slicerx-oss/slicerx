// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Parts rebuilt with new triangle numbers, said by the code that rebuilt them (the import's crossing check), so paint
// kept by triangle number can be put right for exactly those parts.

export interface PartRebuilt {
  objectId: string
  /** The part's index on the object. */
  part: number
  /** Runs a state change in the rebuild's undo step. */
  edit: (fn: () => void) => void
}

const listeners = new Set<(r: PartRebuilt) => void>()

export function onPartRebuilt(cb: (r: PartRebuilt) => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

/** Says a part was rebuilt, after the new mesh is on the plate. */
export function partRebuilt(r: PartRebuilt): void {
  for (const cb of [...listeners]) cb(r)
}
