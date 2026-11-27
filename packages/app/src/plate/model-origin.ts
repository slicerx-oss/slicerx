// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where Model counts positions from, in a leaf of its own: the mode code (state/model-mode.ts) loads with the shell,
// and the plate's transforms (plate/transform.ts) stay out of it.
import type { Bed } from '@slicerx/contracts'

/** Where Model counts positions from: the grid center, the middle of the bed. Slice counts from the bed's front left corner. */
export function modelOrigin(bed: Pick<Bed, 'widthMm' | 'depthMm'>): [number, number, number] {
  return [bed.widthMm / 2, bed.depthMm / 2, 0]
}
