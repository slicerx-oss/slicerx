// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { get, showsLayers } from '../state/store'
import { MARKERS, markerView, setMarkerShown } from '../workspaces/preview/markers'
import { LinkError } from './methods-error'
import { previewIdle } from './preview-guard'

export function readMarkers() {
  const s = get()
  const m = markerView.getState()
  return {
    sliced: s.preview !== null,
    toolpaths: showsLayers(s),
    markers: MARKERS.map(({ kind, label, fromGcode }) => ({
      kind, label, shown: m.shown[kind],
      available: s.preview !== null && (fromGcode || s.preview.extrasOffset >= 0),
      source: fromGcode ? 'gcode' : 'preview',
      ...(s.preview && m.countsFor === s.preview && m.counts[kind] !== undefined ? { count: m.counts[kind] } : {}),
    })),
  }
}

export function setMarkers(args: Record<string, unknown>) {
  previewIdle()
  if (!get().preview) throw new LinkError('not_ready', 'there is no slice to preview; slice the plate first')
  const keys = Object.keys(args)
  if (!keys.length) throw new LinkError('invalid_input', 'Give at least one marker switch')
  const before = readMarkers()
  for (const key of keys) {
    const row = before.markers.find((m) => m.kind === key)
    if (!row || typeof args[key] !== 'boolean') throw new LinkError('invalid_input', `Unknown marker or non-boolean switch: ${key}`)
    if (args[key] && !row.available) throw new LinkError('refused', `${row.label} are unavailable in this slice`)
  }
  // Validate every switch before changing the same state the legend uses.
  for (const { kind } of MARKERS) if (args[kind] !== undefined) setMarkerShown(kind, args[kind] as boolean)
  return readMarkers()
}
