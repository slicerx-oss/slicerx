// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plates as a save or an upload reads them. It sits apart from plates.ts so the code that loads at startup
// (unsaved work, the upload entry) reads the plates without bringing the plate edits along with it.
import { fullPlate, get, type AppState, type PlateMeta } from '../state/store'

/** The plates with the active one's objects filled in. */
export function allPlates(s: Pick<AppState, 'plates' | 'plate' | 'activePlate'> & Partial<Pick<AppState, 'historyEdit'>> = get()): PlateMeta[] {
  // A history step open for editing shows an earlier mesh; saves write the object as it is.
  const objects = fullPlate({ plate: s.plate, historyEdit: s.historyEdit ?? null })
  return s.plates.map((p) => (p.id === s.activePlate ? { ...p, objects } : p))
}
