// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Keeps the design timeline in step with the objects. The tools still record each object's own history; when one
// changes, it is folded back into the timeline (withHistory), and an object that leaves takes its features with it.
// Undo brings back the plate and the timeline together, so folding what undo restored changes nothing.
import { syncTimeline, type History } from '@slicerx/cad-history'
import { appStore, fullPlate, get, type AppState, type PlateEntry } from '../state/store'
import { quietly } from './history'

/** The bodies made after the marker, off the plates while it is rolled back. */
export function heldBodies(s: Pick<AppState, 'plate' | 'plates' | 'activePlate' | 'rollback'> = get()): { plate: string; entry: PlateEntry }[] {
  if (!s.rollback) return []
  const on = new Set([...s.plate, ...s.plates.filter((p) => p.id !== s.activePlate).flatMap((p) => p.objects)].map((e) => e.id))
  return s.rollback.ends.filter((h) => !on.has(h.entry.id))
}

const NONE: History = { version: 1, base: [], steps: [] }
const notYet = new WeakMap<PlateEntry, PlateEntry>()

/** Every object, and each body held off the plates while the design is rolled back, with nothing made yet. */
function every(s: Pick<AppState, 'plate' | 'plates' | 'activePlate' | 'historyEdit' | 'rollback'>): PlateEntry[] {
  const on = [...fullPlate(s), ...s.plates.filter((p) => p.id !== s.activePlate).flatMap((p) => p.objects)]
  const held = heldBodies(s).map(({ entry }) => {
    let e = notYet.get(entry)
    if (!e) notYet.set(entry, (e = { ...entry, history: { ...NONE, ...(entry.history?.ended ? { ended: entry.history.ended } : {}) } }))
    return e
  })
  return [...on, ...held]
}

/** Watches the plates and keeps the timeline in step. Returns the stop function. */
export function startTimeline(store = appStore): () => void {
  const seen = new WeakSet<History>()
  const run = (s: AppState) => {
    const t = syncTimeline(s.timeline, every(s), seen)
    // following the plates is part of their edit, not an undo step of its own
    if (t !== s.timeline) quietly(() => store.setState({ timeline: t }))
  }
  run(store.getState())
  return store.subscribe((s, prev) => {
    if (s.plate === prev.plate && s.plates === prev.plates && s.historyEdit === prev.historyEdit && s.rollback === prev.rollback) return
    run(s)
  })
}

/** The plain line slicing, printing and exporting show while the design is rolled back, or null. */
export function rolledBackNote(s: Pick<AppState, 'rollback'> = get()): string | null {
  return s.rollback ? `The timeline is rolled back to step ${s.rollback.at}. Slicing uses this state.` : null
}
