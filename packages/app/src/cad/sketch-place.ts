// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where a body stands, for where the timeline sketches that move with it stand (cad-history design-frame.ts). One
// answer for every reader in the app: the sketch panel and the view in Model, projections, the person's Extrude and
// Revolve on a finished sketch, and every design host (the mimir tab's and the app link's). A body stands on the plate
// shown, on another plate, held off the plate while the timeline is rolled back, or, for a design that waits for its
// first body, where a design host keeps it waiting.
import { BED_FRAME, frameNow, recordedOnSketch, sketchMove, type FaceFrame, type Mat4, type SketchItem, type StepParams } from '@slicerx/cad-history'
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
 * How a person's tool records a step on timeline sketch `sketch`: given on the plane the sketch stands on now by an
 * object standing at `transform`, kept where the sketch is stored (cad-history recordedOnSketch), as the design hosts
 * record theirs; as given with no timeline sketch. Where the sketch stands is read when this is called: call it as the
 * tool reads the plane, before the engine runs, so a drag while the engine works never shifts what the step is
 * recorded against.
 */
export function onSketch(sketch: string | undefined): (params: StepParams, transform: Mat4) => { params: StepParams; transform: Mat4 } {
  const t = get().timeline
  const k = sketch === undefined ? undefined : t.items.find((i): i is SketchItem => i.kind === 'sketch' && i.id === sketch)
  if (!k) return (params, transform) => ({ params, transform: [...transform] })
  const move = sketchMove(t, k.id, placeOf)
  return (params, transform) => recordedOnSketch(k, move, transform, params)
}
