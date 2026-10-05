// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch panel's "Extrude into the face" switch against the engine's flip. The engine runs a cut
// into the face and a join or new body out of it; flip reverses that. The switch shows where the
// extrusion really goes, so for a cut it reads on unless the cut was flipped out of the face.

export type ExtrudeOperation = 'new' | 'join' | 'cut'

/** Whether an extrusion with this flip goes into the face. */
export function goesIntoFace(flip: boolean, op: ExtrudeOperation): boolean {
  return flip !== (op === 'cut')
}

/** The engine flip that sends the extrusion into the face (or out of it). */
export function flipFor(intoFace: boolean, op: ExtrudeOperation): boolean {
  return intoFace !== (op === 'cut')
}
