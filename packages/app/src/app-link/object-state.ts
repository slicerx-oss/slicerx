// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { objectOverrides, partOverridesOf } from '../plate/object-settings'
import { bounds } from '../plate/transform'
import { get, type PlateEntry } from '../state/store'

const PAINT_LAYERS = ['color', 'seam', 'support', 'fuzzy'] as const
const round = (v: number): number => Math.round(v * 1000) / 1000

/** The concrete object on the shown plate, without mesh buffers. */
export function objectState(e: PlateEntry) {
  const s = get()
  const b = bounds(e.parts, e.transform)
  const settings = partOverridesOf([...s.plate, ...s.plates.filter((p) => p.id !== s.activePlate).flatMap((p) => p.objects)], e)
  return {
    id: e.id,
    name: e.name,
    parts: e.parts.length,
    partDetails: e.parts.map((p, i) => ({ name: p.name, triangles: p.indices.length / 3, slot: e.slotOverrides?.[p.name] ?? p.slot, settings: settings[p.name] ?? {}, paintedTriangles: Object.fromEntries(PAINT_LAYERS.map((layer) => [layer, Object.keys({ ...p.paint?.[layer], ...e.paint?.[i]?.[layer] }).length])) })),
    locked: e.locked === true,
    printable: e.printable !== false,
    settings: objectOverrides(s, e),
    volumes: (e.volumes ?? []).map((v) => ({ id: v.id, name: v.name, role: v.role, local: v.local.map(round), settings: v.settings ?? {} })),
    layerRanges: e.layerRanges ?? [],
    brimPoints: e.brimPoints ?? [],
    measurements: e.dimensions?.length ?? 0,
    ...(e.instanceOf ? { instanceOf: e.instanceOf } : {}),
    transform: e.transform.map(round),
    ...(b ? { minMm: b.min.map(round), maxMm: b.max.map(round), sizeMm: b.max.map((v, i) => round(v - b.min[i]!)) } : {}),
    ...(e.history ? { steps: e.history.steps.length, ...(e.history.ended ? { historyEnded: e.history.ended } : {}) } : {}),
  }
}
