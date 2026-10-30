// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Moving objects to another plate, which arranges them into its free space. Apart from plates.ts, so the arrange code
// it needs loads with the screens that move objects and not with the web shell (apps/web bundle-size budget).
import { get, markStale, selectedIds, set, type PlateEntry } from '../state/store'
import { arrange } from './arrange'

/** Moves the selected objects to another plate and arranges them into its free space. */
export function moveSelectedToPlate(targetId: string): number {
  return moveObjectsToPlate(targetId, selectedIds(get()))
}

/** Moves only the named concrete objects, using the same placement as the plate menu. */
export function moveObjectsToPlate(targetId: string, objectIds: readonly string[], requireFit = false): number {
  const s = get()
  if (targetId === s.activePlate) return 0
  const target = s.plates.find((p) => p.id === targetId)
  const ids = new Set(objectIds)
  if (!target || ids.size === 0) return 0
  const moving: PlateEntry[] = s.plate.filter((p) => ids.has(p.id))
  const r = arrange(moving, target.objects, s.bed)
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
