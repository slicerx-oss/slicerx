// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which nozzle prints each object on a printer whose nozzles are not all one size. An object's nozzle is the nozzle of
// its filament: on a tool changer filament n prints on tool n; on a Bambu Lab printer with two extruders the plate's
// filament map says which. Picking a nozzle for an object moves it to a filament on that nozzle (tool changers) or sets
// the map for its filament (two extruders). React-free; the object row, the app link and the tests call these.
import { profileNozzleValues, resolveConfig } from '../adapters/config'
import { activeMeta } from '../plate/plates'
import { setPartSlot } from '../plate/object-list'
import { get, type AppState, type PlateEntry, type PlateMeta } from '../state/store'
import { currentMap, mapExtruders, masterExtruder, pickedMap, setSlotNozzle } from './nozzle-map'
import { paintStates } from '../export/listing-colors'
import { effectiveSlot, mapSlot, MAX_SLOTS, resolveSlots, setSlot } from './slots'

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v])

/** Each extruder's nozzle size in mm, in extruder order, from the config's `nozzle_diameter`. */
export function nozzleSizes(cfg: Record<string, unknown>): number[] {
  return list(cfg['nozzle_diameter']).map(Number).filter((d) => Number.isFinite(d) && d > 0)
}

/** Two sizes count as one within a thousandth of a millimeter, as the engine counts them. */
const same = (a: number, b: number): boolean => Math.abs(a - b) < 1e-3

/** The printer has two or more nozzles and they are not all one size. */
export function sizesDiffer(cfg: Record<string, unknown>): boolean {
  const s = nozzleSizes(cfg)
  return s.length > 1 && s.some((d) => !same(d, s[0]!))
}

/**
 * How filaments reach nozzles on a printer whose nozzles differ in size: `map` on a Bambu Lab printer with two
 * extruders (the plate's filament map), `tools` where each filament has its own tool. Null when the sizes are one.
 */
export function nozzleKind(cfg: Record<string, unknown>): 'map' | 'tools' | null {
  if (!sizesDiffer(cfg)) return null
  return mapExtruders(cfg) === 2 ? 'map' : 'tools'
}

/** "0.4 mm", as the interface writes a size. */
export function mmText(d: number): string {
  return `${Math.round(d * 1000) / 1000} mm`
}

/** A nozzle's name with its size: "Left nozzle, 0.4 mm", "Tool 2, 0.6 mm". */
export function nozzleLabel(cfg: Record<string, unknown>, extruder: number): string {
  const d = nozzleSizes(cfg)[extruder - 1]
  const name = mapExtruders(cfg) === 2 ? (extruder === 1 ? 'Left nozzle' : 'Right nozzle') : `Tool ${extruder}`
  return d === undefined ? name : `${name}, ${mmText(d)}`
}

/** The plate's map as the slice sends it, for `slots` filaments: its own, else the shown one (last pick, else master). */
export function plateMap(s: Pick<AppState, 'slice'>, meta: Pick<PlateMeta, 'settings'> | undefined, cfg: Record<string, unknown>, slots: number): number[] {
  return currentMap(meta, pickedMap(s), Math.max(1, slots), masterExtruder(cfg))
}

/** The extruder (1-based) that prints engine filament `slot`, as the engine picks it. */
export function extruderOfSlot(cfg: Record<string, unknown>, map: readonly number[], slot: number): number {
  const n = nozzleSizes(cfg).length
  if (mapExtruders(cfg) === 2) return map[slot - 1] ?? masterExtruder(cfg)
  return Math.min(Math.max(1, slot), Math.max(1, n))
}

/**
 * The engine filaments an object prints with: each part's filament after the object's own picks, and its color paint,
 * after the plate's swaps.
 */
export function objectSlots(meta: Pick<PlateMeta, 'settings'> | undefined, entry: Pick<PlateEntry, 'slotOverrides' | 'handle' | 'paint'>): number[] {
  const own = entry.handle.parts.map((part) => effectiveSlot(entry, part))
  const painted = Object.values(entry.paint ?? {}).flatMap((p) => Object.values(p?.color ?? {}).flatMap(paintStates))
  return [...new Set([...own, ...painted].map((slot) => mapSlot(meta, slot)))].sort((a, b) => a - b)
}

/** Whether the object has color paint on any part. */
function painted(entry: Pick<PlateEntry, 'paint'>): boolean {
  return Object.values(entry.paint ?? {}).some((p) => Object.keys(p?.color ?? {}).length > 0)
}

/**
 * The painted objects whose filaments would print on two nozzles once filaments `moving` go to `nozzle` on the plate's
 * map `map`: moving a filament its paint uses splits it from its other filaments. Their names, in plate order.
 */
function paintSplit(s: AppState, meta: PlateMeta | undefined, cfg: Record<string, unknown>, map: readonly number[], moving: readonly number[], nozzle: number): string[] {
  const after = [...map]
  for (const f of moving) after[f - 1] = nozzle
  return s.plate
    .filter((p) => p.printable !== false && painted(p))
    .filter((p) => {
      const used = objectSlots(meta, p)
      return used.some((f) => moving.includes(f)) && new Set(used.map((f) => extruderOfSlot(cfg, after, f))).size > 1
    })
    .map((p) => p.name)
}

export type ObjectNozzle = { extruder: number; mm: number } | { conflict: string }

/**
 * The nozzle an object prints with on a printer whose nozzles differ in size, or null where they are one size. An
 * object whose parts go to nozzles of two sizes gets the engine's refusal instead.
 */
export function objectNozzle(s: AppState, entry: PlateEntry, cfg: Record<string, unknown> = resolveConfig(s.easy, s.overrides) as Record<string, unknown>): ObjectNozzle | null {
  if (!nozzleKind(cfg)) return null
  const meta = activeMeta(s)
  const sizes = nozzleSizes(cfg)
  const map = plateMap(s, meta, cfg, resolveSlots(s).length)
  const used = objectSlots(meta, entry).map((slot) => extruderOfSlot(cfg, map, slot))
  const first = used[0] ?? 1
  const other = used.find((e) => !same(sizes[e - 1] ?? 0, sizes[first - 1] ?? 0))
  if (other !== undefined) {
    return { conflict: `${entry.name} prints on nozzles of two sizes (${mmText(sizes[first - 1]!)} and ${mmText(sizes[other - 1]!)}); an object prints with one nozzle size, so give its parts filaments on nozzles of one size` }
  }
  return { extruder: first, mm: sizes[first - 1] ?? sizes[0] ?? 0 }
}

/** The other printable objects on the plate that print engine filament `slot`. */
function sharers(s: AppState, meta: PlateMeta | undefined, objectId: string, slot: number): PlateEntry[] {
  return s.plate.filter((p) => p.id !== objectId && p.printable !== false && objectSlots(meta, p).includes(slot))
}

/** The object's own slot (before the plate's swaps) that the engine reads as `engine`. */
function ownSlotFor(meta: PlateMeta | undefined, engine: number): number {
  const map = meta?.settings.slotMap
  if (!map) return engine
  const from = Object.entries(map).find(([, to]) => to === engine)?.[0]
  return from !== undefined ? Number(from) : engine
}

function moveObjectTo(meta: PlateMeta | undefined, entry: PlateEntry, engineSlot: number): void {
  const own = ownSlotFor(meta, engineSlot)
  for (const part of entry.handle.parts) setPartSlot(entry.id, part.name, own)
}

export interface NozzlePick {
  /** An existing filament (1-based) to print the object with; it must print on that nozzle. */
  filament?: number | undefined
  /** Give the object a new filament, a copy of its own, on that nozzle, when its filament also prints other objects. */
  newFilament?: boolean | undefined
  /** Move the object's filament, and every object printed with it, to that nozzle. */
  moveFilament?: boolean | undefined
  /** With moveFilament: go ahead when a painted object's paint would print on another nozzle than its other filaments. */
  confirmPainted?: boolean | undefined
}

export type NozzlePickResult =
  | { ok: true; filament: number; extruder: number; added?: number; paintSplit?: string[] }
  | { ok: false; reason: 'no_object' | 'one_size' | 'no_nozzle' | 'split' | 'filament' | 'full' | 'painted'; message: string; sharedWith?: string[]; painted?: string[] }

/**
 * Prints object `objectId` with nozzle `nozzle` (1-based extruder or tool). Tool changers: the object moves to the
 * filament on that tool (or `pick.filament`). Two extruders: the plate's map sends the object's filament to that
 * nozzle; when the filament also prints another object the pick is refused unless it names a filament or asks for a
 * new one, since one filament prints on one nozzle.
 */
export function setObjectNozzle(objectId: string, nozzle: number, pick: NozzlePick = {}): NozzlePickResult {
  const s = get()
  const entry = s.plate.find((p) => p.id === objectId || p.name === objectId)
  if (!entry) return { ok: false, reason: 'no_object', message: `No object ${objectId} on the plate.` }
  const cfg = resolveConfig(s.easy, s.overrides) as Record<string, unknown>
  const kind = nozzleKind(cfg)
  const sizes = nozzleSizes(cfg)
  if (!kind) return { ok: false, reason: 'one_size', message: 'This printer has one nozzle size, so every object prints with it.' }
  if (!Number.isInteger(nozzle) || nozzle < 1 || nozzle > sizes.length) return { ok: false, reason: 'no_nozzle', message: `Nozzle ${nozzle} does not exist: the printer has nozzles 1 to ${sizes.length}.` }
  const meta = activeMeta(s)
  const slots = resolveSlots(s)
  const map = plateMap(s, meta, cfg, slots.length)
  if ([pick.filament !== undefined, pick.newFilament === true, pick.moveFilament === true].filter(Boolean).length > 1) return { ok: false, reason: 'filament', message: 'Send one of filament (an existing filament to move to), new_filament or move_filament, not several.' }
  if (pick.filament !== undefined) {
    const f = pick.filament
    if (!Number.isInteger(f) || f < 1 || f > slots.length) return { ok: false, reason: 'filament', message: `No filament ${f}: the project has filaments 1 to ${slots.length}.` }
    if (kind === 'tools' && extruderOfSlot(cfg, map, f) !== nozzle) return { ok: false, reason: 'filament', message: `Filament ${f} prints on tool ${extruderOfSlot(cfg, map, f)}, not tool ${nozzle}. On this printer filament n prints on tool n, so send filament ${nozzle}.` }
    if (kind === 'map' && extruderOfSlot(cfg, map, f) !== nozzle) {
      const others = sharers(s, meta, entry.id, f)
      if (others.length) return { ok: false, reason: 'split', sharedWith: others.map((o) => o.name), message: `Filament ${f} prints ${others.map((o) => o.name).join(', ')} on the other nozzle, and one filament prints on one nozzle. Send new_filament: true to give ${entry.name} a filament of its own, or a filament that prints on nozzle ${nozzle}.` }
      setSlotNozzle(meta!.id, f, nozzle, map)
    }
    moveObjectTo(meta, entry, f)
    return { ok: true, filament: f, extruder: nozzle }
  }
  const own = objectSlots(meta, entry)
  if (kind === 'tools') {
    if (pick.newFilament || pick.moveFilament) return { ok: false, reason: 'filament', message: `On this printer filament n prints on tool n, so tool ${nozzle} prints filament ${nozzle}; new_filament and move_filament apply to printers with two extruders and a filament map. Send the nozzle alone.` }
    const f = Math.min(nozzle, MAX_SLOTS)
    moveObjectTo(meta, entry, f)
    return { ok: true, filament: f, extruder: nozzle }
  }
  // Two extruders: move the object's filament on the map, or give it a filament of its own.
  const moving = own.filter((f) => extruderOfSlot(cfg, map, f) !== nozzle)
  if (moving.length === 0) return { ok: true, filament: own[0] ?? 1, extruder: nozzle }
  const shared = [...new Set(moving.flatMap((f) => sharers(s, meta, entry.id, f)))]
  if (shared.length && !pick.newFilament && !pick.moveFilament) {
    const names = shared.map((o) => o.name)
    return { ok: false, reason: 'split', sharedWith: names, message: `Filament ${moving.join(', ')} also prints ${names.join(', ')}, and one filament prints on one nozzle. Send new_filament: true to give ${entry.name} a filament of its own on nozzle ${nozzle}, move_filament: true to move the filament with ${names.join(', ')}, or filament with a filament that prints on nozzle ${nozzle}.` }
  }
  if (shared.length && pick.newFilament) {
    if (own.length !== 1) return { ok: false, reason: 'filament', message: `${entry.name} prints with filaments ${own.join(', ')}; new_filament gives one filament to an object that prints with one. Send filament instead.` }
    const added = slots.length + 1
    if (added > MAX_SLOTS) return { ok: false, reason: 'full', message: `A project holds ${MAX_SLOTS} filaments at most, so ${entry.name} cannot have one of its own.` }
    const src = slots[own[0]! - 1]
    setSlot(added, src ? { type: src.type, brand: src.brand, color: src.color, ...(src.family ? { family: src.family } : {}), ...(src.vendor ? { vendor: src.vendor } : {}) } : {})
    const grown = [...map]
    while (grown.length < added) grown.push(masterExtruder(cfg))
    setSlotNozzle(meta!.id, added, nozzle, grown)
    moveObjectTo(meta, entry, added)
    return { ok: true, filament: added, extruder: nozzle, added }
  }
  const split = paintSplit(s, meta, cfg, map, moving, nozzle)
  if (split.length && !pick.confirmPainted) {
    return { ok: false, reason: 'painted', painted: split, message: `Moving filament ${moving.join(', ')} to nozzle ${nozzle} puts the paint of ${split.join(', ')} on another nozzle than ${split.length === 1 ? 'its' : 'their'} other filaments. Send confirm_painted: true with move_filament to move it anyway, or new_filament: true to give ${entry.name} a filament of its own.` }
  }
  let next = [...map]
  for (const f of moving) {
    setSlotNozzle(meta!.id, f, nozzle, next)
    next = [...(activeMeta(get())?.settings.nozzleMap ?? next)]
  }
  return { ok: true, filament: own[0] ?? 1, extruder: nozzle, ...(split.length ? { paintSplit: split } : {}) }
}

/** One nozzle an object can pick: the filament it would print with there, and the objects that share that filament. */
export interface NozzleChoice {
  extruder: number
  mm: number
  label: string
  /** The object prints with this nozzle now. */
  current: boolean
  /** The filament the object prints with on this nozzle. */
  filament: number
  /**
   * The filaments this nozzle prints now, as its menu row names them: the object's own on its nozzle; on another nozzle
   * the plate's printed filaments the map sends there, or on a tool changer the tool's own filament. Empty when none.
   */
  onNozzle: number[]
  /** Other objects on the object's filament; moving it there moves them too, unless the object gets a filament of its own. */
  sharedWith: string[]
  /** Painted objects that moving the object's filament to this nozzle would print on two nozzles. */
  paintSplit: string[]
}

/** What the object's nozzle menu offers, one entry per nozzle; empty on printers whose nozzles are one size. */
export function nozzleChoices(s: AppState, entry: PlateEntry, cfg: Record<string, unknown> = resolveConfig(s.easy, s.overrides) as Record<string, unknown>): NozzleChoice[] {
  const kind = nozzleKind(cfg)
  if (!kind) return []
  const meta = activeMeta(s)
  const count = resolveSlots(s).length
  const map = plateMap(s, meta, cfg, count)
  const own = objectSlots(meta, entry)
  const now = objectNozzle(s, entry, cfg)
  const printed = [...new Set(s.plate.filter((p) => p.printable !== false).flatMap((p) => objectSlots(meta, p)))].sort((a, b) => a - b)
  return nozzleSizes(cfg).map((mm, i) => {
    const extruder = i + 1
    const current = now !== null && 'extruder' in now && now.extruder === extruder
    // A tool changer's tool n holds filament n whether or not anything prints it yet; the map's nozzles hold what it sends.
    const onNozzle = current ? own.filter((f) => extruderOfSlot(cfg, map, f) === extruder) : kind === 'tools' ? (extruder <= count ? [extruder] : []) : printed.filter((f) => extruderOfSlot(cfg, map, f) === extruder)
    const moving = kind === 'map' ? own.filter((f) => extruderOfSlot(cfg, map, f) !== extruder) : []
    const sharedWith = [...new Set(moving.flatMap((f) => sharers(s, meta, entry.id, f).map((o) => o.name)))]
    const split = moving.length ? paintSplit(s, meta, cfg, map, moving, extruder) : []
    return { extruder, mm, label: nozzleLabel(cfg, extruder), current, filament: kind === 'tools' ? Math.min(extruder, MAX_SLOTS) : (own[0] ?? 1), onNozzle, sharedWith, paintSplit: split }
  })
}

/** The object's nozzle in short, for its chip: "0.6 R", "0.4 L" or, on a tool changer, "0.6 T2". */
export function nozzleChipText(cfg: Record<string, unknown>, extruder: number, mm: number): string {
  const side = mapExtruders(cfg) === 2 ? (extruder === 1 ? 'L' : 'R') : `T${extruder}`
  return `${Math.round(mm * 1000) / 1000} ${side}`
}

/**
 * The engine settings a plate adds on a printer whose nozzles differ in size. A two-extruder printer always sends its
 * map by hand (the plate's own, else the one shown, read back as seeded), because each object's nozzle must be known
 * before it is sliced. Each line width and the layer height go as one entry per extruder: the plate's value for the
 * first nozzle (the person's change included) and each other nozzle's own preset value (`lists`, the profile layer's).
 * With a prime tower (`tower`) the plate prints at one layer height, the first nozzle's. Same sizes: none.
 */
export function mixedNozzleConfig(s: AppState, meta: PlateMeta | undefined, cfg: Record<string, unknown>, tower: boolean, lists: Readonly<Record<string, readonly unknown[]>> | undefined = profileNozzleValues()): Record<string, unknown> {
  if (!nozzleKind(cfg)) return {}
  const out: Record<string, unknown> = {}
  if (mapExtruders(cfg) === 2 && !meta?.settings.nozzleMap?.length) {
    out['filament_map_mode'] = 'Manual'
    out['filament_map'] = plateMap(s, meta, cfg, resolveSlots(s).length)
  }
  const n = nozzleSizes(cfg).length
  for (const [key, each] of Object.entries(lists ?? {})) {
    if (each.length !== n || (tower && key === 'layer_height')) continue
    const own = cfg[key]
    out[key] = [Array.isArray(own) ? own[0] : (own ?? each[0]), ...each.slice(1)]
  }
  return out
}

/** Where the plate's map comes from: set by hand, the slicer's pick, or seeded (the shown map, sent by hand). */
export function mapSource(s: Pick<AppState, 'slice'>, meta: Pick<PlateMeta, 'settings'> | undefined, cfg: Record<string, unknown>): 'manual' | 'auto' | 'seeded' {
  if (meta?.settings.nozzleMap?.length) return 'manual'
  return nozzleKind(cfg) === 'map' ? 'seeded' : 'auto'
}
