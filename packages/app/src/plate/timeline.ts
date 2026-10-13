// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Keeps the design timeline in step with the objects. The tools still record each object's own history; when one
// changes, it is folded back into the timeline (withHistory), and an object that leaves takes its features with it.
// Undo brings back the plate and the timeline together, so folding what undo restored changes nothing.
import { syncTimeline, type History } from '@slicerx/cad-history'
import { appStore, fullPlate, type AppState, type PlateEntry } from '../state/store'

function every(s: Pick<AppState, 'plate' | 'plates' | 'activePlate' | 'historyEdit'>): PlateEntry[] {
  const active = fullPlate(s)
  return [...active, ...s.plates.filter((p) => p.id !== s.activePlate).flatMap((p) => p.objects)]
}

/** Watches the plates and keeps the timeline in step. Returns the stop function. */
export function startTimeline(store = appStore): () => void {
  const seen = new WeakSet<History>()
  const run = (s: AppState) => {
    const t = syncTimeline(s.timeline, every(s), seen)
    if (t !== s.timeline) store.setState({ timeline: t })
  }
  run(store.getState())
  return store.subscribe((s, prev) => {
    if (s.plate === prev.plate && s.plates === prev.plates && s.historyEdit === prev.historyEdit) return
    run(s)
  })
}
