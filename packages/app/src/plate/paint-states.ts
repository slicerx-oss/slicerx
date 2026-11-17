// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The filaments color paint names, read and rewritten in the paint text itself (the code 3MF projects write,
// packages/threemf/src/paint-text.ts), without the viewport's paint trees: a removed or renumbered mix takes its
// paint along.
import { leftOnMix, type MixedFilament } from '@slicerx/settings/mixed'
import { paintTextStates, remapPaintText } from '@slicerx/threemf/paint-text'
import type { PaintData, PlateEntry, PlateMeta } from '../state/store'

export { remapPaintText }

const statesOf = new WeakMap<PaintData, Set<number>>()

/** The filaments an object's color paint names (painted pieces only), worked out once per paint. */
export function colorPaintStates(e: Pick<PlateEntry, 'paint'>): Set<number> {
  if (!e.paint) return new Set()
  const known = statesOf.get(e.paint)
  if (known) return new Set(known)
  const out = readStates(e)
  statesOf.set(e.paint, out)
  return new Set(out)
}

function readStates(e: Pick<PlateEntry, 'paint'>): Set<number> {
  const out = new Set<number>()
  for (const layers of Object.values(e.paint ?? {})) for (const text of Object.values(layers?.color ?? {})) for (const x of paintTextStates(text)) out.add(x)
  return out
}

/**
 * An object with its parts and color paint on `map`'s keys moved to their values: what a plate's mix being removed or
 * renumbered does to the objects on it. The same object when nothing changes.
 */
export function remapEntry<E extends Pick<PlateEntry, 'slotOverrides' | 'paint'> & { handle: { parts: { name: string; slot: number }[] } }>(e: E, map: ReadonlyMap<number, number>): E {
  if (!map.size) return e
  let changed = false
  const own: Record<string, number> = { ...e.slotOverrides }
  for (const part of e.handle.parts) {
    const now = own[part.name] ?? part.slot
    const to = map.get(now)
    if (to === undefined) continue
    if (to === part.slot) delete own[part.name]
    else own[part.name] = to
    changed = true
  }
  let paint: PaintData | undefined = e.paint
  for (const [part, layers] of Object.entries(e.paint ?? {})) {
    const color = layers?.color
    if (!color) continue
    let texts: Record<number, string> | null = null
    for (const [tri, text] of Object.entries(color)) {
      const next = remapPaintText(text, map)
      if (next === text) continue
      texts ??= { ...color }
      if (next === null) delete texts[Number(tri)]
      else texts[Number(tri)] = next
    }
    if (!texts) continue
    paint = { ...paint, [Number(part)]: { ...layers, color: texts } }
    changed = true
  }
  if (!changed) return e
  const { slotOverrides: _old, ...rest } = e
  return { ...rest, ...(Object.keys(own).length ? { slotOverrides: own } : {}), ...(paint ? { paint } : {}) } as E
}

/**
 * The mixes a plate's printable objects use, by their parts or their color paint: the ones its slice sends. A plate
 * with something left on a deleted mix's number sends every mix, so the engine prints that number with the filament
 * it falls back to (a mix nothing uses changes nothing else).
 */
export function usedMixes(plate: Pick<PlateMeta, 'objects'>, mixes: readonly MixedFilament[]): MixedFilament[] {
  if (!mixes.length) return []
  const used = new Set<number>()
  for (const e of plate.objects) {
    if (e.printable === false) continue
    for (const part of e.handle.parts) used.add(e.slotOverrides?.[part.name] ?? part.slot)
    for (const s of colorPaintStates(e)) used.add(s)
  }
  if ([...used].some((n) => leftOnMix(mixes, n))) return [...mixes]
  return mixes.filter((m) => used.has(m.id))
}
