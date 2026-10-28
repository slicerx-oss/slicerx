// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The filament keys a multi-color slice carries: per slot the colors, types and vendors, the flush matrix (an opened
// project's own while its slots are as the file has them) and the plate's tower spot. The app's slot config and the
// MCP server's project slices build them here, so a project's plate slices the same in both.
import type { SettingValue } from '@slicerx/contracts/settings'
import { extruderCount, flushInputs, flushValues, FLUSH_DEFAULTS, printerMinFlush, variantIndex } from './flush'
import type { FlushSettings } from './flush-defaults'

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

/**
 * A plate's tower front left corner on the plate from the file's wipe_tower_x and wipe_tower_y (printer coordinates):
 * Bambu Studio and Orca keep one entry per plate, and entry `index` is the plate's. Null when the file has no spot for it.
 */
export function projectTowerFrom(settings: Record<string, unknown>, origin: readonly [number, number], index = 0): { x: number; y: number } | null {
  const x = entryAt(settings['wipe_tower_x'], index)
  const y = entryAt(settings['wipe_tower_y'], index)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: Math.round((x - origin[0]) * 10) / 10, y: Math.round((y - origin[1]) * 10) / 10 }
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
    ...(tower.auto ? {} : { wipe_tower_x: tower.x + ox, wipe_tower_y: tower.y + oy }),
  }
}
