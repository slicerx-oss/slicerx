// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Copy, cut, paste and duplicate for objects and volumes, following Bambu Studio and OrcaSlicer
// (Selection::copy_to_clipboard, paste_objects_from_clipboard and paste_volumes_from_clipboard, Orca v2.4.2).
// A pasted object keeps its settings, paint, volumes and filament slots. It lands on the current plate at
// the nearest free spot to where it came from (a group moves as a whole, one bounding box over the other, then
// finds its spot), so it works across plates. A paste or cut is one undo step: it is one store update.
// A volume pasted into an object from another object is placed beside the object, as Orca does.
import type { SettingValue } from '@slicerx/contracts'
import { get, markStale, selectedIds, set, toast, type PlateEntry, type PlateVolumeEntry } from '../state/store'
import { arrange, currentMargins, MARGIN_SAFETY_MM, printSizeOf } from './arrange'
import { sourceId } from './object-settings'
import { bounds, compose, identity, type Box, type Mat4 } from './transform'

export type Clipboard =
  | { kind: 'objects'; entries: PlateEntry[]; settings: Record<string, Record<string, SettingValue>> }
  | { kind: 'volumes'; volumes: PlateVolumeEntry[]; fromObject: string }

let clip: Clipboard | null = null
const listeners = new Set<() => void>()

export function clipboard(): Clipboard | null {
  return clip
}

/** Empties the clipboard (a new project, or a test). */
export function clearClipboard(): void {
  setClip(null)
}

export function subscribeClipboard(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function setClip(c: Clipboard | null): void {
  clip = c
  for (const l of listeners) l()
}

let seq = 0
const newId = (p: string) => `${p}_${Date.now().toString(36)}${(++seq).toString(36)}`

/** Copies the selected objects. Returns how many. */
export function copySelection(): number {
  const s = get()
  const ids = new Set(selectedIds(s))
  const entries = s.plate.filter((p) => ids.has(p.id))
  if (entries.length === 0) return 0
  const settings: Record<string, Record<string, SettingValue>> = {}
  for (const e of entries) {
    const own = s.objectSettings[sourceId(e)]
    if (own) settings[e.id] = { ...own }
  }
  setClip({ kind: 'objects', entries: entries.map((e) => ({ ...e })), settings })
  return entries.length
}

/** Copy, then remove the originals in one step. */
export function cutSelection(): number {
  const n = copySelection()
  if (n === 0) return 0
  const ids = new Set(selectedIds(get()))
  set({ plate: get().plate.filter((p) => !ids.has(p.id)), selection: null, selectedIds: [] })
  markStale()
  return n
}

/** Copies one volume of the selected object, for pasting into another object. */
export function copyVolume(objectId: string, volumeId: string): boolean {
  const v = get().plate.find((p) => p.id === objectId)?.volumes?.find((x) => x.id === volumeId)
  if (!v) return false
  setClip({ kind: 'volumes', volumes: [{ ...v }], fromObject: objectId })
  return true
}

function rectOf(b: Box): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: b.min[0], y0: b.min[1], x1: b.max[0], y1: b.max[1] }
}

/**
 * The shift (x, y) from where a group sits now to the nearest spot where it fits on the bed clear of the others,
 * searching outward in rings. Null when nothing fits.
 */
export function nearestFreeShift(group: Box, others: readonly Box[], bed: { widthMm: number; depthMm: number }, gapMm = 2, stepMm = 2, edgeMm = 0): [number, number] | null {
  const g = rectOf(group)
  const w = g.x1 - g.x0
  const h = g.y1 - g.y0
  if (w + 2 * edgeMm > bed.widthMm || h + 2 * edgeMm > bed.depthMm) return null
  const fixed = others.map(rectOf)
  const free = (dx: number, dy: number) => {
    const x0 = g.x0 + dx
    const y0 = g.y0 + dy
    if (x0 < edgeMm || y0 < edgeMm || x0 + w > bed.widthMm - edgeMm || y0 + h > bed.depthMm - edgeMm) return false
    return fixed.every((o) => x0 >= o.x1 + gapMm || x0 + w <= o.x0 - gapMm || y0 >= o.y1 + gapMm || y0 + h <= o.y0 - gapMm)
  }
  // A group that starts off the bed begins from the bed's center.
  const offBed = g.x0 < edgeMm || g.y0 < edgeMm || g.x1 > bed.widthMm - edgeMm || g.y1 > bed.depthMm - edgeMm
  const base: [number, number] = offBed ? [bed.widthMm / 2 - (g.x0 + w / 2), bed.depthMm / 2 - (g.y0 + h / 2)] : [0, 0]
  const maxRing = Math.ceil(Math.max(bed.widthMm, bed.depthMm) / stepMm)
  for (let ring = 0; ring <= maxRing; ring++) {
    let best: [number, number] | null = null
    let bestD = Infinity
    for (let i = -ring; i <= ring; i++) {
      for (let j = -ring; j <= ring; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue
        const dx = base[0] + i * stepMm
        const dy = base[1] + j * stepMm
        const d = (dx - base[0]) ** 2 + (dy - base[1]) ** 2
        if (d < bestD && free(dx, dy)) {
          best = [dx, dy]
          bestD = d
        }
      }
    }
    if (best) return best
  }
  return null
}

function footprint(e: PlateEntry): Box | null {
  return bounds(e.parts, e.transform)
}

function union(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const b of boxes) for (let i = 0; i < 3; i++) {
    min[i] = Math.min(min[i]!, b.min[i]!)
    max[i] = Math.max(max[i]!, b.max[i]!)
  }
  return { min, max }
}

/** A copy of an entry with new ids for the object and its volumes, independent of any instance group. Kept dimensions stay with the original. */
function fresh(e: PlateEntry): PlateEntry {
  const { instanceOf: _i, dimensions: _d, ...rest } = e
  return { ...rest, id: newId('obj'), transform: [...e.transform], ...(e.volumes ? { volumes: e.volumes.map((v) => ({ ...v, id: newId('vol') })) } : {}) }
}

function pasteObjects(c: Extract<Clipboard, { kind: 'objects' }>): string[] {
  const s = get()
  const copies = c.entries.map(fresh)
  const boxes = copies.map(footprint).filter((b): b is Box => b !== null)
  const group = union(boxes)
  if (!group) return []
  const others = s.plate.map(footprint).filter((b): b is Box => b !== null)
  // More than one object: start one bounding box over, so the group does not land on its source (Orca does the same).
  const w = group.max[0]! - group.min[0]!
  const d = group.max[1]! - group.min[1]!
  const moved: Box = copies.length > 1 ? (w < d ? { min: [group.min[0]! + w, group.min[1]!, group.min[2]!], max: [group.max[0]! + w, group.max[1]!, group.max[2]!] } : { min: [group.min[0]!, group.min[1]! + d, group.min[2]!], max: [group.max[0]!, group.max[1]! + d, group.max[2]!] }) : group
  // What prints around the copies (brim, skirt) keeps off the bed edge and the neighbors, as arrange keeps it.
  const margins = currentMargins()
  const sizes = boxes.map(printSizeOf)
  const reach = Math.max(0, ...sizes.map((z) => margins.reach(z)))
  const grow = Math.max(0, ...sizes.map((z) => margins.grow(z)))
  const shift = nearestFreeShift(moved, others, s.bed, grow > 0 ? Math.max(2, 2 * grow + MARGIN_SAFETY_MM) : 2, 2, reach > 0 ? reach + MARGIN_SAFETY_MM : 0)
  let placed: PlateEntry[]
  if (shift) {
    const from: [number, number] = [moved.min[0]! - group.min[0]!, moved.min[1]! - group.min[1]!]
    const dx = from[0] + shift[0]
    const dy = from[1] + shift[1]
    placed = copies.map((e) => ({ ...e, transform: withOffset(e.transform, dx, dy) }))
  } else {
    // Nothing fits as it is: let arrange find room for each.
    const r = arrange(copies, s.plate, s.bed)
    placed = copies.filter((e) => r.transforms[e.id]).map((e) => ({ ...e, transform: r.transforms[e.id]! }))
    if (placed.length < copies.length) toast(`Room for ${placed.length} of ${copies.length} on this plate.`, 'warn')
  }
  if (placed.length === 0) return []
  const settings = { ...s.objectSettings }
  c.entries.forEach((orig, i) => {
    const own = c.settings[orig.id]
    const copy = copies[i]
    if (own && copy && placed.some((p) => p.id === copy.id)) settings[copy.id] = { ...own }
  })
  const ids = placed.map((p) => p.id)
  set({ plate: [...s.plate, ...placed], objectSettings: settings, selection: ids[0] ?? null, selectedIds: ids })
  markStale()
  return ids
}

function withOffset(m: Mat4, dx: number, dy: number): Mat4 {
  const out = [...m]
  out[12] = (out[12] ?? 0) + dx
  out[13] = (out[13] ?? 0) + dy
  return out
}

/** Volumes from another object go beside the selected object; from the same object they stay where they were. */
function pasteVolumes(c: Extract<Clipboard, { kind: 'volumes' }>): string[] {
  const s = get()
  const target = s.plate.find((p) => p.id === s.selection)
  if (!target) {
    toast('Select the object to paste into.', 'info')
    return []
  }
  const same = c.fromObject === target.id
  const copies = c.volumes.map((v) => ({ ...v, id: newId('vol') }))
  let shifted = copies
  if (!same) {
    // Beside the object, at its right edge, keeping the volumes' relative places (Orca: from another object).
    const tb = bounds(target.parts, identity())
    const vb = union(copies.map((v) => bounds([v.part], v.local)).filter((b): b is Box => b !== null))
    if (tb && vb) {
      const dx = tb.max[0]! + (vb.max[0]! - vb.min[0]!) / 2 - (vb.min[0]! + vb.max[0]!) / 2
      const dy = tb.min[1]! + (vb.max[1]! - vb.min[1]!) / 2 - (vb.min[1]! + vb.max[1]!) / 2
      const dz = tb.min[2]! + (vb.max[2]! - vb.min[2]!) / 2 - (vb.min[2]! + vb.max[2]!) / 2
      const move = compose({ position: [dx, dy, dz], rotation: [0, 0, 0], scale: [1, 1, 1] })
      shifted = copies.map((v) => ({ ...v, local: multiplyLocal(move, v.local) }))
    }
  }
  set({ plate: s.plate.map((p) => (p.id === target.id ? { ...p, volumes: [...(p.volumes ?? []), ...shifted] } : p)) })
  markStale()
  return shifted.map((v) => v.id)
}

function multiplyLocal(a: Mat4, b: Mat4): Mat4 {
  // a then b's own placement: a is a pure translation, so add it to b's offset.
  const out = [...b]
  out[12] = (b[12] ?? 0) + (a[12] ?? 0)
  out[13] = (b[13] ?? 0) + (a[13] ?? 0)
  out[14] = (b[14] ?? 0) + (a[14] ?? 0)
  return out
}

/** Pastes what was copied. Returns the ids it created. */
export function pasteClipboard(): string[] {
  if (!clip) return []
  return clip.kind === 'objects' ? pasteObjects(clip) : pasteVolumes(clip)
}

/** Copy and paste in one go, leaving the clipboard as it was. */
export function duplicateSelection(): string[] {
  const before = clip
  const n = copySelection()
  if (n === 0) return []
  const ids = pasteClipboard()
  setClip(before)
  return ids
}
