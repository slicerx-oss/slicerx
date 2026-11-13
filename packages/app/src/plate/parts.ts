// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The parts inside one object: clone a part beside itself, and put the parts in a new order. Each is one store update,
// so one undo step. Part order is the order of the list only: the slice prints the same either way.
import type { FaceSurface, MeshFaces, MeshHandle, MeshPart } from '@slicerx/contracts'
import type { SettingValue } from '@slicerx/contracts'
import { get, markStale, set, type AppState, type PaintData, type PlateEntry } from '../state/store'
import { partOverridesOf } from './object-settings'
import { brandAccent } from '../edition'
import { bake } from './mesh-ops'
import { bounds, compose, identity, type Vec3 } from './transform'
import { partNameProblem, plainPartName } from '@slicerx/cad-history'
import { renamedScope, withRenamedParts } from './part-renames'

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }

/** The gap between a part and its clone, mm. */
export const CLONE_GAP_MM = 2

/** "Box" gives "Box 2" and "Box 2" gives "Box 3": the next number after the name's own that no other part has. */
export function clonedName(name: string, taken: readonly string[]): string {
  const m = /^(.*\S)\s+(\d{1,6})$/.exec(name)
  const base = m ? m[1]! : name
  const used = new Set(taken)
  let n = m ? Number(m[2]) + 1 : 2
  while (used.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

const add = (v: readonly number[], d: Vec3): [number, number, number] => [v[0]! + d[0], v[1]! + d[1], v[2]! + d[2]]

/** The faces of a part moved by `d`: the same faces and keys, their surfaces where the moved triangles are. */
function movedFaces(f: MeshFaces, d: Vec3): MeshFaces {
  const table = f.table.map((s): FaceSurface => {
    if (s.kind === 'plane') return { ...s, offset: s.offset + s.normal[0] * d[0] + s.normal[1] * d[1] + s.normal[2] * d[2] }
    if (s.kind === 'cylinder') return { ...s, origin: add(s.origin, d) }
    if (s.kind === 'cone') return { ...s, apex: add(s.apex, d) }
    if (s.kind === 'sphere') return { ...s, center: add(s.center, d) }
    return s
  })
  return { ...f, table }
}

/** The part a clone copies, moved along X by its own width and the gap, in the object's own coordinates. */
export function clonePartMesh(part: MeshPart, name: string): MeshPart {
  const b = bounds([part], identity())
  const d: Vec3 = [b ? b.max[0] - b.min[0] + CLONE_GAP_MM : CLONE_GAP_MM, 0, 0]
  const { faces, ...rest } = part
  const moved = bake(rest, compose({ position: d, rotation: [0, 0, 0], scale: [1, 1, 1] }))
  return { ...moved, name, ...(faces ? { faces: movedFaces(faces, d) } : {}), ...(part.paint ? { paint: structuredClone(part.paint) } : {}) }
}

const colorAt = (e: PlateEntry, i: number): string => e.colors[i] ?? e.colors[0] ?? brandAccent()

/** The object's paint with part `from`'s copied to part `to`. */
function paintCopied(paint: PaintData | undefined, from: number, to: number): PaintData | undefined {
  const own = paint?.[from]
  return own ? { ...paint, [to]: structuredClone(own) } : paint
}

/**
 * Refuses a parts edit while the object cannot take one: the timeline rolled back, a step open for editing, a replay
 * running, or a plate loading. A parts step put in at a rolled-back marker would land before later steps.
 */
async function editable(objectId: string): Promise<void> {
  const s = get()
  if (s.plateLoading) throw new Error('The plate is still loading. Try again when it is in.')
  if (s.rollback) throw new Error('Return to the end of the timeline before changing parts.')
  const { replaying } = await import('../cad/history/ops')
  if (s.historyEdit?.objectId === objectId || replaying(objectId)) throw new Error('Finish editing this object\'s history before changing its parts.')
}

/**
 * Writes the edited object in one store update. An instance stops sharing its source's mesh, as other mesh edits do:
 * it becomes an object of its own and takes its source's part and object settings, so the slice prints it as shown.
 */
function commit(objectId: string, edit: (now: PlateEntry, settings: Record<string, Record<string, SettingValue>>) => PlateEntry, extra: Partial<AppState> = {}): void {
  const s = get()
  const now = s.plate.find((p) => p.id === objectId)!
  const { instanceOf: from, partSettings: _own, ...rest } = now
  const settings = structuredClone(partOverridesOf(s.plate, now))
  const next = edit(rest as PlateEntry, settings)
  const shared = from ? s.objectSettings[from] : undefined
  set({
    plate: s.plate.map((p) => (p.id === objectId ? next : p)),
    ...(shared && !s.objectSettings[objectId] ? { objectSettings: { ...s.objectSettings, [objectId]: { ...shared } } } : {}),
    ...extra,
  })
  markStale()
}

const withSettings = (settings: Record<string, Record<string, SettingValue>>): Pick<PlateEntry, 'partSettings'> => (Object.keys(settings).length ? { partSettings: settings } : {})

/**
 * Clones part `index` of the object: a copy named "Name 2" with the same filament, its own filament choice, settings
 * and paint, beside the original on X, added after the last part. In a CAD history the copy is a parts.add step, so the
 * timeline stays editable. The copy is picked. Returns its index and name, or null when there is no such part.
 */
export async function clonePart(host: Loader, objectId: string, index: number, guard?: () => void): Promise<{ index: number; name: string } | null> {
  const e = get().plate.find((p) => p.id === objectId)
  const src = e?.parts[index]
  if (!e || !src) return null
  await editable(objectId)
  const name = clonedName(src.name, e.parts.map((p) => p.name))
  const copy = clonePartMesh(src, name)
  const at = e.parts.length
  const parts = [...e.parts, copy]
  const history = e.history ? (await import('../cad/history/record')).withStep(e, -1, { op: 'parts.add', parts: [copy], label: `Clone ${src.name}`.slice(0, 80) }) : undefined
  // the history goes in with the landing moves the object has as it is written (placedNow)
  const { placedNow } = await import('../cad/commit')
  const handle = await host.loadParts(e.name, parts)
  guard?.()
  // The object as it is now: a rename or a recolor while the mesh loaded stays.
  const now = get().plate.find((p) => p.id === objectId)
  if (!now || now.parts !== e.parts) throw new Error(`${e.name} changed while the clone loaded. Try again.`)
  commit(
    objectId,
    (o, settings) => {
      // the copy takes the original's filament choice and settings, and nothing left under its name from before
      const slots = { ...o.slotOverrides }
      if (slots[src.name] !== undefined) slots[name] = slots[src.name]!
      else delete slots[name]
      if (settings[src.name]) settings[name] = structuredClone(settings[src.name]!)
      else delete settings[name]
      const { slotOverrides: _s, paint: _p, history: _h, ...plain } = o
      const paint = paintCopied(o.paint, index, at)
      return {
        ...plain,
        handle,
        parts,
        colors: [...o.parts.map((_, i) => colorAt(o, i)), colorAt(o, index)],
        ...(Object.keys(slots).length ? { slotOverrides: slots } : {}),
        ...withSettings(settings),
        ...(paint ? { paint } : {}),
        ...(history ? { history: placedNow(history, o) } : o.history ? { history: o.history } : {}),
      }
    },
    { selection: objectId, selectedIds: [objectId], scopePart: { id: objectId, part: name }, settingsScope: 'objects' },
  )
  return { index: at, name }
}

/** Whether `order` lists each of 0 to n - 1 once. */
export function isPartOrder(order: readonly number[], n: number): boolean {
  return order.length === n && new Set(order).size === n && order.every((k) => Number.isInteger(k) && k >= 0 && k < n)
}

/** The order that moves part `from` to place `to`, the rest keeping theirs. */
export function orderMoving(n: number, from: number, to: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i)
  const [k] = order.splice(from, 1)
  order.splice(Math.max(0, Math.min(n - 1, to)), 0, k!)
  return order
}

/**
 * Puts the object's parts in a new order: part i after it is part `order[i]` before it. Colors and paint go with their
 * parts; filament choices and settings are kept by part name, so they follow too. In a CAD history the order is a step
 * (parts.order) that changes no geometry, so later steps still find their parts on a replay. Returns false when nothing
 * moved.
 */
export async function reorderParts(host: Loader, objectId: string, order: readonly number[], guard?: () => void): Promise<boolean> {
  const e = get().plate.find((p) => p.id === objectId)
  if (!e) return false
  if (!isPartOrder(order, e.parts.length)) throw new Error(`The new order must list each of the ${e.parts.length} parts once.`)
  if (order.every((k, i) => k === i)) return false
  await editable(objectId)
  const parts = order.map((k) => e.parts[k]!)
  const history = e.history ? (await import('../cad/history/record')).withStep(e, -1, { op: 'parts.order', order: [...order] }, e.transform, true) : undefined
  // the history goes in with the landing moves the object has as it is written (placedNow)
  const { placedNow } = await import('../cad/commit')
  const handle = await host.loadParts(e.name, parts)
  guard?.()
  const now = get().plate.find((p) => p.id === objectId)
  if (!now || now.parts !== e.parts) throw new Error(`${e.name} changed while its parts loaded. Try again.`)
  commit(objectId, (o, settings) => {
    let paint: PaintData | undefined
    if (o.paint) {
      paint = {}
      order.forEach((k, i) => {
        if (o.paint![k]) paint![i] = o.paint![k]!
      })
    }
    const { paint: _old, history: _h, ...rest } = o
    return { ...rest, handle, parts, colors: order.map((k) => colorAt(o, k)), ...withSettings(settings), ...(paint && Object.keys(paint).length ? { paint } : {}), ...(history ? { history: placedNow(history, o) } : o.history ? { history: o.history } : {}) }
  })
  return true
}

/** Moves part `from` to place `to` in its object's list. One undo step; false when nothing moved. */
export function movePart(host: Loader, objectId: string, from: number, to: number): Promise<boolean> {
  const e = get().plate.find((p) => p.id === objectId)
  if (!e || from < 0 || from >= e.parts.length) return Promise.resolve(false)
  return reorderParts(host, objectId, orderMoving(e.parts.length, from, to))
}

/**
 * Renames part `index` of the object to `name`, taken plain (part-renames.ts): its filament choice, settings and paint
 * go with it. In a CAD history the rename is a step (parts.name) that changes no geometry, so it replays, saves and
 * undoes like the rest. One undo step. False when the name is the part's own; an empty name, one too long or one
 * another part has is refused with a sentence that says so.
 */
export async function renamePart(host: Loader, objectId: string, index: number, name: string, guard?: () => void): Promise<boolean> {
  const e = get().plate.find((p) => p.id === objectId)
  const part = e?.parts[index]
  if (!e || !part) return false
  const plain = plainPartName(name)
  if (plain === part.name) return false
  const problem = partNameProblem(plain, e.parts.map((p) => p.name), index)
  if (problem) throw new Error(`${problem[0]!.toUpperCase()}${problem.slice(1)}.`)
  await editable(objectId)
  const parts = e.parts.map((p, i) => (i === index ? { ...p, name: plain } : p))
  const history = e.history ? (await import('../cad/history/record')).withStep(e, index, { op: 'parts.name', name: plain, was: part.name }, e.transform, true) : undefined
  const { placedNow } = await import('../cad/commit')
  const handle = await host.loadParts(e.name, parts)
  guard?.()
  const now = get().plate.find((p) => p.id === objectId)
  if (!now || now.parts !== e.parts) throw new Error(`${e.name} changed while its parts loaded. Try again.`)
  const renames = new Map([[part.name, plain]])
  commit(
    objectId,
    (o, settings) => {
      const moved = withRenamedParts({ ...(o.slotOverrides ? { slotOverrides: o.slotOverrides } : {}), partSettings: settings }, renames)
      const { slotOverrides: _s, history: _h, ...plain } = o
      return {
        ...plain,
        handle,
        parts,
        ...(moved.slotOverrides && Object.keys(moved.slotOverrides).length ? { slotOverrides: moved.slotOverrides } : {}),
        ...withSettings(moved.partSettings ?? {}),
        ...(history ? { history: placedNow(history, o) } : o.history ? { history: o.history } : {}),
      }
    },
    { scopePart: renamedScope(get().scopePart, objectId, renames) },
  )
  return true
}
