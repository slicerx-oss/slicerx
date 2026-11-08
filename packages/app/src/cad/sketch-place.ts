// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where a body stands, for where the timeline sketches that move with it stand (cad-history design-frame.ts). One
// answer for every reader in the app: the sketch panel and the view in Model, projections, the person's Extrude and
// Revolve on a finished sketch, and every design host (the mimir tab's and the app link's). A body stands on the plate
// shown, on another plate, held off the plate while the timeline is rolled back, or, for a design that waits for its
// first body, where a design host keeps it waiting.
import { BED_FRAME, frameNow, recordedOn, type FaceFrame, type Mat4, type SketchItem, type StepParams } from '@slicerx/cad-history'
import { heldBodies } from '../plate/timeline'
import { fullPlate, get } from '../state/store'
import { waitingAt } from './waiting'

/** Where body `id` stands now, or undefined when it stands nowhere. */
export function placeOf(id: string): Mat4 | undefined {
  const s = get()
  const e = fullPlate(s).find((p) => p.id === id) ?? s.plates.flatMap((p) => (p.id === s.activePlate ? [] : p.objects)).find((p) => p.id === id) ?? heldBodies(s).find((h) => h.entry.id === id)?.entry
  return e?.transform ?? waitingAt(id)
}

/** Where finished sketch `k` stands on the plate now: the plane Model draws it on and projects onto. */
export function frameShown(k: SketchItem): FaceFrame {
  return frameNow(get().timeline, k, placeOf) ?? BED_FRAME
}

/**
 * A step a person's tool made on timeline sketch `sketch`, given on the plane the sketch stands on now by an object
 * standing at `transform`, as its history keeps it: where the sketch is stored (cad-history recordedOn), as the design
 * hosts record theirs. As given with no timeline sketch.
 */
export function onSketch(sketch: string | undefined, params: StepParams, transform: Mat4): { params: StepParams; transform: Mat4 } {
  if (sketch === undefined) return { params, transform: [...transform] }
  return recordedOn(get().timeline, sketch, transform, params, placeOf)
}
