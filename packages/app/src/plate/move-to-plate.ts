// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Moving objects to another plate: arranged into its free space, or set in the middle of an empty plate (placeOnPlate). Apart from plates.ts, so the arrange code
// it needs loads with the screens that move objects and not with the web shell (apps/web bundle-size budget).
import { get, markStale, selectedIds, set, type PlateEntry } from '../state/store'
import { placeOnPlate } from './arrange'

/** Moves the selected objects to another plate, placed as placeOnPlate places them. */
export function moveSelectedToPlate(targetId: string): number {
  return moveObjectsToPlate(targetId, selectedIds(get()))
}

/**
 * Moves only the named concrete objects, using the same placement as the plate menu: Move to plate, plate edge drag and
 * the app link's plate move all come here, so each puts a part in the same spot.
 */
export function moveObjectsToPlate(targetId: string, objectIds: readonly string[], requireFit = false): number {
  const s = get()
  if (targetId === s.activePlate) return 0
  const target = s.plates.find((p) => p.id === targetId)
  const ids = new Set(objectIds)
  if (!target || ids.size === 0) return 0
  const moving: PlateEntry[] = s.plate.filter((p) => ids.has(p.id))
  const r = placeOnPlate(moving, target.objects, s.bed)
  if (requireFit && (r.leftOver.length || moving.some((o) => !r.transforms[o.id]))) return 0
  const placed = moving.map((m) => (r.transforms[m.id] ? { ...m, transform: r.transforms[m.id]! } : m))
  set({
    plate: s.plate.filter((p) => !ids.has(p.id)),
    plates: s.plates.map((p) => (p.id === targetId ? { ...p, objects: [...p.objects, ...placed] } : p)),
    selection: null,
    selectedIds: [],
  })
  markStale()
  return moving.length
}
