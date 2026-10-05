// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the object list changes on an object: its name, whether it prints, and the filament of each part.
// Orca's object list (GUI_ObjectList.cpp) has the same three: rename, the printable toggle (key V) and the
// extruder column per object and part. Each is one store update, so one undo step.
import { get, markStale, selectedIds, set, type AppState, type PlateEntry } from '../state/store'
import { effectiveSlot } from '../filament/slots'
import { avoidAreas, currentMargins, printSizeOf, type PrintMargins } from './arrange'
import { bounds, fitsBed } from './transform'

import { ROLE_LABEL } from './volumes'

export const MAX_NAME = 100

/** What a search matched on one object: its own name, some of its parts, some of its modifiers and volumes. */
export interface ObjectMatch {
  id: string
  /** The object's name matched, so all of it shows. */
  self: boolean
  /** Indices into the object's parts that matched. */
  parts: number[]
  /** Ids of the matching volumes (modifiers, blockers, enforcers). */
  volumes: string[]
}

const norm = (s: string) => s.toLocaleLowerCase('en-US')

/**
 * Filters the list by name and looks inside: a part or a volume that matches keeps its object in the list and
 * shows only that part. Every word of the query must appear, in any order. An empty query matches everything.
 */
export function searchObjects(plate: readonly PlateEntry[], query: string): ObjectMatch[] {
  const words = norm(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return plate.map((e) => ({ id: e.id, self: true, parts: e.handle.parts.map((_, i) => i), volumes: (e.volumes ?? []).map((v) => v.id) }))
  const hit = (text: string) => {
    const t = norm(text)
    return words.every((w) => t.includes(w))
  }
  const out: ObjectMatch[] = []
  for (const e of plate) {
    const self = hit(e.name)
    const parts = e.handle.parts.flatMap((p, i) => (self || hit(p.name) ? [i] : []))
    const volumes = (e.volumes ?? []).filter((v) => self || hit(v.name) || hit(ROLE_LABEL[v.role])).map((v) => v.id)
    if (self || parts.length || volumes.length) out.push({ id: e.id, self, parts, volumes })
  }
  return out
}

export function renameObject(id: string, name: string): boolean {
  const n = name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, MAX_NAME)
  const e = get().plate.find((p) => p.id === id)
  if (!e || !n || n === e.name) return false
  set({ plate: get().plate.map((p) => (p.id === id ? { ...p, name: n } : p)) })
  return true
}

/** Flips printable for the given objects (the selection by default): all off if any is on, else all on. Returns the new state. */
export function togglePrintable(ids: readonly string[] = selectedIds()): boolean | null {
  const list = get().plate.filter((p) => ids.includes(p.id))
  if (list.length === 0) return null
  const next = list.some((p) => p.printable !== false) ? false : true
  set({
    plate: get().plate.map((p) => {
      if (!ids.includes(p.id)) return p
      const { printable: _old, ...rest } = p
      return (next ? rest : { ...rest, printable: false }) as PlateEntry
    }),
  })
  markStale()
  return next
}

/** Sends one part of an object to another filament slot. Choosing the file's own slot drops the override. */
export function setPartSlot(objectId: string, partName: string, slot: number): void {
  const e = get().plate.find((p) => p.id === objectId)
  if (!e || !Number.isInteger(slot) || slot < 1 || slot > 16) return
  const base = e.handle.parts.find((p) => p.name === partName)?.slot
  const next = { ...(e.slotOverrides ?? {}) }
  if (base === slot) delete next[partName]
  else next[partName] = slot
  const { slotOverrides: _old, ...rest } = e
  set({ plate: get().plate.map((p) => (p.id === objectId ? ({ ...rest, ...(Object.keys(next).length ? { slotOverrides: next } : {}) } as PlateEntry) : p)) })
  markStale()
}

/** Locks or unlocks the given objects (the selection by default): all locked if any is free, else all free. Returns the new state. */
export function toggleLock(ids: readonly string[] = selectedIds()): boolean | null {
  const list = get().plate.filter((p) => ids.includes(p.id))
  if (list.length === 0) return null
  const next = list.some((p) => !p.locked)
  set({
    plate: get().plate.map((p) => {
      if (!ids.includes(p.id)) return p
      const { locked: _old, ...rest } = p
      return (next ? { ...rest, locked: true } : rest) as PlateEntry
    }),
  })
  return next
}

/**
 * Moves an object to a place in the list, which is the order the objects are printed in by object and the order
 * they appear in. Orca's drag and drop does the same within a plate (ObjectList::OnDrop, "Object order changed").
 * One undo step. Returns false when nothing moved.
 */
export function moveObject(id: string, toIndex: number): boolean {
  const plate = get().plate
  const from = plate.findIndex((p) => p.id === id)
  if (from < 0) return false
  const to = Math.max(0, Math.min(plate.length - 1, toIndex))
  if (to === from) return false
  const next = [...plate]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  set({ plate: next })
  markStale()
  return true
}

/** True when what prints around the object (brim, raft, support pad, skirt) goes past the bed edge or onto an excluded area. */
export function printPastBed(b: NonNullable<ReturnType<typeof bounds>>, bed: AppState['bed'], margins: PrintMargins): boolean {
  const reach = margins.reach(printSizeOf(b))
  const grown = { min: [b.min[0] - reach, b.min[1] - reach, b.min[2]] as [number, number, number], max: [b.max[0] + reach, b.max[1] + reach, b.max[2]] as [number, number, number] }
  if (!fitsBed(grown, bed)) return true
  return [...avoidAreas(), ...margins.keepOut].some((z) => grown.min[0] < z.x + z.w && z.x < grown.max[0] && grown.min[1] < z.y + z.h && z.y < grown.max[1])
}

/** What the list flags on an object, the way PrusaSlicer's object list does: off the bed, or a filament the printer does not have. */
export interface ObjectWarning {
  kind: 'off-bed' | 'filament'
  text: string
}

export function objectWarnings(e: PlateEntry, s: Pick<AppState, 'bed' | 'printerSlots'>, margins: PrintMargins = currentMargins()): ObjectWarning[] {
  const out: ObjectWarning[] = []
  const b = bounds(e.parts, e.transform)
  if (b && !fitsBed(b, s.bed)) out.push({ kind: 'off-bed', text: 'Off the bed' })
  else if (b && printPastBed(b, s.bed, margins)) out.push({ kind: 'off-bed', text: 'Brim or skirt reaches past the bed edge' })
  const have = s.printerSlots.length
  if (have > 0) {
    const missing = [...new Set(e.handle.parts.map((p) => effectiveSlot(e, p)).filter((n) => n > have))]
    if (missing.length) out.push({ kind: 'filament', text: `Filament ${missing.join(', ')} is not on the printer` })
  }
  return out
}
