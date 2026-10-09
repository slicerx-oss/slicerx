// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plain 3MF whose objects touch or overlap (a model's parts saved as separate objects, the bands of a two color
// model) opens as one object with those parts, as Bambu Studio offers ("Multi-part object detected"). The open note
// says so and can keep them separate instead.
import type { ImportedObject } from '../export/import3mf'
import { invert, mergeParts } from '../plate/mesh-ops'
import { multiply, type Mat4 } from '../plate/transform'

/** Objects this close count as touching, as the fit check's notes count them. */
const TOUCH_MM = 0.005

/** Groups of two or more object indices joined by touching pairs, in file order. */
export function touchGroups(count: number, pairs: readonly [number, number][]): number[][] {
  const root = Array.from({ length: count }, (_, i) => i)
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i]!)))
  for (const [a, b] of pairs) root[find(b)] = find(a)
  const groups = new Map<number, number[]>()
  for (let i = 0; i < count; i++) groups.set(find(i), [...(groups.get(find(i)) ?? []), i])
  return [...groups.values()].filter((g) => g.length > 1).sort((a, b) => a[0]! - b[0]!)
}

/** Whether an object is plain geometry, nothing a join would have to carry over between objects. */
function plain(o: ImportedObject): boolean {
  return o.volumes.length === 0 && !o.paint && !o.layerRanges?.length && !o.brimPoints?.length && !Object.keys(o.rawPartSettings ?? {}).length && o.printable !== false
}

/**
 * The pairs of objects that touch or overlap, by index. Only plain objects are checked, and only pairs whose boxes
 * meet are measured (the fit check, part against part).
 */
export async function touchingPairs(objects: readonly ImportedObject[], minGapMm: number, layerHeightMm: number): Promise<[number, number][]> {
  const checked = objects.map((o, i) => ({ id: String(i), parts: o.parts, transform: o.transform })).filter((_, i) => plain(objects[i]!))
  if (checked.length < 2) return []
  const { checkTouches } = await import('../plate/fit-run')
  const found = await checkTouches(checked, minGapMm, layerHeightMm, new AbortController().signal)
  return found.filter((t) => t.gapMm < TOUCH_MM).map((t) => [Number(t.ids[0]), Number(t.ids[1])])
}

/** One object with the group's parts, in the first object's frame; each part keeps its filament. */
export function joinObjects(objects: readonly ImportedObject[], name: string): ImportedObject {
  const first = objects[0]!
  return { ...first, name, parts: mergeParts(objects), transform: [...first.transform] }
}

/**
 * The separate objects again, where the joined one is now: each keeps its place relative to the joined object, so a
 * move made since goes with them.
 */
export function separateAgain(joinedNow: Mat4, joinedAtOpen: Mat4, objects: readonly ImportedObject[]): Mat4[] {
  const moved = multiply(joinedNow, invert(joinedAtOpen))
  return objects.map((o) => multiply(moved, o.transform))
}
