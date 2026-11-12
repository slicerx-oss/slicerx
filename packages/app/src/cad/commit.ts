// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Committing a modeling job's result. A job reads an object, waits on the engine, and only then writes; meanwhile the
// person may move, recolor, rename, lock or delete the object, or open another project. So the commit reads the object
// as it is now: a deleted object takes nothing, and every field the job did not make keeps its current value.
import { withPlaced, type History } from '@slicerx/cad-history'
import { get, set, type PlateEntry } from '../state/store'
import { designColors, madeDesign, resolveSlots } from '../filament/slots'

/** What a modeling job makes: the geometry and, when it changes them, the history, kept dimensions, colors and placement. */
export type Made = Pick<PlateEntry, 'handle' | 'parts'> & Partial<Pick<PlateEntry, 'history' | 'dimensions' | 'colors' | 'transform' | 'paint'>>

/**
 * A job's history with the landing moves the object has as the job writes (History.placed): a design host may have
 * moved the design over to make room while the job worked, and that move's transform is the one the write keeps.
 */
export function placedNow<H extends History | undefined>(h: H, latest: PlateEntry): H {
  return (h ? withPlaced(h, latest.history?.placed) : h) as H
}

/**
 * Writes a job's result onto the object as it is now, in one store update. `others` carries kept dimensions on other
 * objects that followed the change. False when the object is gone, and then nothing is written. An instance no longer
 * shares the new geometry; paint, per triangle of the old mesh, goes too unless `keepPaint`.
 */
export function commitMade(objectId: string, made: (latest: PlateEntry) => Made, o: { others?: ReadonlyMap<string, Pick<PlateEntry, 'dimensions'>>; keepPaint?: boolean; exactReplay?: boolean } = {}): boolean {
  let done = false
  set((s) => {
    const latest = s.plate.find((p) => p.id === objectId)
    if (!latest) return s
    if (latest.history?.exact && !o.exactReplay) throw new Error('This operation does not preserve the required exact history. The design is unchanged.')
    done = true
    const { instanceOf: _was, paint, ...rest } = latest
    const next: PlateEntry = { ...rest, ...(o.keepPaint && paint ? { paint } : {}), ...made(latest) }
    return { plate: s.plate.map((p) => (p.id === objectId ? next : o.others?.has(p.id) ? { ...p, ...o.others.get(p.id) } : p)) }
  })
  return done
}

/**
 * Why a job's write found no object: the object is off the plate while its first step is open for editing (it comes
 * back when that edit ends), or it is gone. `gone` is the caller's own words for the second.
 */
export function goneError(objectId: string, gone = 'That object is gone.'): Error {
  const ed = get().historyEdit
  return new Error(ed?.objectId === objectId && ed.hidden ? `The first step of ${ed.original.name} is open for editing, so nothing changed. Finish or cancel that edit, then try again.` : gone)
}

/** Colors for a new set of parts: each part keeps its slot's color, and new parts take the last one. */
export function colorsFor(count: number, colors: readonly string[], fallback: string): string[] {
  return Array.from({ length: count }, (_, i) => colors[i] ?? colors[colors.length - 1] ?? fallback)
}

/**
 * Colors for an object's new parts: a design made here takes each part's filament color (it has no file colors of its
 * own); anything else keeps its colors by part, new parts taking the last one.
 */
export function partColors(entry: Pick<PlateEntry, 'colors' | 'slotOverrides' | 'handle'>, parts: PlateEntry['parts'], history: History | undefined, fallback: string): string[] {
  if (!history || !madeDesign({ history })) return colorsFor(parts.length, entry.colors, fallback)
  const s = get()
  const padded = colorsFor(parts.length, entry.colors, fallback)
  return designColors({ ...entry, parts, colors: padded }, s.plates.find((p) => p.id === s.activePlate), resolveSlots(s))
}
