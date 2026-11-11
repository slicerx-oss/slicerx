// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Paint between a design's history and the plate. A paint step in a history (a waterline painted in a filament by the
// paint tools) leaves its paint on the replayed parts; the plate keeps an object's paint by part (PlateEntry.paint),
// which the viewport shows, the slice sends and a save writes. So the object a replay makes takes the replay's paint,
// and a design read from the plate has its parts' paint, so a new paint step paints over what is there.
import type { HistoryMesh } from '@slicerx/cad-history'
import type { PaintData, PlateEntry } from '../../state/store'

/** The paint the replayed parts carry, by part, as the plate keeps it; undefined when nothing is painted. */
export function paintOf(parts: readonly Pick<HistoryMesh, 'paint'>[]): PaintData | undefined {
  const out: PaintData = {}
  parts.forEach((p, i) => {
    const layers = Object.fromEntries(Object.entries(p.paint ?? {}).filter(([, t]) => t && Object.keys(t).length))
    if (Object.keys(layers).length) out[i] = layers
  })
  return Object.keys(out).length ? out : undefined
}

/** The object's parts, each with the paint the plate keeps for it. */
export function withPaint(e: Pick<PlateEntry, 'parts' | 'paint'>): HistoryMesh[] {
  if (!e.paint) return e.parts
  return e.parts.map((p, i) => {
    const paint = e.paint?.[i]
    return paint && Object.keys(paint).length ? { ...p, paint } : p
  })
}
