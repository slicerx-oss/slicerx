// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which point markers Preview draws over the toolpaths, set from the legend. Retractions, seams and z hops come
// with the slice; wipes, tool changes and pauses are read from the G-code when one of them is first turned on
// (marker-data.ts).
import type { MarkerKind } from '@slicerx/viewport'
import { createStore, useStore } from 'zustand'

export const MARKERS: readonly { kind: MarkerKind; label: string; tip: string; fromGcode: boolean }[] = [
  { kind: 'retractions', label: 'Retractions', tip: 'Where the filament pulls back before a travel.', fromGcode: false },
  { kind: 'seams', label: 'Seams', tip: 'Where each wall loop starts and ends.', fromGcode: false },
  { kind: 'lifts', label: 'Z hops', tip: 'Where the nozzle lifts before a travel.', fromGcode: false },
  { kind: 'wipes', label: 'Wipes', tip: 'Where the nozzle wipes along the path after a retraction.', fromGcode: true },
  { kind: 'toolChanges', label: 'Tool changes', tip: 'Where the printer changes to another filament or tool.', fromGcode: true },
  { kind: 'pauses', label: 'Pauses', tip: 'Where the print pauses and waits for you.', fromGcode: true },
]

interface MarkerState {
  shown: Record<MarkerKind, boolean>
  /** Markers found in the G-code, per kind, once read. */
  counts: Partial<Record<MarkerKind, number>>
}

export const markerView = createStore<MarkerState>()(() => ({
  shown: { retractions: false, seams: false, lifts: false, wipes: false, toolChanges: false, pauses: false },
  counts: {},
}))

export function useMarkers<T>(pick: (s: MarkerState) => T): T {
  return useStore(markerView, pick)
}

export function setMarkerShown(kind: MarkerKind, on: boolean): void {
  markerView.setState((s) => ({ shown: { ...s.shown, [kind]: on } }))
}

/** True when a marker that needs the G-code text is on. */
export function wantsGcodeMarkers(s: MarkerState = markerView.getState()): boolean {
  return s.shown.wipes || s.shown.toolChanges || s.shown.pauses
}
