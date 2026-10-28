// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The filament keys a slice carries: calibrated values per slot and, for a multi-color plate, the colors and the
// flush matrix. Only a slice, an export or a check needs them, so they load apart from the startup shell.
import type { SettingValue } from '@slicerx/contracts'
import { resolveConfig } from '../adapters/config'
import { flushPlanFor, slotSettings } from '@slicerx/settings/slot-settings'
import { defaultConfig } from '@slicerx/settings/defaults'
import { tunedValues, tuneContext } from '../calibration/tuned'
import { areaOrigin } from '../plate/bed-origin'
import { plateTower } from '../plate/tower'
import type { AppState } from '../state/store'
import { resolveSlots, type ResolvedSlot } from './slots'

/** What the flush matrix needs from the configuration the slice will use (flushPlanFor in @slicerx/settings). */
export function flushPlan(
  s: Pick<AppState, 'easy' | 'overrides' | 'printerNozzleVolume' | 'flush'>,
  slots: number,
): { mins: number[]; dataset: number; multiplier: number; nozzles: { mins: number[]; dataset: number }[] } {
  return flushPlanFor(resolveConfig(s.easy, s.overrides) as Record<string, SettingValue>, slots, s.flush, s.printerNozzleVolume)
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
export function slotConfig(s: AppState, plateId: string = s.activePlate): Record<string, SettingValue> {
  const slots = resolveSlots(s)
  const top = slots.reduce((n, r) => (r.used ? Math.max(n, r.index) : n), 0)
  const tuned = tunedFilamentConfig(s, slots.slice(0, Math.max(1, top)))
  if (top < 2) return tuned
  const list = slots.slice(0, top)
  // The plate's own tower: an opened project keeps one spot per plate.
  const tower = plateTower(s, plateId)
  const cfg = resolveConfig(s.easy, s.overrides) as Record<string, SettingValue>
  return { ...tuned, ...slotSettings({ cfg, list, flush: s.flush, nozzleVolume: s.printerNozzleVolume, projectFlush: s.projectFlush, tower, origin: areaOrigin(cfg['printable_area']) }) }
}
