// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The parts inside one object: clone a part beside itself, and put the parts in a new order. Each is one store update,
// so one undo step. Part order is the order of the list only: the slice prints the same either way.
import type { FaceSurface, MeshFaces, MeshHandle, MeshPart } from '@slicerx/contracts'
import { get, markStale, set, type PaintData, type PlateEntry } from '../state/store'
import { brandAccent } from '../edition'
import { bake } from './mesh-ops'
import { bounds, compose, identity, type Vec3 } from './transform'

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
 * Clones part `index` of the object: a copy named "Name 2" with the same filament, its own filament choice, settings
 * and paint, beside the original on X, added after the last part. In a CAD history the copy is a parts.add step, so the
 * timeline stays editable. The copy is picked. Returns its index and name, or null when there is no such part.
 */
export async function clonePart(host: Loader, objectId: string, index: number, guard?: () => void): Promise<{ index: number; name: string } | null> {
  const e = get().plate.find((p) => p.id === objectId)
  const src = e?.parts[index]
  if (!e || !src) return null
  const name = clonedName(src.name, e.parts.map((p) => p.name))
  const copy = clonePartMesh(src, name)
  const at = e.parts.length
  const parts = [...e.parts, copy]
  const history = e.history ? (await import('../cad/history/record')).withStep(e, -1, { op: 'parts.add', parts: [copy], label: `Clone ${src.name}`.slice(0, 80) }) : undefined
  const handle = await host.loadParts(e.name, parts)
  guard?.()
  // The object as it is now: a rename or a recolor while the mesh loaded stays.
  const now = get().plate.find((p) => p.id === objectId)
  if (!now || now.parts !== e.parts) throw new Error(`${e.name} changed while the clone loaded. Try again.`)
  const slot = now.slotOverrides?.[src.name]
  const settings = now.partSettings?.[src.name]
  const paint = paintCopied(now.paint, index, at)
  const next: PlateEntry = {
    ...now,
    handle,
    parts,
    colors: [...now.parts.map((_, i) => colorAt(now, i)), colorAt(now, index)],
    ...(slot !== undefined ? { slotOverrides: { ...now.slotOverrides, [name]: slot } } : {}),
    ...(settings ? { partSettings: { ...now.partSettings, [name]: structuredClone(settings) } } : {}),
    ...(paint ? { paint } : {}),
    ...(history ? { history } : {}),
  }
  set({ plate: get().plate.map((p) => (p.id === objectId ? next : p)), selection: objectId, selectedIds: [objectId], scopePart: { id: objectId, part: name }, settingsScope: 'objects' })
  markStale()
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
  const parts = order.map((k) => e.parts[k]!)
  const history = e.history ? (await import('../cad/history/record')).withStep(e, -1, { op: 'parts.order', order: [...order] }, e.transform, true) : undefined
  const handle = await host.loadParts(e.name, parts)
  guard?.()
  const now = get().plate.find((p) => p.id === objectId)
  if (!now || now.parts !== e.parts) throw new Error(`${e.name} changed while its parts loaded. Try again.`)
  let paint: PaintData | undefined
  if (now.paint) {
    paint = {}
    order.forEach((k, i) => {
      if (now.paint![k]) paint![i] = now.paint![k]!
    })
  }
  const { paint: _old, ...rest } = now
  const next: PlateEntry = { ...rest, handle, parts, colors: order.map((k) => colorAt(now, k)), ...(paint && Object.keys(paint).length ? { paint } : {}), ...(history ? { history } : {}) }
  set({ plate: get().plate.map((p) => (p.id === objectId ? next : p)) })
  markStale()
  return true
}

/** Moves part `from` to place `to` in its object's list. One undo step; false when nothing moved. */
export function movePart(host: Loader, objectId: string, from: number, to: number): Promise<boolean> {
  const e = get().plate.find((p) => p.id === objectId)
  if (!e || from < 0 || from >= e.parts.length) return Promise.resolve(false)
  return reorderParts(host, objectId, orderMoving(e.parts.length, from, to))
}
