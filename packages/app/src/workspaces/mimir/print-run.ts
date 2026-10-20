// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's side of mimir's print run (PrintRunHost). The fingerprint says what a slice was made from: the plate's
// objects, the printer, the settings and the filaments in use. A slice keeps the fingerprint it was made with, and a
// different one now means the plate changed after slicing. The camera and the selection are not part of it. The target
// is the printer and spools the chat picked: the plate points at the printer and each filament moves to its spool, the
// same way a pick on the spools does.
import type { Host } from '@slicerx/contracts'
import type { PrintRunHost, RunLanded, RunTarget } from '@slicerx/pilot'
import { moveToSpool } from '../../filament/pick'
import { followPrinterSlot } from '../../filament/slot-rail'
import { effectiveSlot, mapSlot } from '../../filament/slots'
import { landOnBed, placedOnBed } from '../../plate/arrange'
import { getArrangeOptions } from '../../plate/edit'
import { activeMeta } from '../../plate/plates'
import type { Mat4 } from '../../plate/transform'
import { fullPlate, get, markStale, set, type AppState, type PlateEntry } from '../../state/store'

/** JSON with object keys sorted, so the same values always give the same text. */
export function canonicalJson(v: unknown): string {
  return canonical(v, new Set())
}

/** `path` holds the objects being written, so a value that holds itself is found; the same object twice is fine. */
function canonical(v: unknown, path: Set<object>): string {
  if (v === undefined) return 'null'
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (path.has(v)) throw new Error('canonicalJson: circular reference')
  path.add(v)
  let out: string
  if (Array.isArray(v) || ArrayBuffer.isView(v)) out = `[${Array.from(v as ArrayLike<unknown>, (x) => canonical(x, path)).join(',')}]`
  else {
    const o = v as Record<string, unknown>
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
    out = `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k], path)}`).join(',')}}`
  }
  path.delete(v)
  return out
}

/** 32 bit FNV-1a over the text's UTF-16 code units, as 8 hex digits. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * What the fingerprint is made of, read from the store: plate `plate` (1 based), or the active plate. A plate that is
 * not active is read from its kept objects, so switching plates leaves each plate's fingerprint as it was.
 */
export function fingerprintInputs(s: AppState = get(), plate?: number) {
  const meta = plate === undefined ? activeMeta(s) : s.plates[plate - 1]
  const active = plate === undefined || meta?.id === s.activePlate
  const entries = active ? fullPlate(s) : (meta?.objects ?? [])
  const used = new Set<number>()
  for (const o of entries) if (o.printable !== false) for (const part of o.handle.parts) used.add(mapSlot(meta, effectiveSlot(o, part)))
  const slots = [...used]
    .sort((a, b) => a - b)
    .map((index) => {
      const spool = s.printerSlots[index - 1]
      return { index, filament: s.slotSetup[index] ?? null, spool: spool ? { id: spool.id, material: spool.material ?? null, color: spool.color ?? null } : null }
    })
  return {
    plate: meta?.id ?? (plate === undefined ? s.activePlate : null),
    // the plate's own settings and each object's settings change the slice as much as a move does
    plateSettings: meta?.settings ?? null,
    entries: entries.map((e) => ({ id: e.id, transform: e.transform, steps: e.history?.steps.length ?? 0, printable: e.printable !== false, settings: s.objectSettings[e.id] ?? null })),
    printerId: s.printerId,
    overrides: s.overrides,
    profiles: { process: s.activePresets.process ?? null, filament: s.activePresets.filament ?? null },
    slots,
  }
}

/** The fingerprint of plate `plate` (1 based), or of the active plate, as it is in `s`. */
export function plateFingerprint(s: AppState = get(), plate?: number): string {
  return fnv1a(canonicalJson(fingerprintInputs(s, plate)))
}

/** How long a new printer's bed may take to load before the parts are left alone. */
export const BED_WAIT_MS = 15_000

/**
 * Points the plate at the chat's printer and moves each filament's parts to the spool picked for it. Slot keys are the
 * filaments as the app numbers them; a plate on one filament moves whole. Each part's move is worked out before any
 * part moves, so two filaments that swap spools do not end up on one. The spools picked follow what the printer holds.
 * A new printer's bed can be another size or have excluded areas: once its profile has loaded, the parts it leaves
 * hanging off the bed or in such an area land again, as a new part does. Says which moved and which found no room, each
 * with its plate. A bed that does not load within BED_WAIT_MS leaves the parts alone and says so.
 */
export async function setTarget(t: RunTarget): Promise<RunLanded> {
  const switched = get().printerId !== t.printerId
  // another printer's spools never stand in for this one's until its status arrives; its model loads its bed
  if (switched) set({ printerId: t.printerId, printerSlots: t.printerSlots ?? [], ...(t.model ? { printerModel: { id: t.printerId, vendor: t.model.vendor, model: t.model.model } } : {}) })
  else if (t.printerSlots) set({ printerSlots: t.printerSlots })
  moveSlots(t)
  if (!switched) return { moved: [], offBed: [] }
  // the bed, its excluded areas and the brim and skirt margins come with the printer's profile
  const ready = (await import('../../state/profile-sync')).profileReady()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), BED_WAIT_MS)
  })
  const loaded = await Promise.race([ready.then(() => true as const, () => true as const), late])
  clearTimeout(timer)
  if (!loaded) return { moved: [], offBed: [], bedNotReady: true }
  // no layer built for this printer: the bed is the generic one, not the printer's
  const landed = landOnNewBed()
  return get().profile ? landed : { ...landed, genericBed: true }
}

/** Moves each filament's parts to the spool picked for it. */
function moveSlots(t: RunTarget): void {
  const s = get()
  const slotOf = (id: string): number => s.printerSlots.findIndex((p) => p.id === id) + 1
  const to = new Map<number, number>()
  for (const [k, id] of Object.entries(t.slots)) {
    const n = slotOf(id)
    if (n > 0) to.set(Number(k), n)
  }
  if (to.size === 0) return
  for (const n of new Set(to.values())) followPrinterSlot(n)
  const meta = activeMeta(s)
  const parts = s.plate.flatMap((e) => (e.printable === false ? [] : e.handle.parts.map((p) => ({ id: e.id, part: p.name, on: mapSlot(meta, effectiveSlot(e, p)) }))))
  const inUse = new Set(parts.map((p) => p.on))
  if (inUse.size < 2 && to.size === 1) return void moveToSpool({ kind: 'plate' }, [...to.values()][0]!)
  for (const p of parts) {
    const n = to.get(p.on)
    if (n !== undefined && n !== p.on) moveToSpool({ kind: 'objects', ids: [p.id], part: p.part }, n)
  }
}

/**
 * Lands every plate's parts that the bed in the store leaves hanging off it or in an excluded area, with the landing a
 * new part gets (landOnBed): the middle of the bed or the first free spot, clear of the brim and skirt of the parts
 * around it. A part that stands on the bed stays put, and so does a locked one. A part with no room stays where it was.
 * Each part is named with its plate. All moves are one store write, so one undo step brings every part back.
 */
export function landOnNewBed(): RunLanded {
  const s = get()
  const out: RunLanded = { moved: [], offBed: [], ...(s.plates.length > 1 ? { manyPlates: true } : {}) }
  const land = (objects: PlateEntry[], plate: string): PlateEntry[] => {
    const off = objects.filter((o) => !o.locked && !placedOnBed(o, s.bed))
    if (!off.length) return objects
    // the parts that stay are what the moved ones keep clear of; a part not landed yet is no obstacle
    const placed = objects.filter((o) => !off.includes(o))
    const to = new Map<string, Mat4>()
    for (const o of off) {
      const m = landOnBed(o, placed, s.bed, getArrangeOptions())
      if (!m) {
        out.offBed.push({ name: o.name, plate })
        continue
      }
      to.set(o.id, m)
      placed.push({ ...o, transform: m })
      out.moved.push({ name: o.name, plate })
    }
    return to.size ? objects.map((o) => (to.has(o.id) ? { ...o, transform: to.get(o.id)! } : o)) : objects
  }
  const plate = land(s.plate, s.plates.find((p) => p.id === s.activePlate)?.name ?? '')
  const plates = s.plates.map((p) => (p.id === s.activePlate ? p : { ...p, objects: land(p.objects, p.name) }))
  if (out.moved.length) {
    set({ plate, plates })
    markStale()
  }
  return out
}

/** The host whose printers the watch on a started print reads, as they are at each look (the bridge swaps them). */
let printersHost: Pick<Host, 'printers'> | null = null

const TAB_PRINT_RUN: PrintRunHost = {
  fingerprint: (plate) => plateFingerprint(get(), plate),
  setTarget,
  printers: () => printersHost?.printers,
}

/**
 * The print run host the mimir tab gives its runtime: the same one every time, so a runtime made again (a setup change,
 * or the app's commands changing as a print starts) keeps the chat's run and the watch on its print. The watch reads
 * `host.printers` each time it subscribes, so the bridge coming back needs no new runtime.
 */
export function appPrintRun(host?: Pick<Host, 'printers'>): PrintRunHost {
  if (host) printersHost = host
  return TAB_PRINT_RUN
}
