// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which point markers Preview draws over the toolpaths, set from the legend. Retractions, seams and z hops come
// with the slice; wipes, tool changes and pauses are read from the G-code when one of them is first turned on
// (marker-data.ts).
import type { MarkerKind } from '@slicerx/viewport'
import type { PreviewBuffers } from '@slicerx/contracts'
import { createStore, useStore } from 'zustand'

/** `demo` is the tip's loop, which turns that kind on over two small towers. */
export const MARKERS: readonly { kind: MarkerKind; label: string; tip: string; fromGcode: boolean; demo: string }[] = [
  { kind: 'retractions', label: 'Retractions', tip: 'Where the filament pulls back before a travel.', fromGcode: false, demo: 'preview-markers-retractions' },
  { kind: 'seams', label: 'Seams', tip: 'Where each wall loop starts and ends.', fromGcode: false, demo: 'preview-markers-seams' },
  { kind: 'lifts', label: 'Z hops', tip: 'Where the nozzle lifts before a travel.', fromGcode: false, demo: 'preview-markers-z-hops' },
  { kind: 'wipes', label: 'Wipes', tip: 'Where the nozzle wipes along the path after a retraction.', fromGcode: true, demo: 'preview-markers-wipes' },
  { kind: 'toolChanges', label: 'Tool changes', tip: 'Where the printer changes to another filament or tool.', fromGcode: true, demo: 'preview-markers-tool-changes' },
  { kind: 'pauses', label: 'Pauses', tip: 'Where the print pauses and waits for you.', fromGcode: true, demo: 'preview-markers-pauses' },
]

interface MarkerState {
  shown: Record<MarkerKind, boolean>
  /** Markers found in the G-code, per kind, once read. */
  counts: Partial<Record<MarkerKind, number>>
  countsFor: PreviewBuffers | null
}

export const markerView = createStore<MarkerState>()(() => ({
  shown: { retractions: false, seams: false, lifts: false, wipes: false, toolChanges: false, pauses: false },
  counts: {},
  countsFor: null,
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
