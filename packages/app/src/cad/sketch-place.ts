// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where a body stands, for where the timeline sketches that move with it stand (cad-history design-frame.ts). One
// answer for every reader in the app: the sketch panel and the view in Model, projections, the person's Extrude and
// Revolve on a finished sketch, and every design host (the mimir tab's and the app link's). A body stands on the plate
// shown, on another plate, held off the plate while the timeline is rolled back, or, for a design that waits for its
// first body, where a design host keeps it waiting.
import { BED_FRAME, frameNow, movedSketch, recordedOnSketch, sketchMove, type FaceFrame, type Mat4, type SketchItem, type StepParams } from '@slicerx/cad-history'
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

/** How a person's tool records a step on a timeline sketch, and the plane the step is worked out on (onSketch). */
export interface OnSketch {
  (params: StepParams, transform: Mat4): { params: StepParams; transform: Mat4 }
  /** Where the sketch stands as this was read: the plane the engine runs the step on. Undefined with no timeline sketch. */
  frame: FaceFrame | undefined
}

/**
 * How a person's tool records a step on timeline sketch `sketch`: given on the plane the sketch stands on now by an
 * object standing at `transform`, kept where the sketch is stored (cad-history recordedOnSketch), as the design hosts
 * record theirs; as given with no timeline sketch. Where the sketch stands is read once, when this is called, and both
 * the recorder and `frame` use that read: call it as the tool starts, before the engine runs, and run the engine on
 * `frame`, so a move of the body while the sketch panel is open or while the engine works never puts the step and the
 * plane it was worked out on apart.
 */
export function onSketch(sketch: string | undefined): OnSketch {
  const t = get().timeline
  const k = sketch === undefined ? undefined : t.items.find((i): i is SketchItem => i.kind === 'sketch' && i.id === sketch)
  if (!k) return Object.assign((params: StepParams, transform: Mat4) => ({ params, transform: [...transform] }), { frame: undefined })
  const move = sketchMove(t, k.id, placeOf)
  return Object.assign((params: StepParams, transform: Mat4) => recordedOnSketch(k, move, transform, params), { frame: movedSketch(k, move).frame ?? BED_FRAME })
}
