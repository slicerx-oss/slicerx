// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Committing a modeling job's result. A job reads an object, waits on the engine, and only then writes; meanwhile the
// person may move, recolor, rename, lock or delete the object, or open another project. So the commit reads the object
// as it is now: a deleted object takes nothing, and every field the job did not make keeps its current value.
import { set, type PlateEntry } from '../state/store'

/** What a modeling job makes: the geometry and, when it changes them, the history, kept dimensions, colors and placement. */
export type Made = Pick<PlateEntry, 'handle' | 'parts'> & Partial<Pick<PlateEntry, 'history' | 'dimensions' | 'colors' | 'transform'>>

/**
 * Writes a job's result onto the object as it is now, in one store update. `others` carries kept dimensions on other
 * objects that followed the change. False when the object is gone, and then nothing is written. An instance no longer
 * shares the new geometry; paint, per triangle of the old mesh, goes too unless `keepPaint`.
 */
export function commitMade(objectId: string, made: (latest: PlateEntry) => Made, o: { others?: ReadonlyMap<string, Pick<PlateEntry, 'dimensions'>>; keepPaint?: boolean } = {}): boolean {
  let done = false
  set((s) => {
    const latest = s.plate.find((p) => p.id === objectId)
    if (!latest) return s
    done = true
    const { instanceOf: _was, paint, ...rest } = latest
    const next: PlateEntry = { ...rest, ...(o.keepPaint && paint ? { paint } : {}), ...made(latest) }
    return { plate: s.plate.map((p) => (p.id === objectId ? next : o.others?.has(p.id) ? { ...p, ...o.others.get(p.id) } : p)) }
  })
  return done
}

/** Colors for a new set of parts: each part keeps its slot's color, and new parts take the last one. */
export function colorsFor(count: number, colors: readonly string[], fallback: string): string[] {
  return Array.from({ length: count }, (_, i) => colors[i] ?? colors[colors.length - 1] ?? fallback)
}
