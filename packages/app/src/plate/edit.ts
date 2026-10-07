// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Plate edits on the app store. Each one replaces `plate` once, so undo sees one step, and marks a
// finished slice stale. The math lives in ./transform.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { get, markStale, selectedIds, set, toast, type PlateEntry } from '../state/store'
import { bake, mergeParts, primitive, splitToObjects, splitToParts, type PrimitiveShape } from './mesh-ops'
import { arrange, ARRANGE_DEFAULTS, fillCount, type ArrangeOptions, type ArrangeResult } from './arrange'
import { NEST_STEP_DEFAULT, nestArrange, nestFill, type NestRun } from './nest'
import { quietly } from './history'
import { bounds, centerOnBed, compose, dropToBed, identity, layOnFace, mirror, scaleToSize, setScale, withTrs, type Mat4, type Trs, type Vec3 } from './transform'
import { brandAccent, objectPalette } from '../edition'

function updateObject(id: string | null, fn: (p: PlateEntry) => Mat4): boolean {
  if (!id) return false
  const { plate } = get()
  const target = plate.find((p) => p.id === id)
  if (!target) return false
  if (target.locked) {
    toast(`${target.name} is locked. Unlock it to move it.`, 'info')
    return false
  }
  const transform = fn(target)
  if (transform.every((v, i) => v === target.transform[i])) return false
  set({ plate: plate.map((p) => (p.id === id ? { ...p, transform } : p)) })
  markStale()
  return true
}

const selected = () => get().selection

export function selectedEntry(): PlateEntry | undefined {
  const { plate, selection } = get()
  return plate.find((p) => p.id === selection)
}

/** Position, rotation or scale from the numeric fields. Position is exact; rotation and scale keep the object on the bed. */
export function setTrs(patch: Partial<Trs>, id: string | null = selected()): boolean {
  return updateObject(id, (p) => {
    if (patch.scale && !patch.position && !patch.rotation) return setScale(p.parts, p.transform, patch.scale)
    const next = withTrs(p.transform, patch)
    return patch.rotation && !patch.position ? dropToBed(p.parts, next) : next
  })
}

export function scaleSelectedToSize(axis: 0 | 1 | 2, sizeMm: number, uniform: boolean, id: string | null = selected()): boolean {
  return updateObject(id, (p) => scaleToSize(p.parts, p.transform, axis, sizeMm, uniform))
}

export function dropSelectedToBed(id: string | null = selected()): boolean {
  return updateObject(id, (p) => dropToBed(p.parts, p.transform))
}

export function centerSelected(id: string | null = selected()): boolean {
  return updateObject(id, (p) => centerOnBed(p.parts, p.transform, get().bed))
}

export function mirrorSelected(axis: 0 | 1 | 2, id: string | null = selected()): boolean {
  return updateObject(id, (p) => mirror(p.parts, p.transform, axis))
}

/** Lay on face from the viewport's face pick: the picked face goes down on the bed. */
export function layOnPickedFace(pick: { objectId: string; normal: Vec3; centerBed: Vec3 }): boolean {
  const ok = updateObject(pick.objectId, (p) => layOnFace(p.parts, p.transform, pick.normal, pick.centerBed))
  if (ok) set({ selection: pick.objectId })
  return ok
}

/** Final transforms from a gizmo drag or an arrange: one undo step for all of them. */
export function commitTransforms(transforms: Record<string, number[]>): void {
  const { plate } = get()
  let changed = false
  let refused = false
  const next = plate.map((p) => {
    const t = transforms[p.id]
    if (!t || t.every((v, i) => v === p.transform[i])) return p
    // A locked object stays where it is, even when a drag or an arrange moved it in the viewport.
    if (p.locked) {
      refused = true
      return p
    }
    changed = true
    return { ...p, transform: t }
  })
  if (refused) toast('A locked object was not moved.', 'info')
  if (!changed) {
    // Put the viewport back where the store says the objects are.
    if (refused) quietly(() => set({ plate: [...plate] }))
    return
  }
  set({ plate: next })
  markStale()
}

// ---------------------------------------------------------------------------
// Selection, arrange, instances

/** Click in the object list: plain replaces, Mod or Shift adds or removes. */
export function selectObject(id: string, additive: boolean): void {
  const s = get()
  if (!additive) {
    set({ selection: id, selectedIds: [id] })
    return
  }
  const cur = selectedIds(s)
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
  set({ selection: next.includes(s.selection ?? '') ? s.selection : (next[next.length - 1] ?? null), selectedIds: next })
}

export function selectAll(): void {
  const ids = get().plate.map((p) => p.id)
  set({ selection: ids[0] ?? null, selectedIds: ids })
}

let arrangeOptions: ArrangeOptions = { ...ARRANGE_DEFAULTS, rotate: true, stepDeg: NEST_STEP_DEFAULT }

/** The quick box placement for new copies and primitives keeps them square to the bed. */
const placeOptions = (): ArrangeOptions => ({ ...arrangeOptions, rotate: false })

let arrangeRun = 0

/** Progress in the status line while a long arrange runs; a newer arrange makes an older one stop. */
function runHooks(): Required<NestRun> & { token: number } {
  const token = ++arrangeRun
  return {
    token,
    stop: () => token !== arrangeRun,
    progress: (done, total) => {
      if (token === arrangeRun) set({ arranging: { done, total } })
    },
  }
}

function endRun(token: number): void {
  if (token === arrangeRun && get().arranging) set({ arranging: null })
}

export function getArrangeOptions(): ArrangeOptions {
  return arrangeOptions
}

export function setArrangeOptions(o: Partial<ArrangeOptions>): void {
  arrangeOptions = { ...arrangeOptions, ...o }
}

/**
 * Arrange every object, or only the selected ones around the rest, on their true outlines (nest.ts), or
 * on their bounds when the geometry engine cannot run. Returns how many did not fit.
 */
export async function arrangePlate(scope: 'all' | 'selection' = 'all', opts: ArrangeOptions = arrangeOptions): Promise<number> {
  const { plate, bed } = get()
  const ids = new Set((scope === 'selection' ? selectedIds() : plate.map((p) => p.id)).filter((id) => !plate.find((p) => p.id === id)?.locked))
  if (ids.size === 0) return 0
  const moving = plate.filter((p) => ids.has(p.id))
  const fixed = plate.filter((p) => !ids.has(p.id))
  const hooks = runHooks()
  // Busy from the first moment, before the first layout is tried (total 0 until the nester knows).
  set({ arranging: { done: 0, total: 0 } })
  let r: ArrangeResult
  try {
    r = await nestArrange(moving, fixed, bed, opts, hooks)
  } catch {
    r = arrange(moving, fixed, bed, opts)
  } finally {
    endRun(hooks.token)
  }
  if (hooks.stop()) return r.leftOver.length
  // Objects moved by hand while the arrange ran keep the new place.
  const now = new Map(get().plate.map((p) => [p.id, p.transform]))
  const was = new Map(moving.map((p) => [p.id, p.transform]))
  const transforms = Object.fromEntries(Object.entries(r.transforms).filter(([id]) => now.get(id) === was.get(id)))
  commitTransforms(transforms)
  const tooLarge = tooLargeNotice(r, plate)
  const rest = r.leftOver.length - r.tooLarge.length
  if (tooLarge) toast(tooLarge, 'warn')
  if (rest > 0) toast(`${rest} ${rest === 1 ? 'object does' : 'objects do'} not fit on the bed and stayed where ${rest === 1 ? 'it was' : 'they were'}.`, 'warn')
  return r.leftOver.length
}

/** Plain words for objects that cannot sit on the bed alone, or null when there are none. */
export function tooLargeNotice(r: Pick<ArrangeResult, 'tooLarge'>, plate: readonly { id: string; name: string }[]): string | null {
  if (r.tooLarge.length === 0) return null
  const name = (id: string) => plate.find((p) => p.id === id)?.name ?? 'An object'
  const margin = r.tooLarge.filter((t) => t.withoutMargin)
  if (margin.length === r.tooLarge.length) {
    const who = margin.length === 1 ? `${name(margin[0]!.id)} is` : `${margin.length} objects are`
    return `${who} too large for this bed once the brim and skirt around ${margin.length === 1 ? 'it are' : 'them are'} counted, so ${margin.length === 1 ? 'it' : 'they'} stayed where ${margin.length === 1 ? 'it was' : 'they were'}. Make ${margin.length === 1 ? 'it' : 'them'} smaller, turn the brim and skirt off, or choose a bigger printer.`
  }
  const who = r.tooLarge.length === 1 ? `${name(r.tooLarge[0]!.id)} is` : `${r.tooLarge.length} objects are`
  return `${who} larger than this bed and stayed where ${r.tooLarge.length === 1 ? 'it was' : 'they were'}. Make ${r.tooLarge.length === 1 ? 'it' : 'them'} smaller or choose a bigger printer.`
}

/** The object an instance copies, or the object itself. */
export function sourceOf(p: PlateEntry): string {
  return p.instanceOf ?? p.id
}

export function instanceCount(id: string): number {
  const { plate } = get()
  const src = plate.find((p) => p.id === id)
  if (!src) return 0
  const root = sourceOf(src)
  return plate.filter((p) => sourceOf(p) === root).length
}

let instSeq = 0

function copyOf(src: PlateEntry, root: string): PlateEntry {
  return { ...src, id: `${root}~${Date.now().toString(36)}${(++instSeq).toString(36)}`, instanceOf: root, transform: [...src.transform] }
}

/**
 * Sets how many copies of an object are on the plate (the object itself counts as one). New copies
 * are arranged into free space; removing takes the newest copies first.
 */
export function setInstanceCount(id: string, count: number): boolean {
  const { plate, bed } = get()
  const src = plate.find((p) => p.id === id)
  if (!src || count < 1 || count > 200) return false
  const root = sourceOf(src)
  const group = plate.filter((p) => sourceOf(p) === root)
  if (count === group.length) return false
  if (count < group.length) {
    const drop = new Set(group.filter((p) => p.instanceOf).slice(-(group.length - count)).map((p) => p.id))
    set({ plate: plate.filter((p) => !drop.has(p.id)), selection: id, selectedIds: [id] })
    markStale()
    return true
  }
  const base = plate.find((p) => p.id === root) ?? src
  const copies = Array.from({ length: count - group.length }, () => copyOf(base, root))
  const r = arrange(copies, plate, bed, placeOptions())
  const placed = copies.filter((c) => r.transforms[c.id]).map((c) => ({ ...c, transform: r.transforms[c.id]! }))
  if (placed.length < copies.length) toast(`Room for ${placed.length} more on this bed.`, 'warn')
  if (placed.length === 0) return false
  set({ plate: [...plate, ...placed] })
  markStale()
  return true
}

/** Puts copies of `src` on the plate at the given places, after the copies it has. */
function addCopies(src: PlateEntry, transforms: readonly Mat4[]): number {
  const { plate } = get()
  const root = sourceOf(src)
  const base = plate.find((p) => p.id === root) ?? src
  const room = Math.max(0, 200 - plate.filter((p) => sourceOf(p) === root).length)
  const placed = transforms.slice(0, room).map((t) => ({ ...copyOf(base, root), transform: [...t] }))
  if (placed.length === 0) return 0
  set({ plate: [...plate, ...placed] })
  markStale()
  return placed.length
}

/**
 * Fills the free space on the bed with copies of the selected object, nested on their true outlines
 * at any turn (or as boxes when the geometry engine cannot run). Returns how many were added.
 */
export async function fillBed(id: string | null = get().selection): Promise<number> {
  const { plate, bed } = get()
  const src = plate.find((p) => p.id === id)
  if (!src) return 0
  const hooks = runHooks()
  let nested: Awaited<ReturnType<typeof nestFill>> | null = null
  try {
    nested = await nestFill(src, plate, bed, arrangeOptions, 100, hooks)
  } catch {
    nested = null
  } finally {
    endRun(hooks.token)
  }
  if (hooks.stop()) return 0
  if (nested) {
    const added = nested.transforms.length > 0 && get().plate.includes(src) ? addCopies(src, nested.transforms) : 0
    if (added === 0) {
      const tooLarge = tooLargeNotice(nested, [src])
      if (tooLarge) toast(tooLarge, 'warn')
      else toast('No free space left on the bed.', 'info')
    }
    return added
  }
  const n = fillCount(src, plate.filter((p) => p.id !== src.id), bed, arrangeOptions, 100)
  if (n === 0) {
    const alone = arrange([{ ...src, id: `${src.id}~alone` }], [], bed, arrangeOptions)
    const tooLarge = tooLargeNotice(alone, [{ id: `${src.id}~alone`, name: src.name }])
    if (tooLarge) toast(tooLarge, 'warn')
    else toast('No free space left on the bed.', 'info')
    return 0
  }
  setInstanceCount(src.id, instanceCount(src.id) + n)
  return n
}

// ---------------------------------------------------------------------------
// Split, merge, primitives. These make new meshes, so they load them through the slicer host.

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }

let objSeq = 0
const newObjectId = () => `obj_${Date.now().toString(36)}${(++objSeq).toString(36)}`

function colorsFor(parts: readonly MeshPart[], from: readonly string[]): string[] {
  return parts.map((p) => from[p.slot - 1] ?? objectPalette()[(p.slot - 1) % 6]!)
}

/** Split to parts: each connected piece becomes a part of the same object. Returns the new part count. */
export async function splitSelectedToParts(host: Loader): Promise<number> {
  const src = selectedEntry()
  if (!src) return 0
  const parts = splitToParts(src.parts)
  if (parts.length <= src.parts.length) {
    toast('This object is one piece; there is nothing to split.', 'info')
    return 0
  }
  const handle = await host.loadParts(src.name, parts)
  // Splitting ends a CAD history: the parts are the new start.
  const history = src.history ? (await import('../cad/history/record')).endHistory(src, parts, 'the object was split into parts.') : undefined
  const { history: _h, ...plain } = src
  const cur = get().plate
  set({ plate: cur.map((p) => (p.id === src.id ? { ...plain, handle, parts, colors: colorsFor(parts, src.colors), ...(history ? { history } : {}) } : p)) })
  markStale()
  return parts.length
}

/** Split to objects: each connected piece becomes its own object, left where it was. */
export async function splitSelectedToObjects(host: Loader): Promise<number> {
  const src = selectedEntry()
  if (!src) return 0
  const pieces = splitToObjects(src.parts, src.transform)
  if (pieces.length === 0) {
    toast('This object is one piece; there is nothing to split.', 'info')
    return 0
  }
  const entries: PlateEntry[] = await Promise.all(
    pieces.map(async (piece, i) => {
      const name = `${src.name} ${i + 1}`
      const handle = await host.loadParts(name, piece.parts)
      return { id: newObjectId(), name, handle, parts: piece.parts, colors: colorsFor(piece.parts, src.colors), transform: piece.transform, ...(src.source ? { source: src.source } : {}) }
    }),
  )
  const cur = get().plate
  const at = cur.findIndex((p) => p.id === src.id)
  set({ plate: [...cur.slice(0, at), ...entries, ...cur.slice(at + 1)], selection: entries[0]?.id ?? null, selectedIds: entries.map((e) => e.id) })
  markStale()
  return entries.length
}

/** Merge the selected objects into the first one, as parts. */
export async function mergeSelected(host: Loader): Promise<boolean> {
  const ids = selectedIds()
  const plate = get().plate
  const objs = ids.map((id) => plate.find((p) => p.id === id)).filter((p): p is PlateEntry => Boolean(p))
  const first = objs[0]
  if (!first || objs.length < 2) {
    toast('Select two or more objects to merge.', 'info')
    return false
  }
  const parts = mergeParts(objs)
  const colors = objs.flatMap((o) => o.parts.map((p) => o.colors[p.slot - 1] ?? o.colors[0] ?? brandAccent()))
  const handle = await host.loadParts(first.name, parts)
  const drop = new Set(objs.slice(1).map((o) => o.id))
  // The merged object is its own thing now, not an instance of anything.
  const { instanceOf: _was, ...rest } = first
  // In a CAD history the merge is a step that adds the other objects' meshes; their own histories are not kept.
  const history = first.history ? (await import('../cad/history/record')).withStep(first, -1, { op: 'parts.add', parts: parts.slice(first.parts.length), label: `Merge with ${objs.slice(1).map((o) => o.name).join(', ')}`.slice(0, 80) }) : undefined
  // Merging with a Vault design keeps the merged object a Vault design.
  const source = objs.find((o) => o.source?.modelId)?.source ?? first.source
  const merged: PlateEntry = { ...rest, handle, parts, colors, ...(history ? { history } : {}), ...(source ? { source } : {}) }
  set({ plate: get().plate.filter((p) => !drop.has(p.id)).map((p) => (p.id === first.id ? merged : p)), selection: first.id, selectedIds: [first.id] })
  markStale()
  return true
}

/** Adds a primitive: as a new object in free space, or as a part of the selected object. */
export async function addPrimitive(host: Loader, shape: PrimitiveShape, as: 'object' | 'part', sizeMm = 20): Promise<string | null> {
  const mesh = primitive(shape, sizeMm)
  const { bed } = get()
  if (as === 'part') {
    const src = selectedEntry()
    if (!src) {
      toast('Select an object to add the part to.', 'info')
      return null
    }
    const slot = Math.max(...src.parts.map((p) => p.slot), 1)
    // The new part stands on the object's own bed level, next to its bounds.
    const b = bounds(src.parts, identity())
    const offset: Vec3 = b ? [b.max[0] + sizeMm / 2 + 2, 0, b.min[2]] : [0, 0, 0]
    const partMesh = { ...bake(mesh, compose({ position: offset, rotation: [0, 0, 0], scale: [1, 1, 1] })), name: `${mesh.name} ${src.parts.length + 1}`, slot }
    const parts = [...src.parts, partMesh]
    const handle = await host.loadParts(src.name, parts)
    const history = src.history ? (await import('../cad/history/record')).withStep(src, -1, { op: 'parts.add', parts: [partMesh], label: `Add ${mesh.name.toLowerCase()}` }) : undefined
    set({ plate: get().plate.map((p) => (p.id === src.id ? { ...p, handle, parts, colors: [...p.colors], ...(history ? { history } : {}) } : p)) })
    markStale()
    return src.id
  }
  const handle = await host.loadParts(mesh.name, [mesh])
  const entry: PlateEntry = { id: newObjectId(), name: mesh.name, handle, parts: [mesh], colors: [brandAccent()], transform: compose({ position: [bed.widthMm / 2, bed.depthMm / 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
  const r = arrange([entry], get().plate, bed, placeOptions())
  const placed = r.transforms[entry.id] ? { ...entry, transform: r.transforms[entry.id]! } : entry
  const tooLarge = tooLargeNotice(r, [entry])
  if (tooLarge) toast(tooLarge, 'warn')
  set({ plate: [...get().plate, placed], selection: placed.id, selectedIds: [placed.id] })
  markStale()
  return placed.id
}
