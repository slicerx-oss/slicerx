// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The filament keys a multi-color slice carries: per slot the colors, types and vendors, the flush matrix (an opened
// project's own while its slots are as the file has them) and the plate's tower spot. The app's slot config and the
// MCP server's project slices build them here, so a project's plate slices the same in both.
import type { SettingValue } from '@slicerx/contracts/settings'
import { extruderCount, flushInputs, flushValues, FLUSH_DEFAULTS, printerMinFlush, variantIndex } from './flush'
import type { FlushSettings } from './flush-defaults'
import { settingDef } from './schema'

/** The flush volumes a project was saved with, and the filaments they were worked out for. */
export interface ProjectFlush {
  slots: { color: string; type: string }[]
  /** Filaments in the file; the matrix holds one n by n block per nozzle. */
  n: number
  matrix: number[]
  multiplier: SettingValue
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[;,]/) : [])
/** Entry `index` of a per-plate list, or the one value every plate shares; NaN when the list has no such entry. */
const entryAt = (v: unknown, index: number): number => Number(Array.isArray(v) ? (index < v.length ? v[index] : NaN) : v)

/** The file's flush matrix, multiplier and filaments, or null when it has no whole matrix for them. */
export function projectFlushFrom(settings: Record<string, unknown>): ProjectFlush | null {
  const colors = list(settings['filament_colour'])
  const types = list(settings['filament_type'])
  const matrix = list(settings['flush_volumes_matrix']).map(Number)
  const n = colors.length
  if (n < 2 || matrix.length === 0 || matrix.length % (n * n) !== 0 || matrix.some((v) => !Number.isFinite(v))) return null
  // one multiplier per nozzle, as Bambu Studio writes it, or one for all
  const raw = settings['flush_multiplier']
  const values = (Array.isArray(raw) ? raw : [raw]).map(Number)
  const ok = values.length > 0 && values.every((v) => Number.isFinite(v) && v > 0)
  const multiplier: SettingValue = !ok ? 1 : Array.isArray(raw) ? (values as unknown as SettingValue) : values[0]!
  return { slots: colors.map((c, i) => ({ color: c.toLowerCase(), type: types[i] ?? '' })), n, matrix, multiplier }
}

/**
 * The file's matrix cut to the slots a slice uses, one block per nozzle, while those slots hold the filaments it was
 * saved for. Null once a slot's color or type changed, or when the file has another number of nozzles.
 */
export function keptFlush(f: ProjectFlush, slots: readonly { color: string; type: string }[], nozzles: number): number[] | null {
  if (slots.length > f.n || f.matrix.length !== nozzles * f.n * f.n) return null
  const same = slots.every((s, i) => s.color.toLowerCase() === f.slots[i]?.color && s.type === f.slots[i]?.type)
  if (!same) return null
  const k = slots.length
  const out: number[] = []
  for (let b = 0; b < nozzles; b++) for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) out.push(f.matrix[b * f.n * f.n + i * f.n + j]!)
  return out
}

/** A filament maker's name as a file may give it: one short line of letters, digits, spaces and plain punctuation. */
const VENDOR = /^[\p{L}\p{N} ._&+()'/-]{1,64}$/u

/**
 * The maker of each of a project file's filaments (`filament_vendor`), by slot: '' for a slot it names none for, for
 * "(Undefined)" and for text that is no maker's name. The slice sends a slot's own as it is while the slot holds the
 * file's filament.
 */
export function projectSlotVendors(settings: Record<string, unknown>): string[] {
  const raw = settings['filament_vendor']
  const all = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  return all.map((v) => (typeof v === 'string' ? v.trim() : '')).map((v) => (v !== '(Undefined)' && VENDOR.test(v) ? v : ''))
}

/**
 * The filament type of each of a project file's filaments (`filament_type`, a list or one `;` separated text), by slot:
 * '' for a slot it names none for. The app's project open and the MCP server's give a slot the person has not set the
 * file's type, and PLA where the file names none.
 */
export function projectSlotTypes(settings: Record<string, unknown>): string[] {
  const raw = settings['filament_type']
  const all: unknown[] = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.trim() ? raw.split(';') : []
  return all.map((t) => (typeof t === 'string' ? t.trim() : ''))
}

/**
 * A tower coordinate in mm as the file and the engine give it: only the floating point noise of moving it between the
 * plate's and the printer's corner is taken off (a millionth of a millimeter), so 211.626 stays 211.626.
 */
export const towerMm = (v: number): number => Math.round(v * 1e6) / 1e6

/**
 * A plate's tower front left corner on the plate from the file's wipe_tower_x and wipe_tower_y (printer coordinates):
 * Bambu Studio and Orca keep one entry per plate, and entry `index` is the plate's. Null when the file has no spot for it.
 */
export function projectTowerFrom(settings: Record<string, unknown>, origin: readonly [number, number], index = 0): { x: number; y: number } | null {
  const x = entryAt(settings['wipe_tower_x'], index)
  const y = entryAt(settings['wipe_tower_y'], index)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: towerMm(x - origin[0]), y: towerMm(y - origin[1]) }
}

/**
 * Which entry of the per-plate lists each of a project's plates reads, by the plates' numbers in the file's order: the
 * plate's place, when the plates are numbered 1, 2, 3 in that order (or a lone plate has no number), so place and
 * number agree, as the engine reads them for sx slice. Otherwise which entry is whose is not certain, and no plate
 * gets one (null): the engine places those towers.
 */
export function plateTowerIndexes(plateNos: readonly (number | undefined)[]): (number | null)[] {
  const sure = (plateNos.length === 1 && plateNos[0] === undefined) || plateNos.every((n, i) => n === i + 1)
  return plateNos.map((_, i) => (sure ? i : null))
}


// The slot colors live apart (slot-colors.ts) so the startup shell can read them without this module and the flush code.
export { defaultSlotColors, isHex, normalizeColor, objectPaletteColors } from './slot-colors'

/**
 * What the flush matrix needs from the configuration the slice will use (Plater.cpp get_min_flush_volumes): per slot
 * the minimum added to its row, the printer's flush data set, and the multiplier (the person's when changed, else the
 * printer's). `nozzleVolume` stands in for a printer without a nozzle volume of its own.
 */
export function flushPlanFor(cfg: Record<string, SettingValue | undefined>, slots: number, flush: FlushSettings, nozzleVolume: number): { mins: number[]; dataset: number; multiplier: number; nozzles: { mins: number[]; dataset: number }[] } {
  // A printer without a profile layer has no nozzle volume of its own; the sidebar reads it from the printer's base settings.
  const withVolume = printerMinFlush(cfg['nozzle_volume']) ? cfg : { ...cfg, nozzle_volume: [nozzleVolume] as SettingValue }
  // One matrix per nozzle, each from that nozzle's own data set and minimums (Plater.cpp auto_calc_flushing_volumes loops the extruders).
  const nozzles = Array.from({ length: extruderCount(withVolume) }, (_, e) => {
    const r = flushInputs(withVolume, slots, variantIndex(withVolume, e))
    return { mins: r.mins, dataset: r.printer.dataset }
  })
  const { mins, dataset } = nozzles[0]!
  const own = Number(Array.isArray(cfg['flush_multiplier']) ? cfg['flush_multiplier'][0] : cfg['flush_multiplier'])
  const multiplier = flush.multiplier !== FLUSH_DEFAULTS.multiplier ? flush.multiplier : Number.isFinite(own) && own > 0 ? own : flush.multiplier
  return { mins, dataset, multiplier, nozzles }
}

/** One filament slot of a plate, as the slot list resolves it. */
export interface PlateSlot {
  color: string
  type: string
  /** The brand, empty when none is known. */
  brand: string
}

export interface SlotSettingsInput {
  /** The configuration the slice uses, before these keys. */
  cfg: Record<string, SettingValue | undefined>
  /** The slots up to the last one the plate uses. */
  list: readonly PlateSlot[]
  flush: FlushSettings
  /** The nozzle volume for a printer without its own. */
  nozzleVolume: number
  /** An opened project's flush matrix, null without one. */
  projectFlush: ProjectFlush | null
  /** The plate's tower: auto, or a spot on the plate. */
  tower: { auto: boolean; x: number; y: number }
  /** The printable area's front left corner on the machine. */
  origin: readonly [number, number]
}

/** The keys a plate of two or more filaments slices with, from `slotSettings`'s inputs. */
export function slotSettings(i: SlotSettingsInput): Record<string, SettingValue> {
  const { list, tower } = i
  const plan = flushPlanFor(i.cfg, list.length, i.flush, i.nozzleVolume)
  // an opened project's own matrix while its slots are as the file has them
  const kept = i.projectFlush ? keptFlush(i.projectFlush, list.map((r) => ({ color: r.color, type: r.type })), plan.nozzles.length) : null
  // A hand placed tower is a plate spot; the engine reads wipe_tower_x and wipe_tower_y on the machine.
  const [ox, oy] = tower.auto ? [0, 0] : i.origin
  return {
    filament_colour: list.map((r) => r.color),
    filament_type: list.map((r) => r.type),
    filament_vendor: list.map((r) => r.brand || '(Undefined)'),
    // One n by n block per nozzle, in nozzle order (Orca's get_flush_volumes_matrix reads block extruder_id).
    flush_volumes_matrix: kept ?? plan.nozzles.flatMap((z) => flushValues(list.map((r) => r.color), i.flush, z.mins, z.dataset)),
    flush_multiplier: kept && i.projectFlush ? i.projectFlush.multiplier : plan.multiplier,
    // The engine picks the tower's spot unless the person placed it.
    prime_tower_auto_position: tower.auto,
    ...(tower.auto ? {} : { wipe_tower_x: towerMm(tower.x + ox), wipe_tower_y: towerMm(tower.y + oy) }),
  }
}

/** Project keys with one entry per filament beside the filament settings: colors, makers, preset ids and names. */
const FILAMENT_PROJECT_LISTS = new Set(['filament_colour', 'filament_type', 'filament_vendor', 'filament_ids', 'filament_settings_id'])

/** Whether a project's settings (project_settings.config) keep `key` as one entry per filament. */
export function isFilamentList(key: string): boolean {
  return FILAMENT_PROJECT_LISTS.has(key) || settingDef(key)?.section === 'filament'
}

/**
 * Settings as a project file keeps them (in its text form), with every per-filament list (`isFilamentList`) at `count` entries,
 * so a reader that takes the lists together by index finds each filament in all of them. A missing entry comes from
 * `own(key, index, list, settings)` when that gives one, else from the list's last entry, which is the value the
 * engine slices a filament past the end of a list with. A value given once becomes a list; entries past `count` are
 * dropped, and an empty list (a filament override no filament sets) stays empty. The filament map lists and the flush
 * matrix are not per-filament lists here: their writers size them from the filaments.
 */
export function evenFilamentLists(
  settings: Readonly<Record<string, unknown>>,
  count: number,
  own?: (key: string, index: number, list: readonly unknown[], settings: Readonly<Record<string, unknown>>) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...settings }
  if (count < 1) return out
  const set = (v: unknown): boolean => v !== undefined && v !== null
  for (const [key, value] of Object.entries(settings)) {
    if (!isFilamentList(key) || !set(value) || (Array.isArray(value) && !value.some(set))) continue
    const given: unknown[] = Array.isArray(value) ? value.slice(0, count) : [value]
    const list = [...given]
    let last = given.findLast(set)
    for (let i = 0; i < count; i++) {
      if (set(list[i])) {
        last = list[i]
        continue
      }
      const mine = own?.(key, i, given, settings)
      list[i] = set(mine) ? mine : last
    }
    out[key] = list
  }
  return out
}
