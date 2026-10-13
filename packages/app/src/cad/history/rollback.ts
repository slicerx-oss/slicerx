// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Rolling the design back, the way Fusion's timeline marker does: every body shows itself as it was at the marker,
// and a body made after it leaves the plate until the marker moves past it again. Slicing, printing and exporting
// use what the plate shows, and say so (rolledBackNote in plate/timeline.ts). Moving the marker is an undo step.
import { historyOf, type History, type Timeline } from '@slicerx/cad-history'
import type { MeshHandle } from '@slicerx/contracts'
import { brandAccent } from '../../edition'
import { colorsFor } from '../commit'
import { get, markStale, set, type AppState, type PlateEntry, type Rollback } from '../../state/store'
import { cancelEdit, runReplay, toPart, withStatus } from './ops'

type Loader = { loadParts(name: string, parts: PlateEntry['parts']): Promise<MeshHandle> }

/** The same steps, by id and in order, so a body needs no replay. */
const same = (a: History | undefined, b: History) => !!a && a.steps.length === b.steps.length && a.steps.every((s, i) => s.id === b.steps[i]!.id)

/** Every object on every plate, by id, with the plate it is on; bodies held off the plates included. */
function placed(s: Pick<AppState, 'plate' | 'plates' | 'activePlate' | 'rollback'>): Map<string, { plate: string; entry: PlateEntry }> {
  const out = new Map<string, { plate: string; entry: PlateEntry }>()
  for (const p of s.plates) for (const e of p.id === s.activePlate ? s.plate : p.objects) out.set(e.id, { plate: p.id, entry: e })
  for (const h of s.rollback?.ends ?? []) if (!out.has(h.entry.id)) out.set(h.entry.id, h)
  return out
}

/**
 * Moves the marker to `marker` (0 is before everything, the item count is the end): bodies whose live steps change
 * replay to it, bodies with nothing yet leave the plate, and every object comes back as it was once at the end.
 */
export async function rollTo(host: Loader, marker: number): Promise<void> {
  cancelEdit()
  const s0 = get()
  const t: Timeline = { ...s0.timeline, marker: Math.max(0, Math.min(marker, s0.timeline.items.length)) }
  const end = t.marker >= t.items.length
  const all = placed(s0)
  const ends = new Map((s0.rollback?.ends ?? []).map((h) => [h.entry.id, h]))
  const views = new Map<string, PlateEntry | null>()
  for (const b of t.bodies) {
    const at = all.get(b.id)
    const h = historyOf(t, b.id)
    if (!at || !h) continue
    const kept = ends.get(b.id)?.entry
    if (!h.base.length && !h.steps.length) views.set(b.id, null)
    else if (same(at.entry.history, h)) views.set(b.id, at.entry)
    else if (kept && same(kept.history, h)) views.set(b.id, kept)
    else {
      const r = await runReplay({ history: h })
      if (r.parts.length === 0) {
        views.set(b.id, null)
        continue
      }
      const parts = r.parts.map(toPart)
      const handle = await host.loadParts(at.entry.name, parts)
      const { paint: _p, instanceOf: _i, ...rest } = at.entry
      views.set(b.id, { ...rest, handle, parts, colors: colorsFor(parts.length, at.entry.colors, brandAccent()), history: { ...h, steps: withStatus(h.steps, r.status, r.found) } })
    }
  }
  set((s) => {
    const now = placed(s)
    // as each object is at the end: kept from the first roll back, or as it is now for one never rolled
    const keep: Rollback['ends'] = end ? [] : [...now.values()].map((x) => ends.get(x.entry.id) ?? x)
    const show = (e: PlateEntry): PlateEntry | null => (views.has(e.id) ? views.get(e.id)! : e)
    const onPlate = (plateId: string, list: readonly PlateEntry[]) => {
      const back = [...now.values()].filter((x) => x.plate === plateId && !list.some((e) => e.id === x.entry.id)).map((x) => x.entry)
      return [...list, ...back].map(show).filter((e): e is PlateEntry => e !== null)
    }
    const plate = onPlate(s.activePlate, s.plate)
    const gone = !plate.some((e) => e.id === s.selection)
    return {
      plate,
      plates: s.plates.map((p) => (p.id === s.activePlate ? p : { ...p, objects: onPlate(p.id, p.objects) })),
      timeline: t,
      rollback: end ? null : { at: t.marker, ends: keep },
      ...(gone ? { selection: null, selectedIds: [] } : {}),
    }
  })
  markStale()
}

/** After opening a file saved rolled back: bodies made after the marker leave the plate, the others already show it. */
export function settleRollback(): void {
  const s = get()
  const t = s.timeline
  if (t.marker >= t.items.length || s.rollback) return
  const all = placed(s)
  const hide = new Set(t.bodies.filter((b) => {
    const h = historyOf(t, b.id)
    return h !== null && !h.base.length && !h.steps.length
  }).map((b) => b.id))
  const ends = [...all.values()].map((x) => (hide.has(x.entry.id) ? { ...x, entry: { ...x.entry, history: historyOf({ ...t, marker: t.items.length }, x.entry.id)! } } : x))
  set({
    plate: s.plate.filter((e) => !hide.has(e.id)),
    plates: s.plates.map((p) => (p.id === s.activePlate ? p : { ...p, objects: p.objects.filter((e) => !hide.has(e.id)) })),
    rollback: { at: t.marker, ends },
  })
}
