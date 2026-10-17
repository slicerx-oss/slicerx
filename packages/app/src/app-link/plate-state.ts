// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { plateRows } from '../plate/plate-step'
import { allPlates } from '../plate/plates'
import { objectOverrides, partOverridesOf } from '../plate/object-settings'
import { bounds } from '../plate/transform'
import { get } from '../state/store'
import { drawnObjects } from '../viewport/drawn'
const round = (v: number) => Math.round(v * 1000) / 1000

/** The objects the view draws, when they are exactly some plate's; the plate in view first, for empty plates. */
export function drawnPlate(): number | null | undefined {
  const ids = drawnObjects()
  if (ids === null) return undefined
  const s = get()
  const on = (p: { id: string; objects: { id: string }[] }) => (p.id === s.activePlate ? s.plate : p.objects).map((o) => o.id)
  // Only plate objects count: the view also draws its own extras (the prime tower).
  const known = new Set(s.plates.flatMap(on))
  const drawn = new Set(ids.filter((id) => known.has(id)))
  const same = (p: { id: string; objects: { id: string }[] }) => {
    const mine = on(p)
    return mine.length === drawn.size && mine.every((id) => drawn.has(id))
  }
  const order = [...s.plates.entries()].sort(([, a], [, b]) => Number(b.id === s.activePlate) - Number(a.id === s.activePlate))
  const hit = order.find(([, p]) => same(p))
  return hit ? hit[0] + 1 : null
}

/**
 * Read every plate without navigating, including concrete copies and per-object overrides. `drawn` is
 * the plate whose objects the view draws (it matches `shown` once the view has caught up; null while it draws none of them
 * as they are), left out when no view is up.
 */
export function platesState() {
  const s = get()
  const rows = plateRows(s)
  const plates = allPlates(s).map((p, i) => {
    const row = rows[i]!
    return {
      number: row.number, id: p.id, name: p.name, objects: p.objects.length, slice: row.state, shown: row.shown,
      settings: structuredClone(p.settings),
      entries: p.objects.map((e) => {
        const b = bounds(e.parts, e.transform)
        return {
          id: e.id, name: e.name, instanceOf: e.instanceOf ?? null, locked: e.locked ?? false, printable: e.printable !== false,
          transform: e.transform.map(round), settings: structuredClone(objectOverrides(s, e)),
          partSettings: structuredClone(partOverridesOf(p.objects, e)), slotOverrides: { ...e.slotOverrides },
          ...(b ? { minMm: b.min.map(round), maxMm: b.max.map(round), sizeMm: b.max.map((v, j) => round(v - b.min[j]!)) } : {}),
        }
      }),
    }
  })
  const drawn = drawnPlate()
  return { shown: rows.find((r) => r.shown)?.number ?? 1, ...(drawn !== undefined ? { drawn } : {}), count: plates.length, plates }
}

