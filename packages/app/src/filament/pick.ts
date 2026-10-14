// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which loaded spool a part prints with. A click on a spool moves the target there: the selected objects, or with
// nothing selected the whole plate, or the parts on one filament when the plate uses several. A part with no filament
// of its own starts on the spool of the profile's material closest to the model's color, else the one used last on
// this printer. React-free; the panel and the agent bridge both call these.
import { colorDistance } from '@slicerx/contracts'
import { createStore } from 'zustand'
import { activeMeta } from '../plate/plates'
import { get, markStale, selectedIds, set, type AppState, type PlateEntry, type PlateMeta } from '../state/store'
import { effectiveSlot, mapSlot, materialType, resolveSlots, type ResolvedSlot } from './slots'

/** What a click on a spool moves. */
export type SpoolTarget =
  | { kind: 'objects'; ids: readonly string[]; part?: string }
  | { kind: 'plate' }
  | { kind: 'filament'; from: number }

/** Why a part prints on its spool, for the line under the spools. */
export type PickWhy = 'manual' | 'color' | 'last' | 'material'

/** Why each object is on its spool, by object id. Kept for this session only. */
export const spoolPicks = createStore<{ why: Record<string, PickWhy> }>()(() => ({ why: {} }))

const KEY = 'slicerx.lastSpool'
let last: Record<string, number> | null = null

function loadLast(): Record<string, number> {
  if (last) return last
  try {
    last = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>
  } catch {
    last = {}
  }
  return last
}

/** The spool picked last on this printer, by slot number. */
export function lastSpool(printerId: string | null): number | undefined {
  const n = printerId ? loadLast()[printerId] : undefined
  return typeof n === 'number' && Number.isInteger(n) ? n : undefined
}

export function noteLastSpool(printerId: string | null, slot: number): void {
  if (!printerId) return
  loadLast()[printerId] = slot
  try {
    localStorage.setItem(KEY, JSON.stringify(last))
  } catch {
    // private mode or full storage: this session only
  }
}

/** The print profile's material type, PLA when the profile names none. */
export function profileMaterial(s: Pick<AppState, 'profile'>): string {
  return materialType(s.profile?.materialType)
}

/** Spools the printer reports as loaded, as the project resolves them (a slot set here wins). */
export function loadedSpools(s: Parameters<typeof resolveSlots>[0]): ResolvedSlot[] {
  return resolveSlots(s).filter((r) => {
    const p = s.printerSlots[r.index - 1]
    return Boolean(p && (p.material || p.color))
  })
}

/**
 * The spool for a part with no filament of its own: the profile's material first, then the nearest color to the
 * model's, then the spool used last on this printer, then the first one. Null when nothing is loaded.
 */
export function autoSpool(spools: readonly Pick<ResolvedSlot, 'index' | 'type' | 'color'>[], o: { material: string; color?: string | undefined; last?: number | undefined }): { slot: number; why: Exclude<PickWhy, 'manual'> } | null {
  const same = spools.filter((s) => s.type.toUpperCase() === o.material.toUpperCase())
  const pool = same.length ? same : spools
  if (pool.length === 0) return null
  if (o.color && /^#[0-9a-f]{6}/i.test(o.color)) {
    // nearest color; a tie goes to the spool used last, then the earlier slot
    const best = [...pool].sort((a, b) => colorDistance(a.color, o.color!) - colorDistance(b.color, o.color!) || Number(b.index === o.last) - Number(a.index === o.last) || a.index - b.index)[0]!
    return { slot: best.index, why: 'color' }
  }
  const used = pool.find((s) => s.index === o.last)
  if (used) return { slot: used.index, why: 'last' }
  return { slot: pool[0]!.index, why: 'material' }
}

/** The slot a part must be set to so it prints on `slot` after the plate's color swaps. */
export function fileSlotFor(meta: Pick<PlateMeta, 'settings'> | undefined, slot: number): number {
  const map = meta?.settings.slotMap
  if (!map) return slot
  for (const [k, v] of Object.entries(map)) if (v === slot) return Number(k)
  return slot
}

/** Parts on each spool of the shown plate (printable objects only), by slot. */
export function spoolParts(plate: readonly Pick<PlateEntry, 'id' | 'name' | 'printable' | 'slotOverrides' | 'handle'>[], meta: Pick<PlateMeta, 'settings'> | undefined): Map<number, { parts: number; names: string[] }> {
  const out = new Map<number, { parts: number; names: string[] }>()
  for (const e of plate) {
    if (e.printable === false) continue
    for (const p of e.handle.parts) {
      const slot = mapSlot(meta, effectiveSlot(e, p))
      const cur = out.get(slot) ?? { parts: 0, names: [] }
      cur.parts++
      const name = e.handle.parts.length > 1 && p.name ? p.name : e.name
      if (!cur.names.includes(name)) cur.names.push(name)
      out.set(slot, cur)
    }
  }
  return out
}

/** What a click moves now: the selection, else the plate, else (two or more filaments in use) the parts on `from`. */
export function currentTarget(s: Pick<AppState, 'selection' | 'selectedIds' | 'plate' | 'plates' | 'activePlate'>, from: number | null): SpoolTarget {
  const ids = selectedIds(s).filter((id) => s.plate.some((e) => e.id === id))
  if (ids.length) return { kind: 'objects', ids }
  const inUse = [...spoolParts(s.plate, activeMeta(s)).keys()]
  if (inUse.length < 2) return { kind: 'plate' }
  return { kind: 'filament', from: from !== null && inUse.includes(from) ? from : Math.min(...inUse) }
}

/** The slot the target prints on now, when it all prints on one. */
export function targetSlot(s: Pick<AppState, 'plate' | 'plates' | 'activePlate'>, target: SpoolTarget): number | null {
  if (target.kind === 'filament') return target.from
  const meta = activeMeta(s)
  const slots = new Set<number>()
  for (const e of s.plate) {
    if (target.kind === 'objects' && !target.ids.includes(e.id)) continue
    for (const p of e.handle.parts) if (!(target.kind === 'objects' && target.part && p.name !== target.part)) slots.add(mapSlot(meta, effectiveSlot(e, p)))
  }
  return slots.size === 1 ? [...slots][0]! : null
}

/**
 * Moves the target to `slot`: each part it covers prints on that spool, after the plate's swaps. Returns how many parts
 * moved. Notes the spool as the one used last on this printer and the objects as picked by hand.
 */
export function moveToSpool(target: SpoolTarget, slot: number): number {
  if (!Number.isInteger(slot) || slot < 1 || slot > 16) return 0
  const s = get()
  const meta = activeMeta(s)
  const to = fileSlotFor(meta, slot)
  let moved = 0
  const touched: string[] = []
  const plate = s.plate.map((e) => {
    if (target.kind === 'objects' && !target.ids.includes(e.id)) return e
    const next = { ...(e.slotOverrides ?? {}) }
    let changed = false
    for (const p of e.handle.parts) {
      if (target.kind === 'objects' && target.part && p.name !== target.part) continue
      const now = mapSlot(meta, effectiveSlot(e, p))
      if (target.kind === 'filament' && now !== target.from) continue
      if (now === slot) continue
      if (p.slot === to) delete next[p.name]
      else next[p.name] = to
      moved++
      changed = true
    }
    if (!changed) return e
    touched.push(e.id)
    const { slotOverrides: _old, ...rest } = e
    return { ...rest, ...(Object.keys(next).length ? { slotOverrides: next } : {}) } as PlateEntry
  })
  noteLastSpool(s.printerId, slot)
  if (!moved) return 0
  set({ plate })
  spoolPicks.setState((p) => ({ why: { ...p.why, ...Object.fromEntries(touched.map((id) => [id, 'manual' as const])) } }))
  markStale()
  return moved
}

type PickInputs = Pick<AppState, 'printerSlots' | 'plates' | 'plate' | 'activePlate' | 'slotSetup' | 'profile' | 'printerId'> & Partial<Pick<AppState, 'slotMatch' | 'fileSlotColors'>>

/**
 * New plate entries with their parts on the auto-picked spool, for parts that have no filament of their own (`own`
 * says which do). `color` gives the model's color for a part, if the file has one. Entries come back as they were when
 * the printer reports no loaded spool.
 */
export function withAutoSpools<E extends Pick<PlateEntry, 'id' | 'handle' | 'slotOverrides'>>(entries: readonly E[], opts: { own?: (e: E, part: string) => boolean; color?: (e: E, index: number) => string | undefined }, s: PickInputs = get()): E[] {
  const spools = loadedSpools(s)
  if (!spools.length) return [...entries]
  const material = profileMaterial(s)
  const used = lastSpool(s.printerId)
  const meta = activeMeta(s)
  const picks: Record<string, PickWhy> = {}
  const out = entries.map((e) => {
    const next = { ...(e.slotOverrides ?? {}) }
    let why: PickWhy | null = null
    e.handle.parts.forEach((p, i) => {
      if (opts.own?.(e, p.name) || next[p.name] !== undefined) return
      const pick = autoSpool(spools, { material, color: opts.color?.(e, i), last: used })
      if (!pick) return
      why ??= pick.why
      const to = fileSlotFor(meta, pick.slot)
      if (to !== p.slot) next[p.name] = to
    })
    if (why) picks[e.id] = why
    const { slotOverrides: _old, ...rest } = e
    return { ...rest, ...(Object.keys(next).length ? { slotOverrides: next } : {}) } as E
  })
  if (Object.keys(picks).length) spoolPicks.setState((p) => ({ why: { ...p.why, ...picks } }))
  return out
}
