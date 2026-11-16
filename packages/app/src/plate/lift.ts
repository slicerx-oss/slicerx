// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Placing a design lifts it onto the bed when its body sits more than 0.01 mm under it, as its landing does
// (cad-history landing.ts): raised only, never lowered, and the lift joins the design's landing moves (History.placed)
// so its own frame, the one its next edit reads, keeps its height. Every route that puts a design somewhere on the
// plate places it through here: arrange, a new copy or paste, an array's copies, a move, mimir's plates. An object with
// no design history keeps the height it is given, since a person can sink a plain model on purpose.
import { liftedOnto, placedAfter, withPlaced } from '@slicerx/cad-history'
import type { PlateEntry } from '../state/store'
import { lowestOf } from './arrange'
import type { Mat4 } from './transform'

/** `transform` with the parts' lowest point raised onto the bed when it is under it; never lowered. */
export const onBedHeight = (parts: PlateEntry['parts'], transform: Mat4): Mat4 => liftedOnto(parts, transform, { lowest: lowestOf })

/** `e` placed at `to`: a design under the bed there is lifted onto it, the lift in its landing moves. */
export function placedLifted<E extends Pick<PlateEntry, 'parts' | 'transform' | 'history'>>(e: E, to: Mat4): E {
  if (!e.history) return { ...e, transform: [...to] }
  const up = onBedHeight(e.parts, to)
  if (up[14] === to[14]) return { ...e, transform: up }
  return { ...e, transform: up, history: withPlaced(e.history, placedAfter(e.history.placed, to, up)) }
}
