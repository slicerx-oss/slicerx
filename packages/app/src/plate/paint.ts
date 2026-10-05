// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Paint on objects: filament color, seam position, support blockers and enforcers, and fuzzy skin, painted with the
// viewport's brush. A stroke is one undo step: the plate in the store holds the paint, so the history
// that restores the plate restores the paint too. The texts use the paint_color encoding of Bambu Studio
// and OrcaSlicer, which is also what goes in the 3MF.
import type { SettingValue } from '@slicerx/contracts'
import { resolveConfig } from '../adapters/config'
import { get, markStale, set, toast, type PaintData, type PaintLayerName, type PlateEntry } from '../state/store'
import { objectOverrides, setObjectSetting } from './object-settings'

export interface StrokeEdits {
  objectId: string
  partIndex: number
  layer: PaintLayerName
  edits: readonly { triangle: number; after: string | null }[]
}

export function hasPaint(p: PaintData | undefined): boolean {
  return Boolean(p && Object.values(p).some((layers) => Object.values(layers).some((t) => t && Object.keys(t).length)))
}

function withEdits(paint: PaintData | undefined, e: StrokeEdits): PaintData | undefined {
  const next: PaintData = { ...(paint ?? {}) }
  const part = { ...(next[e.partIndex] ?? {}) }
  const layer = { ...(part[e.layer] ?? {}) }
  for (const { triangle, after } of e.edits) {
    if (after === null || after === '') delete layer[triangle]
    else layer[triangle] = after
  }
  if (Object.keys(layer).length) part[e.layer] = layer
  else delete part[e.layer]
  if (Object.keys(part).length) next[e.partIndex] = part
  else delete next[e.partIndex]
  return Object.keys(next).length ? next : undefined
}

/** Writes a finished stroke into the object. Instances copy the object, so they keep their own paint. */
export function commitStroke(e: StrokeEdits): void {
  const entry = get().plate.find((p) => p.id === e.objectId)
  if (!entry || e.edits.length === 0) return
  const paint = withEdits(entry.paint, e)
  const { paint: _old, ...rest } = entry
  set({ plate: get().plate.map((p) => (p.id === entry.id ? ({ ...rest, ...(paint ? { paint } : {}) } as PlateEntry) : p)) })
  if (e.layer === 'fuzzy' && e.edits.some((x) => x.after)) enablePaintedFuzzy(entry)
  markStale()
}

/**
 * Painting fuzzy skin turns it on where painted. With fuzzy skin set to Disabled (the default), paint
 * would do nothing, so the object switches to Painted only (`fuzzy_skin` none) and says so; OrcaSlicer
 * shows a warning with a link to do the same.
 */
function enablePaintedFuzzy(entry: PlateEntry): void {
  const s = get()
  const effective = { ...(resolveConfig(s.easy, s.overrides) as Record<string, SettingValue>), ...objectOverrides(s, entry) }
  if (effective['fuzzy_skin'] !== undefined && effective['fuzzy_skin'] !== 'disabled_fuzzy') return
  setObjectSetting(entry.id, 'fuzzy_skin', 'none')
  toast(`Fuzzy skin is on where you paint ${entry.name}; the rest of its walls stay smooth.`, 'info')
}

/** Removes every painted triangle of one layer, or all layers, from an object. */
export function clearPaint(objectId: string, layer?: PaintLayerName): void {
  const entry = get().plate.find((p) => p.id === objectId)
  if (!entry?.paint) return
  const next: PaintData = {}
  for (const [part, layers] of Object.entries(entry.paint)) {
    const kept = Object.fromEntries(Object.entries(layers).filter(([l]) => layer !== undefined && l !== layer)) as PaintData[number]
    if (Object.keys(kept).length) next[Number(part)] = kept
  }
  const { paint: _old, ...rest } = entry
  set({ plate: get().plate.map((p) => (p.id === objectId ? ({ ...rest, ...(Object.keys(next).length ? { paint: next } : {}) } as PlateEntry) : p)) })
  markStale()
}

/** Paint as the triangle texts of one part and layer, for the viewport. */
export function paintTexts(entry: Pick<PlateEntry, 'paint'>, partIndex: number, layer: PaintLayerName): Record<number, string> | null {
  return entry.paint?.[partIndex]?.[layer] ?? null
}
