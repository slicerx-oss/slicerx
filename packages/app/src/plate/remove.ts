// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { get, markStale, selectedIds, set, type PlateEntry } from '../state/store'
import { partOverridesOf } from './object-settings'

/** Remove concrete objects from the shown plate, keeping surviving copy families and measurements valid. */
export function removeObjects(wanted: readonly string[]): string[] {
  const s = get()
  const ids = new Set(s.plate.filter((e) => wanted.includes(e.id)).map((e) => e.id))
  if (!ids.size) return []
  const all = [...s.plate, ...s.plates.filter((p) => p.id !== s.activePlate).flatMap((p) => p.objects)]
  const settings = { ...s.objectSettings }
  const roots = new Map<string, string>()
  for (const id of ids) {
    const next = all.find((e) => !ids.has(e.id) && e.instanceOf === id)
    if (next) {
      roots.set(id, next.id)
      if (settings[id]) settings[next.id] = { ...settings[id] }
    }
    delete settings[id]
  }
  const remap = (e: PlateEntry): PlateEntry => {
    let out = e
    const root = e.instanceOf ? roots.get(e.instanceOf) : undefined
    if (root) {
      const { instanceOf: _old, ...rest } = e
      out = e.id === root ? { ...rest, partSettings: { ...partOverridesOf(all, e) } } : { ...rest, instanceOf: root }
    }
    if (out.dimensions) {
      const dimensions = out.dimensions.filter((d) => !ids.has(d.a.object) && (!d.b || !ids.has(d.b.object)))
      if (dimensions.length !== out.dimensions.length) out = { ...out, dimensions }
    }
    return out
  }
  const remaining = selectedIds(s).filter((id) => !ids.has(id))
  const selection = s.selection && !ids.has(s.selection) ? s.selection : remaining[0] ?? null
  set({
    plate: s.plate.filter((e) => !ids.has(e.id)).map(remap),
    plates: s.plates.map((p) => p.id === s.activePlate ? p : { ...p, objects: p.objects.map(remap) }),
    objectSettings: settings, selection, selectedIds: remaining,
  })
  markStale()
  return [...ids]
}
