// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The filament keys a slice carries: calibrated values per slot and, for a multi-color plate, the colors and the
// flush matrix. Only a slice, an export or a check needs them, so they load apart from the startup shell.
import type { SettingValue } from '@slicerx/contracts'
import { resolveConfig } from '../adapters/config'
import { extruderCount, flushInputs, flushValues, FLUSH_DEFAULTS, printerMinFlush, variantIndex } from './flush'
import { keptFlush } from './project-kept'
import { defaultConfig } from '@slicerx/settings/defaults'
import { tunedValues, tuneContext } from '../calibration/tuned'
import { areaOrigin } from '../plate/bed-origin'
import type { AppState } from '../state/store'
import { resolveSlots, type ResolvedSlot } from './slots'

/**
 * What the flush matrix needs from the configuration the slice will use (Plater.cpp get_min_flush_volumes): per slot
 * the minimum added to its row, the printer's flush data set, and the multiplier (the person's when changed, else the printer's).
 */
export function flushPlan(
  s: Pick<AppState, 'easy' | 'overrides' | 'printerNozzleVolume' | 'flush'>,
  slots: number,
): { mins: number[]; dataset: number; multiplier: number; nozzles: { mins: number[]; dataset: number }[] } {
  const cfg = resolveConfig(s.easy, s.overrides) as Record<string, SettingValue>
  // A printer without a profile layer has no nozzle volume of its own; the sidebar reads it from the printer's base settings.
  const withVolume = printerMinFlush(cfg['nozzle_volume']) ? cfg : { ...cfg, nozzle_volume: [s.printerNozzleVolume] as SettingValue }
  // One matrix per nozzle, each from that nozzle's own data set and minimums (Plater.cpp auto_calc_flushing_volumes loops the extruders).
  const nozzles = Array.from({ length: extruderCount(withVolume) }, (_, e) => {
    const r = flushInputs(withVolume, slots, variantIndex(withVolume, e))
    return { mins: r.mins, dataset: r.printer.dataset }
  })
  const { mins, dataset } = nozzles[0]!
  const own = Number(Array.isArray(cfg['flush_multiplier']) ? cfg['flush_multiplier'][0] : cfg['flush_multiplier'])
  const multiplier = s.flush.multiplier !== FLUSH_DEFAULTS.multiplier ? s.flush.multiplier : Number.isFinite(own) && own > 0 ? own : s.flush.multiplier
  return { mins, dataset, multiplier, nozzles }
}

/**
 * Calibrated filament values per slot. Each slot gets the values tuned for its own spool on this printer and
 * nozzle; a slot never tuned here keeps the profile's value. Returns one entry per slot for every key any slot has.
 */
export function tunedFilamentConfig(s: AppState, list: readonly ResolvedSlot[]): Record<string, SettingValue> {
  const { printerId, nozzleMm } = tuneContext(s)
  const per = list.map((r) => tunedValues(s.userPresets, r, printerId, nozzleMm))
  const keys = new Set(per.flatMap((p) => Object.keys(p)))
  if (!keys.size) return {}
  const cfg = resolveConfig(s.easy, s.overrides) as Record<string, SettingValue | undefined>
  const first = (v: SettingValue | undefined): SettingValue | undefined => (Array.isArray(v) ? (v[0] as SettingValue | undefined) : v)
  const out: Record<string, SettingValue> = {}
  const defaults = defaultConfig('filament')
  for (const k of keys) {
    // A slot never tuned for this key takes the profile's value, else the schema default, never another spool's value.
    const base = cfg[k] ?? (defaults[k] as SettingValue | undefined)
    out[k] = list.map((_, i) => {
      const own = per[i]![k]
      if (own !== undefined) return first(own)
      const b = Array.isArray(base) ? (base[i] ?? base[0]) : base
      return b ?? first(defaults[k] as SettingValue | undefined)
    }) as SettingValue
  }
  return out
}

/**
 * The filament keys a multi-color slice carries: one entry per slot up to the highest one used, plus
 * the flush matrix. Single-color plates send nothing, so they slice exactly as before.
 */
export function slotConfig(s: AppState): Record<string, SettingValue> {
  const slots = resolveSlots(s)
  const top = slots.reduce((n, r) => (r.used ? Math.max(n, r.index) : n), 0)
  const tuned = tunedFilamentConfig(s, slots.slice(0, Math.max(1, top)))
  if (top < 2) return tuned
  const list = slots.slice(0, top)
  const plan = flushPlan(s, top)
  // an opened project's own matrix while its slots are as the file has them
  const kept = s.projectFlush ? keptFlush(s.projectFlush, list.map((r) => ({ color: r.color, type: r.type })), plan.nozzles.length) : null
  // A hand placed tower is a plate spot; the engine reads wipe_tower_x and wipe_tower_y on the machine.
  const [ox, oy] = s.tower.auto ? [0, 0] : areaOrigin(resolveConfig(s.easy, s.overrides)['printable_area'])
  return {
    ...tuned,
    filament_colour: list.map((r) => r.color),
    filament_type: list.map((r) => r.type),
    filament_vendor: list.map((r) => r.brand || '(Undefined)'),
    // One n by n block per nozzle, in nozzle order (Orca's get_flush_volumes_matrix reads block extruder_id).
    flush_volumes_matrix: kept ?? plan.nozzles.flatMap((z) => flushValues(list.map((r) => r.color), s.flush, z.mins, z.dataset)),
    flush_multiplier: kept && s.projectFlush ? s.projectFlush.multiplier : plan.multiplier,
    // The engine picks the tower's spot unless the person placed it.
    prime_tower_auto_position: s.tower.auto,
    ...(s.tower.auto ? {} : { wipe_tower_x: s.tower.x + ox, wipe_tower_y: s.tower.y + oy }),
  }
}
