// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { plateRows } from '../plate/plate-step'
import { allPlates } from '../plate/plates'
import { objectOverrides, partOverridesOf } from '../plate/object-settings'
import { bounds } from '../plate/transform'
import { get } from '../state/store'
const round = (v: number) => Math.round(v * 1000) / 1000

/** Read every plate without navigating, including concrete copies and per-object overrides. */
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
  return { shown: rows.find((r) => r.shown)?.number ?? 1, count: plates.length, plates }
}

